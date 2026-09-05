package automation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"math"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// Define also handles updates via an exact entity revision. Every configuration
// edit increments config_version and returns to draft, cancelling old queued
// delivery. The disabled activation record retains the sole owner's identity.
func (e *Engine) Define(ctx context.Context, auth Authorization, id string, config *pb.AutomationPlanConfig, expectedRevision uint64) (PlanSnapshot, error) {
	if !validID(id) {
		return PlanSnapshot{}, ErrInvalid
	}
	normalized, err := normalize(config)
	if err != nil {
		return PlanSnapshot{}, err
	}
	if err = e.verify(ctx, auth, normalized); err != nil {
		return PlanSnapshot{}, err
	}
	now, err := e.now()
	if err != nil {
		return PlanSnapshot{}, err
	}
	var snapshot PlanSnapshot
	var activation *pb.AutomationActivation
	var activationRev uint64
	updates := []update{}
	if expectedRevision == 0 {
		snapshot = PlanSnapshot{Plan: &pb.AutomationPlan{Id: id, ConfigVersion: 1, Config: normalized, CreatedAtUnixMs: now}}
		activation = &pb.AutomationActivation{PlanId: id, HostId: e.store.HostID(), PrincipalId: auth.PrincipalID}
		updates = append(updates, update{entityKey("", indexKind, id), 0, &pb.AutomationPlanRef{PlanId: id, WorkspaceId: normalized.WorkspaceId}})
	} else {
		snapshot, err = e.GetPlan(ctx, normalized.WorkspaceId, id)
		if err != nil {
			return PlanSnapshot{}, err
		}
		if snapshot.Revision != expectedRevision {
			return PlanSnapshot{}, storage.ErrConflict
		}
		activation, activationRev, err = e.activation(ctx, normalized.WorkspaceId, id)
		if err != nil {
			return PlanSnapshot{}, err
		}
		if activation.PrincipalId != auth.PrincipalID {
			return PlanSnapshot{}, ErrAuthorization
		}
		if snapshot.Plan.ConfigVersion == math.MaxInt64 {
			return PlanSnapshot{}, storage.ErrCounterExhausted
		}
		updates, err = e.cancelUndelivered(ctx, snapshot, now, "CONFIGURATION_CHANGED")
		if err != nil {
			return PlanSnapshot{}, err
		}
		snapshot.Plan.ConfigVersion++
		snapshot.Plan.Config = normalized
		snapshot.Plan.RunCount = 0
	}
	plan := snapshot.Plan
	if plan.State == pb.AutomationPlanState_AUTOMATION_PLAN_STATE_DELETED {
		return PlanSnapshot{}, ErrInvalid
	}
	plan.State = Draft
	plan.NextDueUnixMs = 0
	plan.ActivationSha256 = nil
	// An edit is the repair action for a refused target, so the old streak must
	// not keep flagging a plan whose target the user just replaced.
	plan.NeedsAttention = false
	plan.AttentionReasonCode = ""
	plan.AttentionStreak = 0
	plan.UpdatedAtUnixMs = max(now, plan.UpdatedAtUnixMs)
	activation.Enabled = false
	activation.ConfigVersion = plan.ConfigVersion
	activation.AuthorizationId = auth.AuthorizationID
	activation.ConfigSha256, err = configHash(normalized)
	if err != nil {
		return PlanSnapshot{}, err
	}
	activation.ActivationSha256 = nil
	updates = append(updates, update{entityKey(normalized.WorkspaceId, planKind, id), expectedRevision, plan}, update{entityKey(normalized.WorkspaceId, activationKind, id), activationRev, activation})
	if err = e.commit(ctx, auth.PrincipalID, "define", updates...); err != nil {
		return PlanSnapshot{}, err
	}
	snapshot.Revision = expectedRevision + 1
	return snapshot, nil
}

func (e *Engine) Activate(ctx context.Context, auth Authorization, workspace, id string, expectedRevision, configVersion uint64, expectedHash []byte) (PlanSnapshot, error) {
	snapshot, err := e.GetPlan(ctx, workspace, id)
	if err != nil {
		return PlanSnapshot{}, err
	}
	plan := snapshot.Plan
	if plan.State == Expired || plan.State == pb.AutomationPlanState_AUTOMATION_PLAN_STATE_DELETED {
		return PlanSnapshot{}, ErrInvalid
	}
	digest, err := configHash(plan.Config)
	if err != nil {
		return PlanSnapshot{}, err
	}
	if snapshot.Revision != expectedRevision || plan.ConfigVersion != configVersion || !bytes.Equal(expectedHash, digest) {
		return PlanSnapshot{}, storage.ErrConflict
	}
	activation, activationRev, err := e.activation(ctx, workspace, id)
	if err != nil {
		return PlanSnapshot{}, err
	}
	if activation.PrincipalId != auth.PrincipalID {
		return PlanSnapshot{}, ErrAuthorization
	}
	if err = e.verify(ctx, auth, plan.Config); err != nil {
		return PlanSnapshot{}, err
	}
	now, err := e.now()
	if err != nil {
		return PlanSnapshot{}, err
	}
	if plan.Config.ExpiresAtUnixMs != 0 && now >= plan.Config.ExpiresAtUnixMs || plan.Config.MaxRuns != 0 && plan.RunCount >= plan.Config.MaxRuns {
		return PlanSnapshot{}, ErrInvalid
	}
	check, cancel := context.WithTimeout(ctx, e.dispatchTimeout)
	status, err := e.dispatcher.Supports(check, proto.Clone(plan.Config.Target).(*pb.AutomationTarget))
	cancel()
	if err != nil || status.State == TargetUnsupported {
		return PlanSnapshot{}, ErrUnsupported
	}
	if plan.State == Active && activation.Enabled && activation.AuthorizationId == auth.AuthorizationID && e.validActivation(plan, activation) {
		return snapshot, nil
	}
	activation = &pb.AutomationActivation{PlanId: id, ConfigVersion: configVersion, ConfigSha256: digest, HostId: e.store.HostID(), PrincipalId: auth.PrincipalID, AuthorizationId: auth.AuthorizationID, AuthorizedAtUnixMs: now, Enabled: true}
	hashed := proto.Clone(activation).(*pb.AutomationActivation)
	hashed.AuthorizedAtUnixMs = 0
	wire, _ := (proto.MarshalOptions{Deterministic: true}).Marshal(hashed)
	sum := sha256.Sum256(wire)
	activation.ActivationSha256 = sum[:]
	plan.ActivationSha256 = append([]byte(nil), sum[:]...)
	plan.State = Active
	plan.UpdatedAtUnixMs = max(now, plan.UpdatedAtUnixMs)
	plan.NextDueUnixMs, err = firstDue(plan.Config, max(now, plan.ObservedThroughUnixMs))
	if err != nil {
		return PlanSnapshot{}, err
	}
	if plan.Config.Schedule.GetLoopAfterCompletion() != nil && plan.ActiveRunId != "" {
		plan.NextDueUnixMs = 0
	}
	if err = e.commit(ctx, auth.PrincipalID, "activate", update{entityKey(workspace, planKind, id), snapshot.Revision, plan}, update{entityKey(workspace, activationKind, id), activationRev, activation}); err != nil {
		return PlanSnapshot{}, err
	}
	e.resetIntervalClock(plan, max(now, plan.ObservedThroughUnixMs))
	snapshot.Revision++
	return snapshot, nil
}

func (e *Engine) Pause(ctx context.Context, auth Authorization, workspace, id string, expectedRevision uint64) (PlanSnapshot, error) {
	snapshot, err := e.GetPlan(ctx, workspace, id)
	if err != nil {
		return PlanSnapshot{}, err
	}
	if snapshot.Plan.State != Active && snapshot.Plan.State != Paused {
		return PlanSnapshot{}, ErrInvalid
	}
	if snapshot.Revision != expectedRevision {
		return PlanSnapshot{}, storage.ErrConflict
	}
	activation, rev, err := e.activation(ctx, workspace, id)
	if err != nil {
		return PlanSnapshot{}, err
	}
	if activation.PrincipalId != auth.PrincipalID {
		return PlanSnapshot{}, ErrAuthorization
	}
	if err = e.verify(ctx, auth, snapshot.Plan.Config); err != nil {
		return PlanSnapshot{}, err
	}
	now, err := e.now()
	if err != nil {
		return PlanSnapshot{}, err
	}
	updates, err := e.cancelUndelivered(ctx, snapshot, now, "PLAN_PAUSED")
	if err != nil {
		return PlanSnapshot{}, err
	}
	snapshot.Plan.State = Paused
	snapshot.Plan.NextDueUnixMs = 0
	snapshot.Plan.UpdatedAtUnixMs = max(now, snapshot.Plan.UpdatedAtUnixMs)
	activation.Enabled = false
	updates = append(updates, update{entityKey(workspace, planKind, id), snapshot.Revision, snapshot.Plan}, update{entityKey(workspace, activationKind, id), rev, activation})
	if err = e.commit(ctx, auth.PrincipalID, "pause", updates...); err != nil {
		return PlanSnapshot{}, err
	}
	snapshot.Revision++
	return snapshot, nil
}
