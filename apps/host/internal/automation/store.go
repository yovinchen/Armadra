package automation

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const (
	planKind       = "automation.plan"
	activationKind = "automation.activation"
	runKind        = "automation.run"
	indexKind      = "automation.plan-index"
	operationKind  = "automation.operation-index"
	gateKind       = "automation.target-gate"
)

func entityKey(workspace, kind, id string) storage.Key {
	return storage.Key{WorkspaceID: workspace, Kind: kind, ID: id}
}
func hashText(parts ...string) string {
	wire := ""
	for _, part := range parts {
		wire += fmt.Sprintf("%d:%s", len(part), part)
	}
	sum := sha256.Sum256([]byte(wire))
	return hex.EncodeToString(sum[:])
}
func randomID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
func configHash(config *pb.AutomationPlanConfig) ([]byte, error) {
	wire, err := (proto.MarshalOptions{Deterministic: true}).Marshal(config)
	if err != nil {
		return nil, ErrInvalid
	}
	sum := sha256.Sum256(wire)
	return sum[:], nil
}
func ConfigurationHash(config *pb.AutomationPlanConfig) ([]byte, error) {
	normalized, err := normalize(config)
	if err != nil {
		return nil, err
	}
	return configHash(normalized)
}
// AgentTarget reports the one target kind that writes into a PTY that already
// exists. An unspecified kind stays the command executor, so a plan frozen
// before the field existed cannot silently become a terminal writer.
func AgentTarget(target *pb.AutomationTarget) bool {
	return target.GetKind() == pb.AutomationTargetKind_AUTOMATION_TARGET_KIND_AGENT_SESSION_PROMPT
}

// generationPinned reports whether a dispatch requires the exact generation
// the plan froze. Only a command target does; see the note at its use site.
func generationPinned(target *pb.AutomationTarget) bool { return !AgentTarget(target) }

// What the delivery gate is keyed by. A command session is its own identity;
// an agent target is keyed by its node, because a restart or an authorized
// cold start legitimately replaces the session and a gate that followed the
// session would stop serializing two plans aimed at the same terminal.
func gateIdentity(target *pb.AutomationTarget) (session, node string) {
	if AgentTarget(target) {
		return "", target.NodeId
	}
	return target.SessionId, ""
}

func targetKey(target *pb.AutomationTarget) storage.Key {
	session, node := gateIdentity(target)
	return entityKey("", gateKind, hashText(target.ExecutionHostId, session, node))
}
func (e *Engine) load(ctx context.Context, key storage.Key, message proto.Message) (uint64, error) {
	entity, err := e.store.Read(ctx, key)
	if err != nil {
		return 0, err
	}
	if entity.Deleted {
		return 0, storage.ErrNotFound
	}
	if err := (proto.UnmarshalOptions{RecursionLimit: 32}).Unmarshal(entity.Payload, message); err != nil {
		return 0, storage.ErrCorrupt
	}
	return entity.Revision, nil
}
func (e *Engine) optional(ctx context.Context, key storage.Key, message proto.Message) (uint64, error) {
	rev, err := e.load(ctx, key, message)
	if errors.Is(err, storage.ErrNotFound) {
		return 0, nil
	}
	return rev, err
}
func change(key storage.Key, revision uint64, message proto.Message) (storage.Change, error) {
	wire, err := (proto.MarshalOptions{Deterministic: true}).Marshal(message)
	return storage.Change{Key: key, ExpectedRevision: revision, Payload: wire}, err
}

type update struct {
	key      storage.Key
	revision uint64
	value    proto.Message
}

func (e *Engine) commit(ctx context.Context, principal, action string, updates ...update) error {
	changes := make([]storage.Change, 0, len(updates))
	for _, u := range updates {
		v, err := change(u.key, u.revision, u.value)
		if err != nil {
			return err
		}
		changes = append(changes, v)
	}
	id, err := randomID()
	if err != nil {
		return err
	}
	_, err = e.store.Apply(ctx, "automation/"+principal+"/host-"+e.store.HostID()+"/"+action+"/"+id, changes)
	return err
}
func (e *Engine) now() (int64, error) {
	now := e.clock().UnixMilli()
	if !validTime(now) {
		return 0, ErrInvalid
	}
	return now, nil
}
func (e *Engine) GetPlan(ctx context.Context, workspace, id string) (PlanSnapshot, error) {
	if !validID(workspace) || !validID(id) {
		return PlanSnapshot{}, ErrInvalid
	}
	plan := new(pb.AutomationPlan)
	rev, err := e.load(ctx, entityKey(workspace, planKind, id), plan)
	if err != nil {
		return PlanSnapshot{}, err
	}
	if plan.Id != id || plan.Config == nil || plan.Config.WorkspaceId != workspace || plan.ConfigVersion == 0 {
		return PlanSnapshot{}, storage.ErrCorrupt
	}
	validated, validation := normalize(plan.Config)
	if validation != nil || !proto.Equal(validated, plan.Config) {
		return PlanSnapshot{}, storage.ErrCorrupt
	}
	return PlanSnapshot{Plan: plan, Revision: rev}, nil
}
func (e *Engine) GetRun(ctx context.Context, workspace, id string) (RunSnapshot, error) {
	run := new(pb.AutomationRun)
	rev, err := e.load(ctx, entityKey(workspace, runKind, id), run)
	if err != nil {
		return RunSnapshot{}, err
	}
	if run.Id != id || run.WorkspaceId != workspace || run.FrozenConfig == nil || run.Activation == nil {
		return RunSnapshot{}, storage.ErrCorrupt
	}
	return RunSnapshot{Run: run, Revision: rev}, nil
}
func (e *Engine) activation(ctx context.Context, workspace, id string) (*pb.AutomationActivation, uint64, error) {
	v := new(pb.AutomationActivation)
	rev, err := e.load(ctx, entityKey(workspace, activationKind, id), v)
	return v, rev, err
}
func (e *Engine) gate(ctx context.Context, target *pb.AutomationTarget) (*pb.AutomationTargetGate, uint64, error) {
	v := new(pb.AutomationTargetGate)
	session, node := gateIdentity(target)
	rev, err := e.optional(ctx, targetKey(target), v)
	if rev == 0 {
		v.ExecutionHostId = target.ExecutionHostId
		v.SessionId = session
		v.NodeId = node
	}
	if err == nil && (v.ExecutionHostId != target.ExecutionHostId || v.SessionId != session || v.NodeId != node) {
		err = storage.ErrCorrupt
	}
	return v, rev, err
}
func (e *Engine) ListRuns(ctx context.Context, workspace, planID, after string, limit int) (RunsPage, error) {
	if !validID(workspace) || !validID(planID) {
		return RunsPage{}, ErrInvalid
	}
	page, err := e.store.List(ctx, storage.ListOptions{WorkspaceID: workspace, Kind: runKind, AfterID: after, Limit: limit})
	if err != nil {
		return RunsPage{}, err
	}
	result := RunsPage{NextID: page.NextID, HasMore: page.HasMore, Runs: []RunSnapshot{}}
	for _, entity := range page.Entities {
		run := new(pb.AutomationRun)
		if err = proto.Unmarshal(entity.Payload, run); err != nil {
			return result, storage.ErrCorrupt
		}
		if run.PlanId == planID {
			result.Runs = append(result.Runs, RunSnapshot{Run: run, Revision: entity.Revision})
		}
	}
	return result, nil
}
func (e *Engine) verify(ctx context.Context, auth Authorization, config *pb.AutomationPlanConfig) error {
	if !validID(auth.PrincipalID) || !validID(auth.AuthorizationID) {
		return ErrAuthorization
	}
	check, cancel := context.WithTimeout(ctx, e.dispatchTimeout)
	defer cancel()
	if err := e.authorizer.Verify(check, auth, proto.Clone(config).(*pb.AutomationPlanConfig)); err != nil {
		return ErrAuthorization
	}
	if check.Err() != nil {
		return ErrAuthorization
	}
	return nil
}
func New(store *storage.Store, dispatcher Dispatcher, authorizer Authorizer, options Options) (*Engine, error) {
	if store == nil || dispatcher == nil || authorizer == nil {
		return nil, ErrInvalid
	}
	if options.Clock == nil {
		options.Clock = time.Now
	}
	if options.MonotonicClock == nil {
		options.MonotonicClock = time.Now
	}
	if options.InstanceID == "" {
		id, err := randomID()
		if err != nil {
			return nil, err
		}
		options.InstanceID = id
	}
	if !validID(options.InstanceID) {
		return nil, ErrInvalid
	}
	if options.ClaimLease == 0 {
		options.ClaimLease = 30 * time.Second
	}
	if options.DispatchTimeout == 0 {
		options.DispatchTimeout = 10 * time.Second
	}
	if options.PollInterval == 0 {
		options.PollInterval = time.Second
	}
	if options.ClaimLease < time.Second || options.ClaimLease > 5*time.Minute || options.DispatchTimeout <= 0 || options.DispatchTimeout >= options.ClaimLease || options.PollInterval < time.Millisecond || options.PollInterval > time.Minute {
		return nil, ErrInvalid
	}
	return &Engine{store: store, dispatcher: dispatcher, authorizer: authorizer, clock: options.Clock, monotonic: options.MonotonicClock, intervalClocks: map[string]intervalClock{}, instance: options.InstanceID, lease: options.ClaimLease, dispatchTimeout: options.DispatchTimeout, poll: options.PollInterval, tickGate: make(chan struct{}, 1)}, nil
}

// cancelUndelivered is used by pause/update before the dispatch boundary. It
// does not terminate delivered/running/unknown work or erase its ownership gate.
func (e *Engine) cancelUndelivered(ctx context.Context, snapshot PlanSnapshot, now int64, reason string) ([]update, error) {
	plan := snapshot.Plan
	updates := []update{}
	for _, id := range []string{plan.PendingRunId, plan.ActiveRunId} {
		if id == "" {
			continue
		}
		run, err := e.GetRun(ctx, plan.Config.WorkspaceId, id)
		if err != nil {
			return nil, err
		}
		if !preDispatch(run.Run.State) {
			continue
		}
		run.Run.State = Cancelled
		run.Run.ReasonCode = reason
		run.Run.CompletedAtUnixMs = now
		run.Run.UpdatedAtUnixMs = now
		run.Run.LeaseUntilUnixMs = 0
		updates = append(updates, update{entityKey(run.Run.WorkspaceId, runKind, id), run.Revision, run.Run})
		if plan.PendingRunId == id {
			plan.PendingRunId = ""
		}
		if plan.ActiveRunId == id {
			plan.ActiveRunId = ""
			gate, rev, err := e.gate(ctx, run.Run.FrozenConfig.Target)
			if err != nil {
				return nil, err
			}
			if gate.Active == nil || gate.Active.RunId != id {
				return nil, storage.ErrCorrupt
			}
			gate.Active = nil
			updates = append(updates, update{targetKey(run.Run.FrozenConfig.Target), rev, gate})
		}
	}
	return updates, nil
}
