package automation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"math"
	"regexp"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

var reasonPattern = regexp.MustCompile(`^[A-Z0-9_]{0,64}$`)

func outcomeState(outcome pb.AutomationOutcome) pb.AutomationRunState {
	switch outcome {
	case pb.AutomationOutcome_AUTOMATION_OUTCOME_DELIVERED:
		return Delivered
	case pb.AutomationOutcome_AUTOMATION_OUTCOME_RUNNING:
		return Running
	case pb.AutomationOutcome_AUTOMATION_OUTCOME_SUCCEEDED:
		return Succeeded
	case pb.AutomationOutcome_AUTOMATION_OUTCOME_FAILED:
		return Failed
	case pb.AutomationOutcome_AUTOMATION_OUTCOME_CANCELLED:
		return Cancelled
	case pb.AutomationOutcome_AUTOMATION_OUTCOME_UNKNOWN:
		return Unknown
	}
	return 0
}

// Observe accepts only a trusted, correlated executor event. Browser callers
// cannot manufacture successful runs by posting an unverified "done" signal.
func (e *Engine) Observe(ctx context.Context, receipt *pb.AutomationReceipt) error {
	if receipt == nil {
		return ErrReceipt
	}
	ref := new(pb.AutomationRunRef)
	_, err := e.load(ctx, entityKey("", operationKind, hashText(receipt.OperationId)), ref)
	if err != nil {
		return err
	}
	run, err := e.GetRun(ctx, ref.WorkspaceId, ref.RunId)
	if err != nil {
		return err
	}
	return e.applyReceipt(ctx, run, receipt)
}
func (e *Engine) applyReceipt(ctx context.Context, snapshot RunSnapshot, receipt *pb.AutomationReceipt) error {
	run := snapshot.Run
	if receipt == nil || !e.validRun(run) || receipt.OperationId != run.OperationId || !bytes.Equal(receipt.RequestSha256, run.RequestSha256) || receipt.Sequence == 0 || !validTime(receipt.ObservedAtUnixMs) || !reasonPattern.MatchString(receipt.ReasonCode) || run.DispatchAttempts == 0 {
		return ErrReceipt
	}
	wire, err := (proto.MarshalOptions{Deterministic: true}).Marshal(receipt)
	if err != nil {
		return ErrReceipt
	}
	digest := sha256.Sum256(wire)
	if receipt.Sequence < run.ReceiptSequence {
		return nil
	}
	if receipt.Sequence == run.ReceiptSequence {
		if bytes.Equal(digest[:], run.ReceiptSha256) {
			return nil
		}
		return ErrReceipt
	}
	state := outcomeState(receipt.Outcome)
	if terminal(run.State) {
		if state == run.State {
			return nil
		}
		return ErrReceipt
	}
	if state == 0 && receipt.Outcome != pb.AutomationOutcome_AUTOMATION_OUTCOME_NOT_DISPATCHED {
		return ErrReceipt
	}
	if run.State == Running && state == Delivered {
		return ErrReceipt
	}
	if run.State == Delivered || run.State == Running {
		run.DeliveryObserved = true
	}
	if receipt.Outcome == pb.AutomationOutcome_AUTOMATION_OUTCOME_NOT_DISPATCHED && run.DeliveryObserved {
		return ErrReceipt
	}
	if state == Delivered || state == Running || state == Succeeded {
		run.DeliveryObserved = true
	}
	run.ReceiptSequence = receipt.Sequence
	run.ReceiptSha256 = digest[:]
	now, err := e.now()
	if err != nil {
		return err
	}
	run.UpdatedAtUnixMs = max(now, run.UpdatedAtUnixMs)
	if receipt.Outcome == pb.AutomationOutcome_AUTOMATION_OUTCOME_NOT_DISPATCHED {
		if run.DispatchAttempts <= run.FrozenConfig.SafeRetryLimit {
			run.State = Claimed
			run.NextAttemptUnixMs = now + run.FrozenConfig.RetryBackoffMs
			run.ReasonCode = "NO_EFFECT_RETRY_PENDING"
			return e.commit(ctx, "host", "proven-no-effect", update{entityKey(run.WorkspaceId, runKind, run.Id), snapshot.Revision, run})
		}
		return e.finish(ctx, snapshot, Failed, "NO_EFFECT_RETRY_EXHAUSTED", receipt.ObservedAtUnixMs, receipt)
	}
	if terminal(state) {
		return e.finish(ctx, snapshot, state, receipt.ReasonCode, receipt.ObservedAtUnixMs, receipt)
	}
	run.State = state
	run.ReasonCode = receipt.ReasonCode
	return e.commit(ctx, "host", "observe", update{entityKey(run.WorkspaceId, runKind, run.Id), snapshot.Revision, run})
}
func (e *Engine) markUnknown(ctx context.Context, snapshot RunSnapshot, reason string) error {
	if snapshot.Run.State == Unknown && snapshot.Run.ReasonCode == reason {
		return nil
	}
	now, err := e.now()
	if err != nil {
		return err
	}
	if snapshot.Run.State == Delivered || snapshot.Run.State == Running {
		snapshot.Run.DeliveryObserved = true
	}
	snapshot.Run.State = Unknown
	snapshot.Run.ReasonCode = reason
	snapshot.Run.UpdatedAtUnixMs = max(now, snapshot.Run.UpdatedAtUnixMs)
	// Retain the target gate. Unknown dispatch never makes a target available.
	return e.commit(ctx, "host", "unknown-outcome", update{entityKey(snapshot.Run.WorkspaceId, runKind, snapshot.Run.Id), snapshot.Revision, snapshot.Run})
}

// AttentionThreshold is how many consecutive unrepairable target refusals
// raise a plan's needs-attention flag. One refusal can be a Worker restart in
// progress; a second one means a person has to repair or redefine the target.
const AttentionThreshold = 2

// unrepairable reports refusals that no retry or wait can fix: the Host's own
// definition says this target cannot be rebuilt, is not a command session, or
// no longer carries the generation the plan was frozen against.
func unrepairable(state pb.AutomationRunState, reason string) bool {
	return state == Skipped && (reason == "TARGET_UNSUPPORTED" || reason == "STALE_GENERATION")
}

// noteAttention folds one finished run into the plan's needs-attention state.
// Only observed delivery clears it: a cancelled, paused or expired run proves
// nothing about the target, so it must not quietly retire a real warning.
func noteAttention(plan *pb.AutomationPlan, run *pb.AutomationRun, state pb.AutomationRunState, reason string) {
	if run.DeliveryObserved {
		plan.NeedsAttention = false
		plan.AttentionReasonCode = ""
		plan.AttentionStreak = 0
		return
	}
	if !unrepairable(state, reason) {
		return
	}
	if plan.AttentionStreak < math.MaxUint32 {
		plan.AttentionStreak++
	}
	if plan.AttentionStreak >= AttentionThreshold {
		plan.NeedsAttention = true
		plan.AttentionReasonCode = reason
	}
}

func (e *Engine) finish(ctx context.Context, snapshot RunSnapshot, state pb.AutomationRunState, reason string, at int64, receipt *pb.AutomationReceipt) error {
	run := snapshot.Run
	if !terminal(state) {
		return ErrInvalid
	}
	now, clockErr := e.now()
	if clockErr != nil {
		return clockErr
	}
	plan, err := e.GetPlan(ctx, run.WorkspaceId, run.PlanId)
	if err != nil {
		return err
	}
	updates := []update{}
	wasActive := plan.Plan.ActiveRunId == run.Id
	if wasActive {
		gate, rev, err := e.gate(ctx, run.FrozenConfig.Target)
		if err != nil {
			return err
		}
		if gate.Active == nil || gate.Active.RunId != run.Id || gate.Active.WorkspaceId != run.WorkspaceId {
			return storage.ErrCorrupt
		}
		gate.Active = nil
		updates = append(updates, update{targetKey(run.FrozenConfig.Target), rev, gate})
		plan.Plan.ActiveRunId = ""
	}
	if plan.Plan.PendingRunId == run.Id {
		plan.Plan.PendingRunId = ""
	}
	run.State = state
	run.ReasonCode = reason
	run.CompletedAtUnixMs = at
	run.UpdatedAtUnixMs = max(now, at, run.UpdatedAtUnixMs)
	run.LeaseUntilUnixMs = 0
	if receipt != nil {
		wire, _ := (proto.MarshalOptions{Deterministic: true}).Marshal(receipt)
		sum := sha256.Sum256(wire)
		run.ReceiptSequence = receipt.Sequence
		run.ReceiptSha256 = sum[:]
	}
	if run.ConfigVersion == plan.Plan.ConfigVersion {
		noteAttention(plan.Plan, run, state, reason)
	}
	c := plan.Plan.Config
	if plan.Plan.State == Active && run.ConfigVersion == plan.Plan.ConfigVersion {
		if loop := c.Schedule.GetLoopAfterCompletion(); loop != nil {
			completedExecution := state == Succeeded || state == Failed && (receipt == nil || receipt.Outcome == pb.AutomationOutcome_AUTOMATION_OUTCOME_FAILED)
			if wasActive && completedExecution {
				plan.Plan.NextDueUnixMs = at + loop.DelayMs
			} else {
				plan.Plan.State = Paused
				plan.Plan.NextDueUnixMs = 0
			}
		}
		if c.Schedule.GetOnce() != nil {
			plan.Plan.State = Expired
			plan.Plan.NextDueUnixMs = 0
		}
		if (c.MaxRuns > 0 && plan.Plan.RunCount >= c.MaxRuns || c.ExpiresAtUnixMs > 0 && max(now, at) >= c.ExpiresAtUnixMs) && plan.Plan.ActiveRunId == "" && plan.Plan.PendingRunId == "" {
			plan.Plan.State = Expired
			plan.Plan.NextDueUnixMs = 0
		}
	}
	plan.Plan.UpdatedAtUnixMs = max(now, at, plan.Plan.UpdatedAtUnixMs)
	updates = append(updates, update{entityKey(run.WorkspaceId, runKind, run.Id), snapshot.Revision, run}, update{entityKey(run.WorkspaceId, planKind, run.PlanId), plan.Revision, plan.Plan})
	return e.commit(ctx, "host", "finish", updates...)
}
