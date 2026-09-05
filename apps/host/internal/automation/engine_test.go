package automation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const testHost = "11111111111111111111111111111111"

var testAuth = Authorization{PrincipalID: "owner", AuthorizationID: "device-grant-revision-1"}

type fakeAuthorizer struct{ allowed atomic.Bool }

func (a *fakeAuthorizer) Verify(_ context.Context, auth Authorization, _ *pb.AutomationPlanConfig) error {
	if !a.allowed.Load() || auth.PrincipalID != testAuth.PrincipalID {
		return errors.New("private authorization diagnostic")
	}
	return nil
}

type fakeDispatcher struct {
	mu           sync.Mutex
	clock        *atomic.Int64
	status       TargetStatus
	outcome      pb.AutomationOutcome
	dispatched   []*pb.AutomationRun
	receipts     map[string]*pb.AutomationReceipt
	supportsHook func()
	dispatchHook func(context.Context, *pb.AutomationRun) (*pb.AutomationReceipt, error)
	lookupHook   func(context.Context, string) (*pb.AutomationReceipt, error)
}

func (d *fakeDispatcher) Supports(_ context.Context, _ *pb.AutomationTarget) (TargetStatus, error) {
	d.mu.Lock()
	hook, status := d.supportsHook, d.status
	d.mu.Unlock()
	if hook != nil {
		hook()
	}
	return status, nil
}
func (d *fakeDispatcher) Dispatch(ctx context.Context, run *pb.AutomationRun) (*pb.AutomationReceipt, error) {
	d.mu.Lock()
	d.dispatched = append(d.dispatched, proto.Clone(run).(*pb.AutomationRun))
	hook := d.dispatchHook
	outcome := d.outcome
	d.mu.Unlock()
	if hook != nil {
		return hook(ctx, run)
	}
	receipt := d.receipt(run, outcome)
	d.mu.Lock()
	d.receipts[run.OperationId] = proto.Clone(receipt).(*pb.AutomationReceipt)
	d.mu.Unlock()
	return receipt, nil
}
func (d *fakeDispatcher) Lookup(ctx context.Context, run *pb.AutomationRun) (*pb.AutomationReceipt, error) {
	operation := run.GetOperationId()
	d.mu.Lock()
	hook := d.lookupHook
	receipt := d.receipts[operation]
	if receipt != nil {
		receipt = proto.Clone(receipt).(*pb.AutomationReceipt)
	}
	d.mu.Unlock()
	if hook != nil {
		return hook(ctx, operation)
	}
	if receipt == nil {
		return nil, errors.New("journal unavailable, not proof of no effect")
	}
	return receipt, nil
}
func (d *fakeDispatcher) receipt(run *pb.AutomationRun, outcome pb.AutomationOutcome) *pb.AutomationReceipt {
	d.mu.Lock()
	sequence := uint64(1)
	if old := d.receipts[run.OperationId]; old != nil {
		sequence = old.Sequence + 1
	}
	d.mu.Unlock()
	return &pb.AutomationReceipt{OperationId: run.OperationId, RequestSha256: append([]byte(nil), run.RequestSha256...), Outcome: outcome, Sequence: sequence, ObservedAtUnixMs: d.clock.Load()}
}
func (d *fakeDispatcher) runs() []*pb.AutomationRun {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := []*pb.AutomationRun{}
	for _, r := range d.dispatched {
		out = append(out, proto.Clone(r).(*pb.AutomationRun))
	}
	return out
}

type fixture struct {
	engine     *Engine
	store      *storage.Store
	directory  string
	clock      atomic.Int64
	dispatcher *fakeDispatcher
	auth       *fakeAuthorizer
}

func setup(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{directory: t.TempDir()}
	f.clock.Store(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli())
	f.auth = &fakeAuthorizer{}
	f.auth.allowed.Store(true)
	f.dispatcher = &fakeDispatcher{clock: &f.clock, status: TargetStatus{State: TargetReady, Generation: 7}, outcome: pb.AutomationOutcome_AUTOMATION_OUTCOME_SUCCEEDED, receipts: map[string]*pb.AutomationReceipt{}}
	var err error
	f.store, err = storage.Open(f.directory, testHost)
	if err != nil {
		t.Fatal(err)
	}
	f.engine, err = New(f.store, f.dispatcher, f.auth, Options{Clock: func() time.Time { return time.UnixMilli(f.clock.Load()) }, MonotonicClock: func() time.Time { return time.UnixMilli(0) }, InstanceID: "engine-a", PollInterval: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.store.Close() })
	return f
}
func (f *fixture) config(schedule *pb.AutomationSchedule) *pb.AutomationPlanConfig {
	sum := sha256.Sum256([]byte("frozen payload"))
	return &pb.AutomationPlanConfig{WorkspaceId: "workspace", Title: "自动化", Schedule: schedule, Target: &pb.AutomationTarget{ExecutionHostId: "execution-host", SessionId: "session", Generation: 7}, PayloadRef: "payload:fixture", PayloadSha256: sum[:]}
}
func (f *fixture) once() *pb.AutomationPlanConfig {
	return f.config(&pb.AutomationSchedule{Kind: &pb.AutomationSchedule_Once{Once: &pb.AutomationOnce{AtUnixMs: f.clock.Load()}}})
}
func (f *fixture) interval() *pb.AutomationPlanConfig {
	return f.config(&pb.AutomationSchedule{Kind: &pb.AutomationSchedule_Interval{Interval: &pb.AutomationInterval{AnchorUnixMs: f.clock.Load(), IntervalMs: 1000}}})
}
func (f *fixture) activate(t *testing.T, id string, config *pb.AutomationPlanConfig) PlanSnapshot {
	t.Helper()
	snapshot, err := f.engine.Define(context.Background(), testAuth, id, config, 0)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := ConfigurationHash(snapshot.Plan.Config)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err = f.engine.Activate(context.Background(), testAuth, config.WorkspaceId, id, snapshot.Revision, snapshot.Plan.ConfigVersion, digest)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}
func (f *fixture) tick(t *testing.T) {
	t.Helper()
	if err := f.engine.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
}
func (f *fixture) plan(t *testing.T, id string) PlanSnapshot {
	t.Helper()
	v, err := f.engine.GetPlan(context.Background(), "workspace", id)
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func (f *fixture) allRuns(t *testing.T, id string) []RunSnapshot {
	t.Helper()
	v, err := f.engine.ListRuns(context.Background(), "workspace", id, "", 100)
	if err != nil {
		t.Fatal(err)
	}
	return v.Runs
}
func (f *fixture) complete(t *testing.T, run *pb.AutomationRun) *pb.AutomationReceipt {
	t.Helper()
	receipt := f.dispatcher.receipt(run, pb.AutomationOutcome_AUTOMATION_OUTCOME_SUCCEEDED)
	f.dispatcher.mu.Lock()
	f.dispatcher.receipts[run.OperationId] = proto.Clone(receipt).(*pb.AutomationReceipt)
	f.dispatcher.mu.Unlock()
	if err := f.engine.Observe(context.Background(), receipt); err != nil {
		t.Fatal(err)
	}
	return receipt
}
func eventCount(t *testing.T, store *storage.Store) uint64 {
	t.Helper()
	page, err := store.GetEvents(context.Background(), storage.EventQuery{})
	if err != nil {
		t.Fatal(err)
	}
	return page.HighWatermark
}

func TestDraftExactActivationAndConfigurationEditCancelWaiting(t *testing.T) {
	f := setup(t)
	config := f.once()
	snapshot, err := f.engine.Define(context.Background(), testAuth, "plan", config, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.tick(t)
	if len(f.dispatcher.runs()) != 0 || snapshot.Plan.State != Draft {
		t.Fatal("draft executed")
	}
	_, err = f.engine.Activate(context.Background(), testAuth, "workspace", "plan", snapshot.Revision, 1, make([]byte, 32))
	if !errors.Is(err, storage.ErrConflict) {
		t.Fatal("activation accepted a different configuration")
	}
	digest, _ := ConfigurationHash(snapshot.Plan.Config)
	f.dispatcher.status.State = TargetBusy
	snapshot, err = f.engine.Activate(context.Background(), testAuth, "workspace", "plan", snapshot.Revision, 1, digest)
	if err != nil {
		t.Fatal(err)
	}
	f.tick(t)
	old := f.plan(t, "plan")
	if old.Plan.ActiveRunId == "" {
		t.Fatal("busy target was not durably claimed/waiting")
	}
	edited := proto.Clone(old.Plan.Config).(*pb.AutomationPlanConfig)
	edited.Title = "edited"
	edited.PayloadRef = "payload:new"
	updated, err := f.engine.Define(context.Background(), testAuth, "plan", edited, old.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Plan.State != Draft || updated.Plan.ConfigVersion != 2 || updated.Plan.ActiveRunId != "" || len(updated.Plan.ActivationSha256) != 0 {
		t.Fatal("edit did not invalidate activation and old queue")
	}
	oldRun, err := f.engine.GetRun(context.Background(), "workspace", old.Plan.ActiveRunId)
	if err != nil || oldRun.Run.State != Cancelled {
		t.Fatal("old waiting run was not cancelled")
	}
	f.dispatcher.status.State = TargetReady
	f.tick(t)
	if len(f.dispatcher.runs()) != 0 {
		t.Fatal("edited plan executed before approval")
	}
	nextHash, _ := ConfigurationHash(updated.Plan.Config)
	if bytes.Equal(digest, nextHash) {
		t.Fatal("changed payload/configuration retained its activation digest")
	}
	_, err = f.engine.Activate(context.Background(), testAuth, "workspace", "plan", updated.Revision, 2, nextHash)
	if err != nil {
		t.Fatal(err)
	}
	f.tick(t)
	if len(f.dispatcher.runs()) != 1 || f.dispatcher.runs()[0].FrozenConfig.PayloadRef != "payload:new" {
		t.Fatal("new activation did not freeze edited payload")
	}
}

func TestOnceRunsWithoutAnyUIAndDuplicateReceiptsDoNotEmitEvents(t *testing.T) {
	f := setup(t)
	config := f.once()
	config.Schedule.GetOnce().AtUnixMs += 1000
	f.activate(t, "once", config)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- f.engine.Run(ctx) }()
	defer func() { cancel(); <-done }()
	f.clock.Add(1000)
	deadline := time.Now().Add(3 * time.Second)
	for {
		runs := f.allRuns(t, "once")
		if len(runs) == 1 && runs[0].Run.State == Succeeded {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("headless scheduler did not complete its once plan")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if len(f.dispatcher.runs()) != 1 {
		t.Fatal("once dispatched more than once")
	}
	before := eventCount(t, f.store)
	f.dispatcher.mu.Lock()
	receipt := proto.Clone(f.dispatcher.receipts[f.dispatcher.runsUnsafe()[0].OperationId]).(*pb.AutomationReceipt)
	f.dispatcher.mu.Unlock()
	if err := f.engine.Observe(context.Background(), receipt); err != nil {
		t.Fatal(err)
	}
	if eventCount(t, f.store) != before {
		t.Fatal("duplicate executor event appended another state transition")
	}
}
func (d *fakeDispatcher) runsUnsafe() []*pb.AutomationRun { return d.dispatched }

func TestAnchoredIntervalsMisfireAndClockRollback(t *testing.T) {
	for _, policy := range []pb.AutomationMisfirePolicy{Skip, CoalesceOne} {
		t.Run(policy.String(), func(t *testing.T) {
			f := setup(t)
			config := f.interval()
			config.MisfirePolicy = policy
			config.MisfireGraceMs = 1000
			anchor := f.clock.Load()
			f.activate(t, "interval", config)
			f.clock.Add(10000)
			f.tick(t)
			runs := f.allRuns(t, "interval")
			if len(runs) != 1 || !runs[0].Run.Misfire || runs[0].Run.MissedSlots != 11 {
				t.Fatal("missed interval window was not bounded/coalesced")
			}
			if policy == Skip && (runs[0].Run.State != Skipped || len(f.dispatcher.runs()) != 0) {
				t.Fatal("skip replayed backlog")
			}
			if policy == CoalesceOne && len(f.dispatcher.runs()) != 1 {
				t.Fatal("coalesce replayed more than one missed run")
			}
			if f.plan(t, "interval").Plan.NextDueUnixMs != anchor+11000 {
				t.Fatal("interval drifted from its persisted anchor")
			}
			before := eventCount(t, f.store)
			f.clock.Store(anchor - 1000)
			f.tick(t)
			f.clock.Store(anchor + 10000)
			f.tick(t)
			if eventCount(t, f.store) != before {
				t.Fatal("clock rollback repeated a recorded slot")
			}
			f.clock.Store(anchor + 11000)
			f.tick(t)
			if len(f.allRuns(t, "interval")) != 2 {
				t.Fatal("interval did not resume at next anchored slot")
			}
		})
	}
}

func TestQueueOnePauseAndSharedTargetGate(t *testing.T) {
	f := setup(t)
	f.dispatcher.outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_RUNNING
	config := f.interval()
	config.ConcurrencyPolicy = QueueOne
	f.activate(t, "queue", config)
	f.tick(t)
	f.clock.Add(1000)
	f.tick(t)
	queued := f.plan(t, "queue")
	if queued.Plan.PendingRunId == "" || len(f.dispatcher.runs()) != 1 {
		t.Fatal("queue-one did not hold exactly one pending run")
	}
	f.clock.Add(1000)
	f.tick(t)
	latest := f.plan(t, "queue")
	if latest.Plan.PendingRunId != queued.Plan.PendingRunId || latest.Plan.RunCount != 2 {
		t.Fatal("queue grew beyond one")
	}
	_, err := f.engine.Pause(context.Background(), testAuth, "workspace", "queue", latest.Revision)
	if err != nil {
		t.Fatal(err)
	}
	pending, err := f.engine.GetRun(context.Background(), "workspace", queued.Plan.PendingRunId)
	if err != nil || pending.Run.State != Cancelled {
		t.Fatal("pause did not cancel queued delivery")
	}
	f.complete(t, f.dispatcher.runs()[0])
	f.clock.Add(10000)
	f.tick(t)
	if len(f.dispatcher.runs()) != 1 {
		t.Fatal("paused queue was dispatched after current run completed")
	}
	// Different plans/workspaces still share the execution-host/session gate.
	a := f.once()
	a.WorkspaceId = "workspace-a"
	b := f.once()
	b.WorkspaceId = "workspace-b"
	f.activate(t, "a", a)
	f.activate(t, "b", b)
	f.tick(t)
	if len(f.dispatcher.runs()) != 2 {
		t.Fatal("two plans interleaved into the same target")
	}
	active := f.dispatcher.runs()[1]
	f.complete(t, active)
	f.tick(t)
	if len(f.dispatcher.runs()) != 3 {
		t.Fatal("shared target did not release after a correlated completion")
	}
}

// A plan whose target the Host itself refuses keeps its real state; it gains a
// needs-attention marker so a person can repair it, and a single refusal — a
// Worker restart in progress, say — is never enough to raise one.
func TestConsecutiveUnsupportedTargetRaisesPlanNeedsAttention(t *testing.T) {
	f := setup(t)
	f.activate(t, "plan", f.interval())
	f.dispatcher.status = TargetStatus{State: TargetUnsupported}
	f.tick(t)
	first := f.plan(t, "plan")
	if first.Plan.NeedsAttention || first.Plan.AttentionStreak != 1 || first.Plan.AttentionReasonCode != "" {
		t.Fatal("a single refusal already asked for attention")
	}
	f.clock.Add(1000)
	f.tick(t)
	raised := f.plan(t, "plan")
	if !raised.Plan.NeedsAttention || raised.Plan.AttentionReasonCode != "TARGET_UNSUPPORTED" || raised.Plan.AttentionStreak != 2 {
		t.Fatal("consecutive refusals did not raise needs-attention")
	}
	if raised.Plan.State != Active {
		t.Fatal("needs-attention silently changed the plan state")
	}
	for _, run := range f.allRuns(t, "plan") {
		if run.Run.State != Skipped || run.Run.ReasonCode != "TARGET_UNSUPPORTED" {
			t.Fatal("a refused run was not recorded as skipped")
		}
	}
	// Repairing the target and observing one delivery retires the marker.
	f.dispatcher.status = TargetStatus{State: TargetReady, Generation: 7}
	f.clock.Add(1000)
	f.tick(t)
	repaired := f.plan(t, "plan")
	if repaired.Plan.NeedsAttention || repaired.Plan.AttentionStreak != 0 || repaired.Plan.AttentionReasonCode != "" {
		t.Fatal("a delivered run did not clear needs-attention")
	}
}

// Pausing proves nothing about a target, so it must not retire a warning;
// redefining the plan is the repair action and does clear it.
func TestNeedsAttentionSurvivesPauseAndClearsOnEdit(t *testing.T) {
	f := setup(t)
	f.activate(t, "plan", f.interval())
	f.dispatcher.status = TargetStatus{State: TargetUnsupported}
	f.tick(t)
	f.clock.Add(1000)
	f.tick(t)
	flagged := f.plan(t, "plan")
	if !flagged.Plan.NeedsAttention {
		t.Fatal("consecutive refusals did not raise needs-attention")
	}
	paused, err := f.engine.Pause(context.Background(), testAuth, "workspace", "plan", flagged.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if !f.plan(t, "plan").Plan.NeedsAttention {
		t.Fatal("pausing retired a warning it cannot disprove")
	}
	edited := proto.Clone(paused.Plan.Config).(*pb.AutomationPlanConfig)
	edited.Target.SessionId = "replacement"
	updated, err := f.engine.Define(context.Background(), testAuth, "plan", edited, f.plan(t, "plan").Revision)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Plan.NeedsAttention || updated.Plan.AttentionStreak != 0 || updated.Plan.AttentionReasonCode != "" {
		t.Fatal("redefining the target did not clear needs-attention")
	}
}

func TestPauseRacingCapabilityProbePreventsLateDispatch(t *testing.T) {
	f := setup(t)
	f.activate(t, "race", f.once())
	entered, release := make(chan struct{}), make(chan struct{})
	f.dispatcher.supportsHook = func() { close(entered); <-release }
	done := make(chan error, 1)
	go func() { done <- f.engine.Tick(context.Background()) }()
	<-entered
	snapshot := f.plan(t, "race")
	if _, err := f.engine.Pause(context.Background(), testAuth, "workspace", "race", snapshot.Revision); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if len(f.dispatcher.runs()) != 0 {
		t.Fatal("paused claim dispatched after a late readiness response")
	}
}

func TestFiniteLoopWaitsForCompletionAndNeverDuplicatesDone(t *testing.T) {
	f := setup(t)
	f.dispatcher.outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_RUNNING
	config := f.config(&pb.AutomationSchedule{Kind: &pb.AutomationSchedule_LoopAfterCompletion{LoopAfterCompletion: &pb.AutomationLoopAfterCompletion{DelayMs: 1000}}})
	config.MaxRuns = 3
	f.activate(t, "loop", config)
	for iteration := 0; iteration < 3; iteration++ {
		f.tick(t)
		if len(f.dispatcher.runs()) != iteration+1 {
			t.Fatal("loop did not dispatch exactly one iteration")
		}
		f.clock.Add(5000)
		f.tick(t)
		if len(f.dispatcher.runs()) != iteration+1 {
			t.Fatal("loop repeated while previous work was still running")
		}
		receipt := f.complete(t, f.dispatcher.runs()[iteration])
		next := f.plan(t, "loop").Plan.NextDueUnixMs
		before := eventCount(t, f.store)
		if err := f.engine.Observe(context.Background(), receipt); err != nil {
			t.Fatal(err)
		}
		if eventCount(t, f.store) != before || f.plan(t, "loop").Plan.NextDueUnixMs != next {
			t.Fatal("duplicate done released another loop iteration")
		}
		f.clock.Add(1000)
	}
	f.tick(t)
	if len(f.dispatcher.runs()) != 3 || f.plan(t, "loop").Plan.State != Expired {
		t.Fatal("finite loop exceeded its run limit")
	}
}

func TestRevokedAuthorizationAndGenerationMismatchNeverDispatch(t *testing.T) {
	f := setup(t)
	f.activate(t, "auth", f.once())
	f.auth.allowed.Store(false)
	f.tick(t)
	if len(f.dispatcher.runs()) != 0 || f.plan(t, "auth").Plan.State != Draft {
		t.Fatal("revoked authorization was reused")
	}
	f.auth.allowed.Store(true)
	f.activate(t, "generation", f.once())
	f.dispatcher.status.Generation = 8
	f.tick(t)
	if len(f.dispatcher.runs()) != 0 {
		t.Fatal("another target generation received input")
	}
	runs := f.allRuns(t, "generation")
	if len(runs) != 1 || runs[0].Run.State != Skipped || runs[0].Run.ReasonCode != "STALE_GENERATION" {
		t.Fatal("generation mismatch was not explicit")
	}
}

func TestConcurrentEnginesClaimSameSlotOnce(t *testing.T) {
	f := setup(t)
	f.dispatcher.outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_RUNNING
	f.activate(t, "shared", f.once())
	secondStore, err := storage.Open(f.directory, testHost)
	if err != nil {
		t.Fatal(err)
	}
	defer secondStore.Close()
	second, err := New(secondStore, f.dispatcher, f.auth, Options{Clock: func() time.Time { return time.UnixMilli(f.clock.Load()) }, InstanceID: "engine-b"})
	if err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	for _, engine := range []*Engine{f.engine, second} {
		group.Add(1)
		go func(e *Engine) {
			defer group.Done()
			if err := e.Tick(context.Background()); err != nil {
				t.Error(err)
			}
		}(engine)
	}
	group.Wait()
	if len(f.dispatcher.runs()) != 1 || len(f.allRuns(t, "shared")) != 1 {
		t.Fatal("CAS failed to enforce unique slot/claim")
	}
}
