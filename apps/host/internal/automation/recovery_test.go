package automation

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

func TestCrashAfterDispatchBoundaryLooksUpWithoutBlindResend(t *testing.T) {
	f := setup(t)
	f.activate(t, "crash", f.once())
	ctx, cancel := context.WithCancel(context.Background())
	f.dispatcher.dispatchHook = func(_ context.Context, _ *pb.AutomationRun) (*pb.AutomationReceipt, error) {
		cancel()
		return nil, errors.New("connection lost after unknown effects")
	}
	if err := f.engine.Tick(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("simulated crash window: %v", err)
	}
	runs := f.allRuns(t, "crash")
	if len(runs) != 1 || runs[0].Run.State != Dispatching || len(f.dispatcher.runs()) != 1 {
		t.Fatal("dispatch boundary was not committed before executor call")
	}
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	f.store, err = storage.Open(f.directory, testHost)
	if err != nil {
		t.Fatal(err)
	}
	f.engine, err = New(f.store, f.dispatcher, f.auth, Options{Clock: func() time.Time { return time.UnixMilli(f.clock.Load()) }, InstanceID: "after-restart"})
	if err != nil {
		t.Fatal(err)
	}
	f.tick(t)
	if len(f.dispatcher.runs()) != 1 {
		t.Fatal("unexpired claim was stolen")
	}
	f.clock.Add(31000)
	f.tick(t)
	recovered := f.allRuns(t, "crash")[0]
	if recovered.Run.State != Unknown || len(f.dispatcher.runs()) != 1 {
		t.Fatal("missing executor journal was incorrectly treated as proof of no effects")
	}
	another := f.once()
	f.activate(t, "other", another)
	f.tick(t)
	if len(f.dispatcher.runs()) != 1 || f.plan(t, "other").Plan.PendingRunId == "" {
		t.Fatal("unknown outcome released its target gate")
	}
	// A matching structured result reconciles the prior operation, then allows
	// another plan to claim the shared target. A generic done event cannot.
	receipt := f.dispatcher.receipt(recovered.Run, pb.AutomationOutcome_AUTOMATION_OUTCOME_SUCCEEDED)
	if err = f.engine.Observe(context.Background(), receipt); err != nil {
		t.Fatal(err)
	}
	f.dispatcher.dispatchHook = nil
	f.tick(t)
	if len(f.dispatcher.runs()) != 2 {
		t.Fatal("reconciled completion did not release target")
	}
}

func TestOnlyAffirmativeNoEffectProofPermitsBoundedStableOperationRetry(t *testing.T) {
	for _, limit := range []uint32{0, 1} {
		t.Run(string(rune('0'+limit)), func(t *testing.T) {
			f := setup(t)
			config := f.once()
			config.SafeRetryLimit = limit
			f.activate(t, "safe", config)
			f.dispatcher.dispatchHook = func(_ context.Context, run *pb.AutomationRun) (*pb.AutomationReceipt, error) {
				if len(f.dispatcher.runs()) == 1 {
					return nil, errors.New("uncertain transport")
				}
				return &pb.AutomationReceipt{OperationId: run.OperationId, RequestSha256: run.RequestSha256, Outcome: pb.AutomationOutcome_AUTOMATION_OUTCOME_SUCCEEDED, Sequence: 2, ObservedAtUnixMs: f.clock.Load()}, nil
			}
			f.tick(t)
			first := f.dispatcher.runs()[0]
			f.dispatcher.lookupHook = func(_ context.Context, operation string) (*pb.AutomationReceipt, error) {
				return &pb.AutomationReceipt{OperationId: operation, RequestSha256: first.RequestSha256, Outcome: pb.AutomationOutcome_AUTOMATION_OUTCOME_NOT_DISPATCHED, Sequence: 1, ObservedAtUnixMs: f.clock.Load()}, nil
			}
			f.tick(t)
			if len(f.dispatcher.runs()) != 1 {
				t.Fatal("retry ignored configured backoff")
			}
			f.clock.Add(1000)
			f.tick(t)
			if limit == 0 {
				if len(f.dispatcher.runs()) != 1 || f.allRuns(t, "safe")[0].Run.State != Failed {
					t.Fatal("retry occurred when disabled")
				}
				return
			}
			dispatched := f.dispatcher.runs()
			if len(dispatched) != 2 || dispatched[0].OperationId != dispatched[1].OperationId || !bytes.Equal(dispatched[0].RequestSha256, dispatched[1].RequestSha256) {
				t.Fatal("safe retry used a new logical operation or digest")
			}
			if f.allRuns(t, "safe")[0].Run.State != Succeeded {
				t.Fatal("verified safe retry was not reconciled")
			}
		})
	}
}

func TestReceiptCorrelationOrderingAndPriorDeliveryPreventUnsafeRetry(t *testing.T) {
	f := setup(t)
	f.dispatcher.outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_RUNNING
	config := f.once()
	config.SafeRetryLimit = 3
	f.activate(t, "receipt", config)
	f.tick(t)
	run := f.dispatcher.runs()[0]
	valid := f.dispatcher.receipt(run, pb.AutomationOutcome_AUTOMATION_OUTCOME_SUCCEEDED)
	for _, mutate := range []func(*pb.AutomationReceipt){func(r *pb.AutomationReceipt) { r.RequestSha256 = make([]byte, 32) }, func(r *pb.AutomationReceipt) { r.Sequence = 0 }, func(r *pb.AutomationReceipt) { r.Sequence = 1 }, func(r *pb.AutomationReceipt) { r.ReasonCode = "raw terminal output" }} {
		r := proto.Clone(valid).(*pb.AutomationReceipt)
		mutate(r)
		if err := f.engine.Observe(context.Background(), r); !errors.Is(err, ErrReceipt) {
			t.Fatalf("bad receipt accepted: %v", err)
		}
	}
	f.dispatcher.lookupHook = func(context.Context, string) (*pb.AutomationReceipt, error) { return nil, errors.New("journal lost") }
	f.tick(t)
	uncertain := f.allRuns(t, "receipt")[0].Run
	if uncertain.State != Unknown || !uncertain.DeliveryObserved {
		t.Fatal("missing journal either erased delivery proof or falsely reported fresh running state")
	}
	noEffect := proto.Clone(valid).(*pb.AutomationReceipt)
	noEffect.Outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_NOT_DISPATCHED
	if err := f.engine.Observe(context.Background(), noEffect); !errors.Is(err, ErrReceipt) {
		t.Fatal("contradictory no-effect proof enabled a duplicate dispatch")
	}
	if err := f.engine.Observe(context.Background(), valid); err != nil {
		t.Fatal(err)
	}
	before := eventCount(t, f.store)
	stale := proto.Clone(valid).(*pb.AutomationReceipt)
	stale.Sequence = 1
	stale.Outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_RUNNING
	if err := f.engine.Observe(context.Background(), stale); err != nil {
		t.Fatal(err)
	}
	laterDuplicate := proto.Clone(valid).(*pb.AutomationReceipt)
	laterDuplicate.Sequence++
	if err := f.engine.Observe(context.Background(), laterDuplicate); err != nil {
		t.Fatal(err)
	}
	if eventCount(t, f.store) != before || len(f.dispatcher.runs()) != 1 {
		t.Fatal("replayed/out-of-order events created new execution")
	}
}

func TestBusyExpiryOnceExpiryAndOfflineAreNotSuccess(t *testing.T) {
	f := setup(t)
	config := f.once()
	config.BusyTtlMs = 1000
	f.dispatcher.status.State = TargetBusy
	f.activate(t, "busy", config)
	f.tick(t)
	f.clock.Add(1000)
	f.tick(t)
	if f.allRuns(t, "busy")[0].Run.State != RunExpired || len(f.dispatcher.runs()) != 0 {
		t.Fatal("busy TTL was treated as idle or success")
	}
	f.dispatcher.status.State = TargetOffline
	f.activate(t, "offline", f.once())
	f.tick(t)
	if f.allRuns(t, "offline")[0].Run.State != Skipped {
		t.Fatal("offline target was cold-started implicitly")
	}
	f.dispatcher.status.State = TargetReady
	late := f.once()
	late.MisfireGraceMs = 1000
	f.activate(t, "late", late)
	f.clock.Add(2000)
	f.tick(t)
	if f.allRuns(t, "late")[0].Run.State != RunExpired {
		t.Fatal("expired once schedule was reported as ordinary success")
	}
}

func TestFiniteLoopByExpiryStopsWithoutKillingExistingExecution(t *testing.T) {
	f := setup(t)
	f.dispatcher.outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_RUNNING
	config := f.config(&pb.AutomationSchedule{Kind: &pb.AutomationSchedule_LoopAfterCompletion{LoopAfterCompletion: &pb.AutomationLoopAfterCompletion{DelayMs: 1000}}})
	config.ExpiresAtUnixMs = f.clock.Load() + 2000
	f.activate(t, "expires", config)
	f.tick(t)
	f.clock.Add(3000)
	f.tick(t)
	if f.plan(t, "expires").Plan.State != Expired || f.allRuns(t, "expires")[0].Run.State != Running {
		t.Fatal("expiry killed or falsely completed in-flight execution")
	}
	f.complete(t, f.dispatcher.runs()[0])
	f.clock.Add(10000)
	f.tick(t)
	if len(f.dispatcher.runs()) != 1 {
		t.Fatal("expired loop dispatched a successor")
	}
}

func TestExpiredOnceRequiresAConfigurationEditBeforeReactivation(t *testing.T) {
	f := setup(t)
	f.activate(t, "once", f.once())
	f.tick(t)
	snapshot := f.plan(t, "once")
	digest, _ := ConfigurationHash(snapshot.Plan.Config)
	if _, err := f.engine.Activate(context.Background(), testAuth, "workspace", "once", snapshot.Revision, snapshot.Plan.ConfigVersion, digest); !errors.Is(err, ErrInvalid) {
		t.Fatal("completed once schedule was reactivated with the same slot")
	}
	edited := proto.Clone(snapshot.Plan.Config).(*pb.AutomationPlanConfig)
	edited.Schedule.GetOnce().AtUnixMs = f.clock.Load() + 1000
	updated, err := f.engine.Define(context.Background(), testAuth, "once", edited, snapshot.Revision)
	if err != nil || updated.Plan.State != Draft || updated.Plan.ConfigVersion != 2 {
		t.Fatalf("explicit edit could not create a fresh draft: %v", err)
	}
}

func TestLateCompletionUsesExecutorTimeAndMisfirePolicy(t *testing.T) {
	f := setup(t)
	f.dispatcher.outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_RUNNING
	start := f.clock.Load()
	config := f.config(&pb.AutomationSchedule{Kind: &pb.AutomationSchedule_LoopAfterCompletion{LoopAfterCompletion: &pb.AutomationLoopAfterCompletion{DelayMs: 1000}}})
	config.MaxRuns = 2
	config.MisfirePolicy = CoalesceOne
	config.MisfireGraceMs = 1000
	f.activate(t, "late-completion", config)
	f.tick(t)
	run := f.dispatcher.runs()[0]
	receipt := f.dispatcher.receipt(run, pb.AutomationOutcome_AUTOMATION_OUTCOME_SUCCEEDED)
	receipt.ObservedAtUnixMs = start + 1000
	f.clock.Store(start + 5000)
	if err := f.engine.Observe(context.Background(), receipt); err != nil {
		t.Fatal(err)
	}
	completed, err := f.engine.GetRun(context.Background(), "workspace", run.Id)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Run.CompletedAtUnixMs != start+1000 || f.plan(t, "late-completion").Plan.NextDueUnixMs != start+2000 {
		t.Fatal("receipt arrival was falsely recorded as execution completion")
	}
	f.tick(t)
	if len(f.dispatcher.runs()) != 2 || !f.dispatcher.runs()[1].Misfire {
		t.Fatal("late loop completion did not follow its configured misfire policy")
	}
}

func TestNoEffectFailureCannotCircumventRetryLimitThroughANewLoopRun(t *testing.T) {
	f := setup(t)
	config := f.config(&pb.AutomationSchedule{Kind: &pb.AutomationSchedule_LoopAfterCompletion{LoopAfterCompletion: &pb.AutomationLoopAfterCompletion{DelayMs: 1000}}})
	config.MaxRuns = 10
	f.dispatcher.outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_NOT_DISPATCHED
	f.activate(t, "no-effect-loop", config)
	f.tick(t)
	if f.plan(t, "no-effect-loop").Plan.State != Paused {
		t.Fatal("executor rejection was treated as a completed loop iteration")
	}
	f.clock.Add(10000)
	f.tick(t)
	if len(f.dispatcher.runs()) != 1 {
		t.Fatal("new loop operation bypassed safe_retry_limit=0")
	}
}

func TestCrashBeforeDispatchReclaimsOnlyAfterLeaseAndRevalidates(t *testing.T) {
	f := setup(t)
	f.activate(t, "claimed", f.once())
	ctx, cancel := context.WithCancel(context.Background())
	f.dispatcher.supportsHook = cancel
	if err := f.engine.Tick(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("claim-only crash window: %v", err)
	}
	if len(f.dispatcher.runs()) != 0 || f.allRuns(t, "claimed")[0].Run.State != Claimed {
		t.Fatal("executor was called before dispatch boundary")
	}
	f.dispatcher.supportsHook = nil
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	f.store, err = storage.Open(f.directory, testHost)
	if err != nil {
		t.Fatal(err)
	}
	f.engine, err = New(f.store, f.dispatcher, f.auth, Options{Clock: func() time.Time { return time.UnixMilli(f.clock.Load()) }, InstanceID: "recovered-claim"})
	if err != nil {
		t.Fatal(err)
	}
	f.tick(t)
	if len(f.dispatcher.runs()) != 0 {
		t.Fatal("live claim lease was ignored")
	}
	f.clock.Add(31000)
	f.tick(t)
	if len(f.dispatcher.runs()) != 1 || f.allRuns(t, "claimed")[0].Run.State != Succeeded {
		t.Fatal("safe pre-dispatch claim was not recovered")
	}
}

func TestPendingTTLExpiresWhileAnotherPlanStillOwnsTarget(t *testing.T) {
	f := setup(t)
	f.dispatcher.outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_RUNNING
	f.activate(t, "a", f.once())
	waiting := f.once()
	waiting.BusyTtlMs = 1000
	f.activate(t, "b", waiting)
	f.tick(t)
	if f.plan(t, "b").Plan.PendingRunId == "" {
		t.Fatal("target collision did not queue")
	}
	f.clock.Add(1000)
	f.tick(t)
	if f.plan(t, "b").Plan.PendingRunId != "" || f.allRuns(t, "b")[0].Run.State != RunExpired || len(f.dispatcher.runs()) != 1 {
		t.Fatal("expired pending delivery was retained or dispatched")
	}
	if f.plan(t, "a").Plan.ActiveRunId == "" {
		t.Fatal("pending expiry released another run's target gate")
	}
}

func TestExpiryDuringReadinessProbeDoesNotCrossDispatchBoundary(t *testing.T) {
	f := setup(t)
	config := f.once()
	config.ExpiresAtUnixMs = f.clock.Load() + 1000
	f.activate(t, "expires-during-probe", config)
	f.dispatcher.supportsHook = func() { f.clock.Add(2000) }
	f.tick(t)
	if len(f.dispatcher.runs()) != 0 || f.plan(t, "expires-during-probe").Plan.State != Expired {
		t.Fatal("plan dispatched after expiry while readiness was being checked")
	}
	runs := f.allRuns(t, "expires-during-probe")
	if len(runs) != 1 || runs[0].Run.State != RunExpired {
		t.Fatal("expired queued delivery did not retain an explicit result")
	}
}

func TestKnownDeliveryProofSurvivesRestartAndRejectsNoEffect(t *testing.T) {
	f := setup(t)
	f.dispatcher.outcome = pb.AutomationOutcome_AUTOMATION_OUTCOME_RUNNING
	config := f.once()
	config.SafeRetryLimit = 3
	f.activate(t, "proof", config)
	f.tick(t)
	run := f.dispatcher.runs()[0]
	f.dispatcher.lookupHook = func(context.Context, string) (*pb.AutomationReceipt, error) {
		return nil, errors.New("journal unavailable")
	}
	f.tick(t)
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	f.store, err = storage.Open(f.directory, testHost)
	if err != nil {
		t.Fatal(err)
	}
	f.engine, err = New(f.store, f.dispatcher, f.auth, Options{Clock: func() time.Time { return time.UnixMilli(f.clock.Load()) }, InstanceID: "proof-restarted"})
	if err != nil {
		t.Fatal(err)
	}
	f.dispatcher.lookupHook = func(context.Context, string) (*pb.AutomationReceipt, error) {
		return &pb.AutomationReceipt{OperationId: run.OperationId, RequestSha256: run.RequestSha256, Outcome: pb.AutomationOutcome_AUTOMATION_OUTCOME_NOT_DISPATCHED, Sequence: 2, ObservedAtUnixMs: f.clock.Load()}, nil
	}
	f.clock.Add(31000)
	f.tick(t)
	stored := f.allRuns(t, "proof")[0].Run
	if stored.State != Unknown || !stored.DeliveryObserved || len(f.dispatcher.runs()) != 1 {
		t.Fatal("restart erased delivery evidence and enabled a contradictory retry")
	}
}
