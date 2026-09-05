// Package commanddispatch connects persistent scheduling to NEW, frozen
// non-interactive Worker command sessions. It never writes to an existing PTY.
package commanddispatch

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/automation"
	"armadra.local/host/internal/worker"
)

// PayloadResolver resolves immutable private content owned by a workspace.
// The adapter independently checks its hash; it never accepts browser tokens.
type PayloadResolver interface {
	Resolve(context.Context, string, string) ([]byte, error)
}
type Dispatcher struct {
	client   *worker.Client
	host     string
	payloads PayloadResolver
}

func New(client *worker.Client, payloads PayloadResolver) (*Dispatcher, error) {
	if client == nil || payloads == nil || client.Hello().GetCommands() == nil {
		return nil, automation.ErrUnsupported
	}
	return &Dispatcher{client: client, host: client.Hello().HostId, payloads: payloads}, nil
}
func (d *Dispatcher) Supports(ctx context.Context, target *pb.AutomationTarget) (automation.TargetStatus, error) {
	if target == nil || target.ExecutionHostId != d.host {
		return automation.TargetStatus{State: automation.TargetUnsupported}, nil
	}
	if AgentKind(target) {
		return d.supportsAgent(ctx, target)
	}
	session, err := d.client.GetCommandSession(ctx, target.SessionId)
	if err != nil {
		return automation.TargetStatus{State: automation.TargetUnknown}, err
	}
	status := automation.TargetStatus{State: automation.TargetReady, Generation: session.Generation}
	if session.Kind != pb.CommandSessionKind_COMMAND_SESSION_KIND_NON_INTERACTIVE_COMMAND || session.Generation != target.Generation {
		status.State = automation.TargetUnsupported
	} else if session.ActiveOperationId != "" {
		status.State = automation.TargetBusy
	}
	return status, nil
}
func (d *Dispatcher) Dispatch(ctx context.Context, run *pb.AutomationRun) (*pb.AutomationReceipt, error) {
	if run == nil || run.FrozenConfig == nil || run.FrozenConfig.Target == nil || run.FrozenConfig.Target.ExecutionHostId != d.host || len(run.RequestSha256) != 32 || run.WorkspaceId != run.FrozenConfig.WorkspaceId {
		return nil, automation.ErrInvalid
	}
	config := run.FrozenConfig
	if AgentKind(config.Target) {
		return d.dispatchAgent(ctx, run)
	}
	session, err := d.client.GetCommandSession(ctx, config.Target.SessionId)
	if err != nil {
		return nil, err
	}
	if session.WorkspaceId != run.WorkspaceId || session.Generation != config.Target.Generation || session.Kind != pb.CommandSessionKind_COMMAND_SESSION_KIND_NON_INTERACTIVE_COMMAND {
		return nil, automation.ErrUnsupported
	}
	input, err := d.payloads.Resolve(ctx, run.WorkspaceId, config.PayloadRef)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(input)
	if len(input) > int(d.client.Hello().Commands.MaxStdinBytes) || !bytes.Equal(hash[:], config.PayloadSha256) {
		return nil, errors.New("automation command payload does not match its frozen hash")
	}
	request := &pb.RunCommandRequest{OperationId: run.OperationId, RequestSha256: run.RequestSha256, SessionId: session.SessionId, ExpectedGeneration: session.Generation, Stdin: input}
	if run.DispatchAttempts > 1 {
		proof, lookupErr := d.client.LookupCommand(ctx, run.OperationId)
		if lookupErr != nil {
			return nil, lookupErr
		}
		if proof.Phase != pb.CommandPhase_COMMAND_PHASE_NOT_DISPATCHED || !proof.NoEffectProven || !proof.CleanupConfirmed || !bytes.Equal(proof.RequestSha256, run.RequestSha256) {
			return mapReceipt(proof), nil
		}
		request.ExpectedNotDispatchedSequence = proof.Sequence
	}
	receipt, err := d.client.RunCommand(ctx, request)
	if err != nil {
		return nil, err
	}
	return mapReceipt(receipt), nil
}
func (d *Dispatcher) Lookup(ctx context.Context, run *pb.AutomationRun) (*pb.AutomationReceipt, error) {
	if run == nil || run.FrozenConfig == nil {
		return nil, automation.ErrInvalid
	}
	if AgentKind(run.FrozenConfig.Target) {
		receipt, err := d.client.AgentPromptLookup(ctx, run.OperationId)
		if err != nil {
			return nil, err
		}
		return mapPromptReceipt(receipt), nil
	}
	receipt, err := d.client.LookupCommand(ctx, run.OperationId)
	if err != nil {
		return nil, err
	}
	return mapReceipt(receipt), nil
}
func mapReceipt(r *pb.CommandReceipt) *pb.AutomationReceipt {
	outcome := pb.AutomationOutcome_AUTOMATION_OUTCOME_UNKNOWN
	switch r.Phase {
	case pb.CommandPhase_COMMAND_PHASE_RUNNING:
		outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_RUNNING
	case pb.CommandPhase_COMMAND_PHASE_SUCCEEDED:
		if r.CleanupConfirmed {
			outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_SUCCEEDED
		}
	case pb.CommandPhase_COMMAND_PHASE_FAILED:
		if r.CleanupConfirmed {
			outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_FAILED
		}
	case pb.CommandPhase_COMMAND_PHASE_CANCELLED:
		if r.CleanupConfirmed {
			outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_CANCELLED
		}
	case pb.CommandPhase_COMMAND_PHASE_NOT_DISPATCHED:
		if r.CleanupConfirmed && r.NoEffectProven {
			outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_NOT_DISPATCHED
		}
	}
	return &pb.AutomationReceipt{OperationId: r.OperationId, RequestSha256: append([]byte(nil), r.RequestSha256...), Outcome: outcome, Sequence: r.Sequence, ObservedAtUnixMs: r.UpdatedAtUnixMs, ReasonCode: r.ReasonCode}
}

var _ automation.Dispatcher = (*Dispatcher)(nil)
