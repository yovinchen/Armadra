package automation

import (
	"context"
	"math"
	"strconv"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// PlansPage is a durable read of stored plans, not a live scheduler view.
type PlansPage struct {
	Plans   []PlanSnapshot
	NextID  string
	HasMore bool
}

// ListPlans reads one workspace's stored plans. A caller that is only allowed
// one workspace never receives another workspace's plan by omitting a filter.
func (e *Engine) ListPlans(ctx context.Context, workspace, after string, limit int) (PlansPage, error) {
	if !validID(workspace) {
		return PlansPage{}, ErrInvalid
	}
	page, err := e.store.List(ctx, storage.ListOptions{WorkspaceID: workspace, Kind: planKind, AfterID: after, Limit: limit})
	if err != nil {
		return PlansPage{}, err
	}
	result := PlansPage{NextID: page.NextID, HasMore: page.HasMore, Plans: []PlanSnapshot{}}
	for _, entity := range page.Entities {
		plan := new(pb.AutomationPlan)
		if proto.Unmarshal(entity.Payload, plan) != nil || plan.Id != entity.ID || plan.Config == nil || plan.Config.WorkspaceId != workspace {
			return PlansPage{}, storage.ErrCorrupt
		}
		result.Plans = append(result.Plans, PlanSnapshot{Plan: plan, Revision: entity.Revision})
	}
	return result, nil
}

// RunNow materializes one additional manual slot for an already active plan.
// It does not move the schedule, reuse a scheduled slot, skip the target gate
// or bypass activation and authorization: the ordinary claim and dispatch path
// still decides whether anything is delivered.
func (e *Engine) RunNow(ctx context.Context, auth Authorization, workspace, id string, expectedRevision uint64) (RunSnapshot, error) {
	snapshot, err := e.GetPlan(ctx, workspace, id)
	if err != nil {
		return RunSnapshot{}, err
	}
	if snapshot.Revision != expectedRevision {
		return RunSnapshot{}, storage.ErrConflict
	}
	plan := snapshot.Plan
	if plan.State != Active {
		return RunSnapshot{}, ErrInvalid
	}
	activation, _, err := e.activation(ctx, workspace, id)
	if err != nil {
		return RunSnapshot{}, err
	}
	if activation.PrincipalId != auth.PrincipalID {
		return RunSnapshot{}, ErrAuthorization
	}
	if err = e.verify(ctx, auth, plan.Config); err != nil {
		return RunSnapshot{}, err
	}
	if !e.validActivation(plan, activation) {
		return RunSnapshot{}, ErrAuthorization
	}
	c := plan.Config
	now, err := e.now()
	if err != nil {
		return RunSnapshot{}, err
	}
	if c.MaxRuns > 0 && plan.RunCount >= c.MaxRuns || c.ExpiresAtUnixMs > 0 && now >= c.ExpiresAtUnixMs {
		return RunSnapshot{}, ErrInvalid
	}
	if plan.PendingRunId != "" || (c.ConcurrencyPolicy == Forbid && plan.ActiveRunId != "") {
		return RunSnapshot{}, storage.ErrConflict
	}
	if plan.RunCount == math.MaxInt64 {
		return RunSnapshot{}, storage.ErrCounterExhausted
	}
	slot := "manual:" + strconv.FormatInt(now, 10)
	runID := hashText(plan.Id, strconv.FormatUint(plan.ConfigVersion, 10), slot)
	rev, err := e.optional(ctx, entityKey(c.WorkspaceId, runKind, runID), new(pb.AutomationRun))
	if err != nil {
		return RunSnapshot{}, err
	}
	if rev != 0 {
		return RunSnapshot{}, storage.ErrConflict
	}
	run := &pb.AutomationRun{Id: runID, PlanId: plan.Id, WorkspaceId: c.WorkspaceId, ConfigVersion: plan.ConfigVersion, ScheduledSlot: slot, ScheduledAtUnixMs: now, MissedSlots: 1, FrozenConfig: proto.Clone(c).(*pb.AutomationPlanConfig), Activation: proto.Clone(activation).(*pb.AutomationActivation), State: Due, ReasonCode: "MANUAL_RUN", CreatedAtUnixMs: now, UpdatedAtUnixMs: now, WaitingExpiresAtUnixMs: now + c.BusyTtlMs}
	run.OperationId = "automation/" + activation.PrincipalId + "/host-" + e.store.HostID() + "/" + c.WorkspaceId + "/dispatch/" + runID
	run.RequestSha256 = dispatchHash(run)
	plan.RunCount++
	plan.PendingRunId = runID
	plan.UpdatedAtUnixMs = max(now, plan.UpdatedAtUnixMs)
	if err = e.commit(ctx, auth.PrincipalID, "run-now",
		update{entityKey(c.WorkspaceId, planKind, plan.Id), snapshot.Revision, plan},
		update{entityKey(c.WorkspaceId, runKind, runID), 0, run},
		update{entityKey("", operationKind, hashText(run.OperationId)), 0, &pb.AutomationRunRef{RunId: runID, PlanId: plan.Id, WorkspaceId: c.WorkspaceId}},
		historyEntry(run)); err != nil {
		return RunSnapshot{}, err
	}
	return RunSnapshot{Run: run, Revision: 1}, nil
}
