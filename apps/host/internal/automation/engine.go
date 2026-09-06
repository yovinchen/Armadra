package automation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"math"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

func dispatchHash(run *pb.AutomationRun) []byte {
	frozen := &pb.AutomationRun{Id: run.Id, PlanId: run.PlanId, WorkspaceId: run.WorkspaceId, ConfigVersion: run.ConfigVersion, ScheduledSlot: run.ScheduledSlot, ScheduledAtUnixMs: run.ScheduledAtUnixMs, FrozenConfig: run.FrozenConfig, Activation: run.Activation, OperationId: run.OperationId, Misfire: run.Misfire, MissedSlots: run.MissedSlots, MissedSlotsTruncated: run.MissedSlotsTruncated}
	wire, _ := (proto.MarshalOptions{Deterministic: true}).Marshal(frozen)
	sum := sha256.Sum256(wire)
	return sum[:]
}
func (e *Engine) validActivation(plan *pb.AutomationPlan, a *pb.AutomationActivation) bool {
	digest, err := configHash(plan.Config)
	clone := proto.Clone(a).(*pb.AutomationActivation)
	clone.ActivationSha256 = nil
	clone.AuthorizedAtUnixMs = 0
	wire, _ := (proto.MarshalOptions{Deterministic: true}).Marshal(clone)
	sum := sha256.Sum256(wire)
	return err == nil && a.Enabled && a.HostId == e.store.HostID() && a.PlanId == plan.Id && a.ConfigVersion == plan.ConfigVersion && bytes.Equal(a.ConfigSha256, digest) && bytes.Equal(sum[:], a.ActivationSha256) && bytes.Equal(plan.ActivationSha256, a.ActivationSha256)
}
func (e *Engine) validRun(run *pb.AutomationRun) bool {
	return run.FrozenConfig != nil && run.FrozenConfig.Target != nil && run.Activation != nil && run.Activation.HostId == e.store.HostID() && run.Activation.PlanId == run.PlanId && run.Activation.ConfigVersion == run.ConfigVersion && run.FrozenConfig.WorkspaceId == run.WorkspaceId && bytes.Equal(dispatchHash(run), run.RequestSha256)
}

// Run belongs to the Host lifetime context, never an individual page/request.
// Run uses Go's monotonic timer waits. Durable UTC slots/high-water marks are
// authoritative after restart and prevent replay when wall time moves backward.
func (e *Engine) Run(ctx context.Context) error {
	ticker := time.NewTicker(e.poll)
	defer ticker.Stop()
	for {
		if err := e.Tick(ctx); err != nil && !errors.Is(err, storage.ErrConflict) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
func (e *Engine) Tick(ctx context.Context) error {
	select {
	case e.tickGate <- struct{}{}:
		defer func() { <-e.tickGate }()
	case <-ctx.Done():
		return ctx.Err()
	}
	after := ""
	for {
		page, err := e.store.List(ctx, storage.ListOptions{Kind: indexKind, AfterID: after, Limit: 100})
		if err != nil {
			return err
		}
		for _, entity := range page.Entities {
			ref := new(pb.AutomationPlanRef)
			if proto.Unmarshal(entity.Payload, ref) != nil || ref.PlanId != entity.ID {
				return storage.ErrCorrupt
			}
			if err = e.tickPlan(ctx, ref); err != nil && !errors.Is(err, storage.ErrConflict) {
				return err
			}
		}
		if !page.HasMore {
			return nil
		}
		after = page.NextID
	}
}
func (e *Engine) tickPlan(ctx context.Context, ref *pb.AutomationPlanRef) error {
	snapshot, err := e.GetPlan(ctx, ref.WorkspaceId, ref.PlanId)
	if err != nil {
		return err
	}
	now, err := e.now()
	if err != nil {
		return err
	}
	if snapshot.Plan.Config.ExpiresAtUnixMs > 0 && now >= snapshot.Plan.Config.ExpiresAtUnixMs && snapshot.Plan.State != Expired {
		if err = e.expire(ctx, snapshot, now); err != nil {
			return err
		}
	}
	snapshot, err = e.GetPlan(ctx, ref.WorkspaceId, ref.PlanId)
	if err != nil {
		return err
	}
	if snapshot.Plan.PendingRunId != "" {
		pending, err := e.GetRun(ctx, ref.WorkspaceId, snapshot.Plan.PendingRunId)
		if err != nil {
			return err
		}
		if preDispatch(pending.Run.State) && now >= pending.Run.WaitingExpiresAtUnixMs {
			if err = e.finish(ctx, pending, RunExpired, "WAITING_EXPIRED", now, nil); err != nil {
				return err
			}
			snapshot, err = e.GetPlan(ctx, ref.WorkspaceId, ref.PlanId)
			if err != nil {
				return err
			}
		}
	}
	if snapshot.Plan.ActiveRunId != "" {
		if err = e.advance(ctx, ref.WorkspaceId, snapshot.Plan.ActiveRunId); err != nil {
			return err
		}
	}
	snapshot, err = e.GetPlan(ctx, ref.WorkspaceId, ref.PlanId)
	if err != nil {
		return err
	}
	now, err = e.now()
	if err != nil {
		return err
	}
	if snapshot.Plan.State == Active && snapshot.Plan.Config.ExpiresAtUnixMs > 0 && now >= snapshot.Plan.Config.ExpiresAtUnixMs {
		return e.expire(ctx, snapshot, now)
	}
	scheduleNow := e.intervalNow(snapshot.Plan, now)
	if snapshot.Plan.State == Active && snapshot.Plan.NextDueUnixMs > 0 && snapshot.Plan.NextDueUnixMs <= scheduleNow && scheduleNow >= snapshot.Plan.ObservedThroughUnixMs {
		if err = e.materialize(ctx, snapshot, now, scheduleNow); err != nil {
			return err
		}
	}
	snapshot, err = e.GetPlan(ctx, ref.WorkspaceId, ref.PlanId)
	if err != nil {
		return err
	}
	if snapshot.Plan.State == Active && snapshot.Plan.ActiveRunId == "" && snapshot.Plan.PendingRunId != "" {
		runID := snapshot.Plan.PendingRunId
		claimed, err := e.claim(ctx, snapshot, now)
		if err != nil {
			return err
		}
		if claimed {
			return e.advance(ctx, ref.WorkspaceId, runID)
		}
	}
	return nil
}
func (e *Engine) expire(ctx context.Context, snapshot PlanSnapshot, now int64) error {
	updates, err := e.cancelUndelivered(ctx, snapshot, now, "PLAN_EXPIRED")
	if err != nil {
		return err
	}
	for _, u := range updates {
		if run, ok := u.value.(*pb.AutomationRun); ok {
			run.State = RunExpired
		}
	}
	snapshot.Plan.State = Expired
	snapshot.Plan.NextDueUnixMs = 0
	snapshot.Plan.UpdatedAtUnixMs = max(now, snapshot.Plan.UpdatedAtUnixMs)
	activation, rev, err := e.activation(ctx, snapshot.Plan.Config.WorkspaceId, snapshot.Plan.Id)
	if err != nil {
		return err
	}
	activation.Enabled = false
	updates = append(updates, update{entityKey(snapshot.Plan.Config.WorkspaceId, planKind, snapshot.Plan.Id), snapshot.Revision, snapshot.Plan}, update{entityKey(snapshot.Plan.Config.WorkspaceId, activationKind, snapshot.Plan.Id), rev, activation})
	return e.commit(ctx, "host", "expire", updates...)
}
func (e *Engine) materialize(ctx context.Context, snapshot PlanSnapshot, now, scheduleNow int64) error {
	plan := snapshot.Plan
	c := plan.Config
	if c.MaxRuns > 0 && plan.RunCount >= c.MaxRuns {
		plan.NextDueUnixMs = 0
		if plan.ActiveRunId == "" && plan.PendingRunId == "" {
			plan.State = Expired
		}
		return e.commit(ctx, "host", "run-limit", update{entityKey(c.WorkspaceId, planKind, plan.Id), snapshot.Revision, plan})
	}
	activation, _, err := e.activation(ctx, c.WorkspaceId, plan.Id)
	if err != nil {
		return err
	}
	if !e.validActivation(plan, activation) {
		return ErrAuthorization
	}
	w, err := window(plan, scheduleNow)
	if err != nil {
		return err
	}
	runID := hashText(plan.Id, fmt.Sprint(plan.ConfigVersion), w.slot)
	existing := new(pb.AutomationRun)
	existingRev, err := e.optional(ctx, entityKey(c.WorkspaceId, runKind, runID), existing)
	if err != nil {
		return err
	}
	plan.NextDueUnixMs = w.next
	plan.ObservedThroughUnixMs = max(scheduleNow, plan.ObservedThroughUnixMs)
	plan.UpdatedAtUnixMs = max(now, plan.UpdatedAtUnixMs)
	if existingRev != 0 {
		if existing.Id != runID || existing.PlanId != plan.Id || existing.WorkspaceId != c.WorkspaceId || existing.ConfigVersion != plan.ConfigVersion || existing.ScheduledSlot != w.slot {
			return storage.ErrCorrupt
		}
		return e.commit(ctx, "host", "advance-duplicate-slot", update{entityKey(c.WorkspaceId, planKind, plan.Id), snapshot.Revision, plan})
	}
	run := &pb.AutomationRun{Id: runID, PlanId: plan.Id, WorkspaceId: c.WorkspaceId, ConfigVersion: plan.ConfigVersion, ScheduledSlot: w.slot, ScheduledAtUnixMs: w.at, Misfire: w.misfire, MissedSlots: w.count, MissedSlotsTruncated: w.truncated, FrozenConfig: proto.Clone(c).(*pb.AutomationPlanConfig), Activation: proto.Clone(activation).(*pb.AutomationActivation), State: Due, CreatedAtUnixMs: now, UpdatedAtUnixMs: now, WaitingExpiresAtUnixMs: now + c.BusyTtlMs}
	run.OperationId = "automation/" + activation.PrincipalId + "/host-" + e.store.HostID() + "/" + c.WorkspaceId + "/dispatch/" + runID
	if w.misfire && c.MisfirePolicy == Skip {
		run.State = Skipped
		run.ReasonCode = "MISFIRE_SKIPPED"
		if c.Schedule.GetOnce() != nil {
			run.State = RunExpired
			run.ReasonCode = "ONCE_EXPIRED"
		}
	}
	if run.State == Due && ((c.ConcurrencyPolicy == Forbid && plan.ActiveRunId != "") || plan.PendingRunId != "") {
		run.State = Skipped
		run.ReasonCode = "CONCURRENCY_LIMIT"
	}
	if run.State == Due {
		if plan.RunCount == math.MaxInt64 {
			return storage.ErrCounterExhausted
		}
		plan.RunCount++
		plan.PendingRunId = runID
	} else {
		run.CompletedAtUnixMs = now
		if c.Schedule.GetOnce() != nil {
			plan.State = Expired
		}
		if c.Schedule.GetLoopAfterCompletion() != nil {
			plan.State = Paused
		}
	}
	run.RequestSha256 = dispatchHash(run)
	// The history row is written in the same transaction as the run: an index
	// that could lag behind the runs would page past history that exists.
	return e.commit(ctx, "host", "materialize-slot", update{entityKey(c.WorkspaceId, planKind, plan.Id), snapshot.Revision, plan}, update{entityKey(c.WorkspaceId, runKind, runID), 0, run}, update{entityKey("", operationKind, hashText(run.OperationId)), 0, &pb.AutomationRunRef{RunId: runID, PlanId: plan.Id, WorkspaceId: c.WorkspaceId}}, historyEntry(run))
}
func (e *Engine) claim(ctx context.Context, snapshot PlanSnapshot, now int64) (bool, error) {
	plan := snapshot.Plan
	run, err := e.GetRun(ctx, plan.Config.WorkspaceId, plan.PendingRunId)
	if err != nil {
		return false, err
	}
	if !e.validRun(run.Run) || !preDispatch(run.Run.State) {
		return false, storage.ErrCorrupt
	}
	if now >= run.Run.WaitingExpiresAtUnixMs {
		return false, e.finish(ctx, run, RunExpired, "WAITING_EXPIRED", now, nil)
	}
	if run.Run.ConfigVersion != plan.ConfigVersion || !bytes.Equal(run.Run.Activation.ActivationSha256, plan.ActivationSha256) {
		return false, e.finish(ctx, run, Cancelled, "STALE_ACTIVATION", now, nil)
	}
	gate, rev, err := e.gate(ctx, run.Run.FrozenConfig.Target)
	if err != nil {
		return false, err
	}
	if gate.Active != nil {
		if run.Run.State == Waiting {
			return false, nil
		}
		run.Run.State = Waiting
		run.Run.ReasonCode = "TARGET_GATE_BUSY"
		run.Run.UpdatedAtUnixMs = now
		return false, e.commit(ctx, "host", "wait-target-gate", update{entityKey(run.Run.WorkspaceId, runKind, run.Run.Id), run.Revision, run.Run})
	}
	gate.Active = &pb.AutomationRunRef{RunId: run.Run.Id, PlanId: plan.Id, WorkspaceId: plan.Config.WorkspaceId}
	run.Run.State = Claimed
	run.Run.ClaimOwner = e.instance
	run.Run.LeaseUntilUnixMs = now + e.lease.Milliseconds()
	run.Run.UpdatedAtUnixMs = now
	plan.ActiveRunId = run.Run.Id
	plan.PendingRunId = ""
	err = e.commit(ctx, "host", "claim-target", update{entityKey(plan.Config.WorkspaceId, planKind, plan.Id), snapshot.Revision, plan}, update{entityKey(run.Run.WorkspaceId, runKind, run.Run.Id), run.Revision, run.Run}, update{targetKey(run.Run.FrozenConfig.Target), rev, gate})
	return err == nil, err
}

func (e *Engine) advance(ctx context.Context, workspace, runID string) error {
	run, err := e.GetRun(ctx, workspace, runID)
	if err != nil {
		return err
	}
	if terminal(run.Run.State) {
		return nil
	}
	if !e.validRun(run.Run) {
		return storage.ErrCorrupt
	}
	now, err := e.now()
	if err != nil {
		return err
	}
	if run.Run.ClaimOwner != e.instance && run.Run.LeaseUntilUnixMs > now {
		return nil
	}
	// An in-flight dispatcher owns this boundary until its lease ends, even if
	// another Engine instance accidentally reused the same configured owner ID.
	if run.Run.State == Dispatching && run.Run.LeaseUntilUnixMs > now {
		return nil
	}
	if run.Run.ClaimOwner != e.instance || run.Run.LeaseUntilUnixMs <= now+e.lease.Milliseconds()/2 {
		run.Run.ClaimOwner = e.instance
		run.Run.LeaseUntilUnixMs = now + e.lease.Milliseconds()
		run.Run.UpdatedAtUnixMs = max(now, run.Run.UpdatedAtUnixMs)
		if err = e.commit(ctx, "host", "renew-claim", update{entityKey(workspace, runKind, runID), run.Revision, run.Run}); err != nil {
			return err
		}
		run.Revision++
	}
	if !preDispatch(run.Run.State) {
		lookup, cancel := context.WithTimeout(ctx, e.dispatchTimeout)
		receipt, lookupErr := e.dispatcher.Lookup(lookup, proto.Clone(run.Run).(*pb.AutomationRun))
		cancel()
		if lookupErr != nil || receipt == nil {
			return e.markUnknown(ctx, run, "LOOKUP_UNAVAILABLE")
		}
		return e.receive(ctx, run, receipt)
	}
	if now < run.Run.NextAttemptUnixMs {
		return nil
	}
	plan, err := e.GetPlan(ctx, workspace, run.Run.PlanId)
	if err != nil {
		return err
	}
	activation, _, err := e.activation(ctx, workspace, plan.Plan.Id)
	if err != nil {
		return err
	}
	if plan.Plan.ActiveRunId != runID {
		return nil
	}
	if plan.Plan.State != Active || run.Run.ConfigVersion != plan.Plan.ConfigVersion || !e.validActivation(plan.Plan, activation) || !bytes.Equal(run.Run.Activation.ActivationSha256, activation.ActivationSha256) {
		return e.finish(ctx, run, Cancelled, "STALE_ACTIVATION", now, nil)
	}
	if now >= run.Run.WaitingExpiresAtUnixMs {
		return e.finish(ctx, run, RunExpired, "WAITING_EXPIRED", now, nil)
	}
	auth := Authorization{PrincipalID: activation.PrincipalId, AuthorizationID: activation.AuthorizationId}
	if err = e.verify(ctx, auth, run.Run.FrozenConfig); err != nil {
		return e.invalidate(ctx, plan, now)
	}
	check, cancel := context.WithTimeout(ctx, e.dispatchTimeout)
	status, supportErr := e.dispatcher.Supports(check, proto.Clone(run.Run.FrozenConfig.Target).(*pb.AutomationTarget))
	cancel()
	if supportErr != nil || status.State == TargetBusy || status.State == TargetUnknown {
		if run.Run.State == Waiting {
			return nil
		}
		run.Run.State = Waiting
		run.Run.ReasonCode = "TARGET_NOT_IDLE"
		return e.commit(ctx, "host", "wait-idle", update{entityKey(workspace, runKind, runID), run.Revision, run.Run})
	}
	if status.State == TargetOffline {
		return e.finish(ctx, run, Skipped, "TARGET_OFFLINE", now, nil)
	}
	if status.State == TargetUnsupported {
		return e.finish(ctx, run, Skipped, "TARGET_UNSUPPORTED", now, nil)
	}
	// A command target is pinned to the exact generation the plan froze: a
	// different one is a different process and must not be written to.
	//
	// An agent target cannot be, and pretending otherwise would be worse than
	// useless. The Runtime owns that session's lifetime — a person restarting
	// the Agent, or an authorized cold start, legitimately replaces it — so
	// identity there is the node plus the frozen agent definition, both
	// re-checked by the executor at the write itself, and the receipt records
	// the generation actually written to. The frozen number stays in the run
	// history as what the plan was defined against.
	if status.State != TargetReady || (generationPinned(run.Run.FrozenConfig.Target) && status.Generation != run.Run.FrozenConfig.Target.Generation) {
		return e.finish(ctx, run, Skipped, "STALE_GENERATION", now, nil)
	}
	// Re-read after the capability/authorization calls. Pause/update may have
	// cancelled this queue item while those calls were waiting.
	latest, err := e.GetPlan(ctx, workspace, plan.Plan.Id)
	if err != nil {
		return err
	}
	fresh, err := e.GetRun(ctx, workspace, runID)
	if err != nil {
		return err
	}
	if latest.Plan.State != Active || latest.Plan.ActiveRunId != runID || latest.Plan.ConfigVersion != run.Run.ConfigVersion || !bytes.Equal(latest.Plan.ActivationSha256, run.Run.Activation.ActivationSha256) || fresh.Revision != run.Revision || !preDispatch(fresh.Run.State) || fresh.Run.ClaimOwner != e.instance {
		return nil
	}
	if err = e.verify(ctx, auth, fresh.Run.FrozenConfig); err != nil {
		return e.invalidate(ctx, latest, now)
	}
	now, err = e.now()
	if err != nil {
		return err
	}
	if latest.Plan.Config.ExpiresAtUnixMs > 0 && now >= latest.Plan.Config.ExpiresAtUnixMs {
		return e.expire(ctx, latest, now)
	}
	if now >= fresh.Run.LeaseUntilUnixMs || now >= fresh.Run.WaitingExpiresAtUnixMs {
		return nil
	}
	fresh.Run.State = Dispatching
	fresh.Run.DispatchAttempts++
	fresh.Run.UpdatedAtUnixMs = max(now, fresh.Run.UpdatedAtUnixMs)
	// A no-op plan write is an intentional CAS fence against pause/edit between
	// the last read and committing DISPATCHING. Past this point it is in-flight.
	if err = e.commit(ctx, "host", "begin-dispatch", update{entityKey(workspace, runKind, runID), fresh.Revision, fresh.Run}, update{entityKey(workspace, planKind, latest.Plan.Id), latest.Revision, latest.Plan}); err != nil {
		return err
	}
	fresh.Revision++
	budget := e.dispatchTimeout
	if expiry := fresh.Run.FrozenConfig.ExpiresAtUnixMs; expiry > 0 && expiry-now < budget.Milliseconds() {
		budget = time.Duration(expiry-now) * time.Millisecond
	}
	dispatch, cancel := context.WithTimeout(ctx, budget)
	receipt, dispatchErr := e.dispatcher.Dispatch(dispatch, proto.Clone(fresh.Run).(*pb.AutomationRun))
	cancel()
	if dispatchErr != nil || receipt == nil {
		return e.markUnknown(ctx, fresh, "DISPATCH_OUTCOME_UNKNOWN")
	}
	return e.receive(ctx, fresh, receipt)
}

func (e *Engine) receive(ctx context.Context, run RunSnapshot, receipt *pb.AutomationReceipt) error {
	err := e.applyReceipt(ctx, run, receipt)
	if errors.Is(err, ErrReceipt) {
		return e.markUnknown(ctx, run, "INVALID_RECEIPT")
	}
	return err
}
func (e *Engine) invalidate(ctx context.Context, snapshot PlanSnapshot, now int64) error {
	updates, err := e.cancelUndelivered(ctx, snapshot, now, "AUTHORIZATION_REVOKED")
	if err != nil {
		return err
	}
	activation, rev, err := e.activation(ctx, snapshot.Plan.Config.WorkspaceId, snapshot.Plan.Id)
	if err != nil {
		return err
	}
	activation.Enabled = false
	snapshot.Plan.State = Draft
	snapshot.Plan.ActivationSha256 = nil
	snapshot.Plan.NextDueUnixMs = 0
	updates = append(updates, update{entityKey(snapshot.Plan.Config.WorkspaceId, planKind, snapshot.Plan.Id), snapshot.Revision, snapshot.Plan}, update{entityKey(snapshot.Plan.Config.WorkspaceId, activationKind, snapshot.Plan.Id), rev, activation})
	return e.commit(ctx, "host", "invalidate-authorization", updates...)
}
