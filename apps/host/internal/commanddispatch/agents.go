package commanddispatch

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/automation"
	"google.golang.org/protobuf/proto"
)

// Agent-terminal delivery. Unlike the command executor next door, this writes
// into a PTY that already exists, so the two rules that matter are:
//
//   - the write only ever happens against a target the probe just called ready,
//     which is also where a frozen cold start is allowed to run; and
//   - "we do not know whether it was typed" is never turned into a retry. Only
//     the Runtime's own NOT_WRITTEN, which is a preflight refusal, maps onto
//     the automation outcome that a safe retry is built on.

// AgentKind reports whether a target is the agent-prompt kind. An unspecified
// kind stays the command executor, so plans frozen before the field existed
// cannot silently become PTY writers.
func AgentKind(target *pb.AutomationTarget) bool {
	return target.GetKind() == pb.AutomationTargetKind_AUTOMATION_TARGET_KIND_AGENT_SESSION_PROMPT
}

func validAgentTarget(target *pb.AutomationTarget) bool {
	return AgentKind(target) && target.NodeId != "" && target.AgentLaunch != nil && target.AgentLaunch.AgentId != ""
}

func (d *Dispatcher) supportsAgent(ctx context.Context, target *pb.AutomationTarget) (automation.TargetStatus, error) {
	if !validAgentTarget(target) {
		return automation.TargetStatus{State: automation.TargetUnsupported}, nil
	}
	request := &pb.AgentTargetRequest{
		// A probe carries no workspace: the Host only holds the target here,
		// and the node's own workspace is the authority anyway. The write
		// below does carry one, and the Runtime refuses a mismatch there.
		NodeId:     target.NodeId,
		SessionId:  target.SessionId,
		Generation: target.Generation,
		Expected:   proto.Clone(target.AgentLaunch).(*pb.AgentLaunchSpec),
	}
	// A cold start is a launch, so it happens only where the plan asked for one.
	if target.ColdStartPolicy == pb.AutomationColdStartPolicy_AUTOMATION_COLD_START_POLICY_LAUNCH_FROZEN {
		request.ColdStart = proto.Clone(target.AgentLaunch).(*pb.AgentLaunchSpec)
	}
	status, err := d.client.AgentTarget(ctx, request)
	if err != nil {
		return automation.TargetStatus{State: automation.TargetUnknown}, err
	}
	switch status.State {
	case pb.AgentTargetState_AGENT_TARGET_STATE_READY:
		return automation.TargetStatus{State: automation.TargetReady, Generation: status.Generation}, nil
	case pb.AgentTargetState_AGENT_TARGET_STATE_BUSY:
		return automation.TargetStatus{State: automation.TargetBusy, Generation: status.Generation}, nil
	case pb.AgentTargetState_AGENT_TARGET_STATE_ABSENT:
		// Offline, not unsupported: the node is fine, nothing is running on it.
		// A plan that did not authorize a cold start skips instead of waiting.
		return automation.TargetStatus{State: automation.TargetOffline}, nil
	case pb.AgentTargetState_AGENT_TARGET_STATE_UNSUPPORTED:
		return automation.TargetStatus{State: automation.TargetUnsupported}, nil
	default:
		return automation.TargetStatus{State: automation.TargetUnknown}, nil
	}
}

func (d *Dispatcher) dispatchAgent(ctx context.Context, run *pb.AutomationRun) (*pb.AutomationReceipt, error) {
	config := run.FrozenConfig
	if !validAgentTarget(config.Target) {
		return nil, automation.ErrUnsupported
	}
	prompt, err := d.payloads.Resolve(ctx, run.WorkspaceId, config.PayloadRef)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(prompt)
	if !bytes.Equal(hash[:], config.PayloadSha256) {
		return nil, errors.New("automation prompt does not match its frozen hash")
	}
	// A second attempt asks what the first one did before writing anything.
	// The Runtime is idempotent by operation id, but a Host that resent without
	// looking would still be treating "unknown" as "safe".
	if run.DispatchAttempts > 1 {
		proof, lookupErr := d.client.AgentPromptLookup(ctx, run.OperationId)
		if lookupErr != nil {
			return nil, lookupErr
		}
		if proof.Phase != pb.AgentPromptPhase_AGENT_PROMPT_PHASE_NOT_WRITTEN || !proof.NoEffectProven || !bytes.Equal(proof.RequestSha256, run.RequestSha256) {
			return mapPromptReceipt(proof), nil
		}
	}
	receipt, err := d.client.AgentPrompt(ctx, &pb.AgentPromptRequest{
		OperationId:   run.OperationId,
		RequestSha256: run.RequestSha256,
		WorkspaceId:   run.WorkspaceId,
		NodeId:        config.Target.NodeId,
		SessionId:     config.Target.SessionId,
		Generation:    config.Target.Generation,
		Prompt:        prompt,
		Expected:      proto.Clone(config.Target.AgentLaunch).(*pb.AgentLaunchSpec),
	})
	if err != nil {
		return nil, err
	}
	return mapPromptReceipt(receipt), nil
}

// mapPromptReceipt turns delivery evidence into a scheduling outcome.
//
// SUBMITTED is DELIVERED and never SUCCEEDED: input reaching a buffer is not
// work being done. COMPLETED is the only success, and the Runtime only reports
// it for a turn no other input could have produced. Everything the Runtime
// could not attribute is UNKNOWN, which holds the target gate until a person
// resolves it — deliberately, because the alternative is a second paste.
func mapPromptReceipt(r *pb.AgentPromptReceipt) *pb.AutomationReceipt {
	outcome := pb.AutomationOutcome_AUTOMATION_OUTCOME_UNKNOWN
	switch r.Phase {
	case pb.AgentPromptPhase_AGENT_PROMPT_PHASE_NOT_WRITTEN:
		if r.NoEffectProven {
			outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_NOT_DISPATCHED
		}
	case pb.AgentPromptPhase_AGENT_PROMPT_PHASE_SUBMITTED:
		outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_DELIVERED
	case pb.AgentPromptPhase_AGENT_PROMPT_PHASE_COMPLETED:
		outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_SUCCEEDED
	case pb.AgentPromptPhase_AGENT_PROMPT_PHASE_ABANDONED:
		outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_FAILED
	}
	return &pb.AutomationReceipt{
		OperationId:      r.OperationId,
		RequestSha256:    append([]byte(nil), r.RequestSha256...),
		Outcome:          outcome,
		Sequence:         r.Sequence,
		ObservedAtUnixMs: r.ObservedAtUnixMs,
		ReasonCode:       r.ReasonCode,
	}
}
