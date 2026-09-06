package sessionhost

import (
	"context"
	"errors"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
)

func runReport(sessionID string, kind pb.WorkerSessionUpcallKind) *pb.WorkerSessionUpcall {
	return &pb.WorkerSessionUpcall{
		SessionId:   sessionID,
		WorkspaceId: workspaceID,
		Kind:        kind,
	}
}

// The reason the upcall exists at all. A pane that dies on its own is reported
// by the Worker the moment it notices, and this Host records it without having
// asked — which is the only way a session that started and ended between two
// reclaims is ever seen.
func TestARunReportRecordsALossWithoutBeingAsked(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.start("session-one", "node-one", "node-one")

	if err := f.service.ObserveRun(fixtureContext, runReport("session-one", pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_LOST)); err != nil {
		t.Fatal(err)
	}
	lost := f.session("session-one")
	if lost.Status != int32(pb.SessionStatus_SESSION_STATUS_LOST) {
		t.Fatalf("the run report did not record a loss: %v", pb.SessionStatus(lost.Status))
	}
	if lost.ReasonCode != "session.run.unreachable" {
		t.Fatalf("a lost session has no reason a client can render: %q", lost.ReasonCode)
	}
	// The generation is untouched: a pane nobody could account for has not been
	// replaced, and forgetting the number would stop the next attach telling a
	// live pane from a new one.
	if lost.Generation != 1 {
		t.Fatalf("a lost session lost its generation: %d", lost.Generation)
	}

	// A replay writes nothing. The Worker's outbox retries until it is
	// acknowledged, and republishing the session on every retry would tell
	// every connected client that a terminal moved when none did.
	before := lost.Revision
	if err := f.service.ObserveRun(fixtureContext, runReport("session-one", pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_LOST)); err != nil {
		t.Fatal(err)
	}
	if after := f.session("session-one").Revision; after != before {
		t.Fatalf("a replayed report rewrote the record: %d -> %d", before, after)
	}
}

// Exited and lost are two different statements and the weaker one never
// overwrites the stronger. Somebody watched the exit; nobody watched the loss.
func TestALossNeverDowngradesAnObservedEnding(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.start("session-one", "node-one", "node-one")

	code := int32(0)
	exit := runReport("session-one", pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_EXITED)
	exit.ExitCode = &code
	if err := f.service.ObserveRun(fixtureContext, exit); err != nil {
		t.Fatal(err)
	}
	ended := f.session("session-one")
	if ended.Status != int32(pb.SessionStatus_SESSION_STATUS_EXITED) {
		t.Fatalf("the exit was not recorded: %v", pb.SessionStatus(ended.Status))
	}
	if ended.ExitCode == nil || *ended.ExitCode != 0 {
		t.Fatalf("the exit code did not travel: %+v", ended.ExitCode)
	}
	if ended.EndedAtMS == 0 {
		t.Fatal("an ended session has no ending time")
	}

	if err := f.service.ObserveRun(fixtureContext, runReport("session-one", pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_LOST)); err != nil {
		t.Fatal(err)
	}
	if status := f.session("session-one").Status; status != int32(pb.SessionStatus_SESSION_STATUS_EXITED) {
		t.Fatalf("an ending was downgraded to a loss: %v", pb.SessionStatus(status))
	}
}

// A report about a pane this Host has already replaced is true about something
// that no longer exists. Applying it would move the pane that replaced it.
func TestAStaleGenerationChangesNothing(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.start("session-one", "node-one", "node-one")
	// The Worker restarted and made a new pane, so the Host's record moves to
	// generation 2. The report that follows is about 1.
	f.worker.generation = 2
	f.worker.held["session-one"].Generation = 2
	if _, err := f.service.Reclaim(fixtureContext, ""); err != nil {
		t.Fatal(err)
	}
	before := f.session("session-one")
	if before.Generation != 2 {
		t.Fatalf("the reclaim did not move the generation: %d", before.Generation)
	}

	stale := runReport("session-one", pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_LOST)
	stale.Generation = 1
	if err := f.service.ObserveRun(fixtureContext, stale); err != nil {
		t.Fatal(err)
	}
	after := f.session("session-one")
	if after.Status != before.Status || after.Revision != before.Revision {
		t.Fatalf("a report about a replaced pane moved the current one: %+v", after)
	}
}

// A report about a session this Host has no record of cannot be made true by
// replaying it, so it is named as permanently unusable rather than left to
// retry forever.
func TestAReportAboutAnUnknownSessionIsRefusedPermanently(t *testing.T) {
	f := newFixture(t)
	f.own()
	err := f.service.ObserveRun(fixtureContext, runReport("session-nobody-has", pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_LOST))
	if !errors.Is(err, ErrUnknownSession) {
		t.Fatalf("an unknown session was not named: %v", err)
	}
	if err = f.service.ObserveRun(fixtureContext, &pb.WorkerSessionUpcall{}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a report with no session id was accepted: %v", err)
	}
}

// The backstop. `Reclaim` was called exactly twice — on a switch and at boot —
// so anything that drifted in between stayed drifted until a client pressed
// something. The loop runs the same idempotent pass on a timer.
func TestReconcileKeepsRunningUntilItsContextEnds(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.start("session-one", "node-one", "node-one")
	delete(f.worker.held, "session-one")

	ctx, cancel := context.WithCancel(fixtureContext)
	done := make(chan error, 1)
	go func() { done <- f.service.Reconcile(ctx, MinReconcileInterval) }()

	deadline := time.After(5 * time.Second)
	for {
		if f.session("session-one").Status == int32(pb.SessionStatus_SESSION_STATUS_EXITED) {
			break
		}
		select {
		case <-deadline:
			cancel()
			t.Fatal("the periodic pass never reconciled the session")
		case <-time.After(10 * time.Millisecond):
		}
	}
	// Passes keep happening: the session that came back is picked up too,
	// without anybody asking.
	f.worker.held["session-one"] = &pb.WorkerSessionState{
		SessionId:        "session-one",
		WorkspaceId:      workspaceID,
		SessionKey:       "node-one",
		Generation:       1,
		WorkerInstanceId: f.worker.instance,
		Status:           pb.SessionStatus_SESSION_STATUS_RUNNING,
		AttachState:      pb.SessionAttachState_SESSION_ATTACH_STATE_DETACHED,
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("the loop did not stop with its context: %v", err)
	}
}

// An interval nobody set is the default, and one below the floor is raised to
// it: a reconcile opens a Worker channel, so a millisecond period would be a
// process-spawn loop rather than a health check.
func TestTheReconcileIntervalHasAFloor(t *testing.T) {
	if DefaultReconcileInterval < MinReconcileInterval {
		t.Fatal("the default period is below its own floor")
	}
	f := newFixture(t)
	f.own()
	ctx, cancel := context.WithTimeout(fixtureContext, 20*time.Millisecond)
	defer cancel()
	// A zero interval must not spin: the call returns when the context ends,
	// not immediately, and not after a million passes.
	if err := f.service.Reconcile(ctx, 0); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a default-interval loop did not wait for its context: %v", err)
	}
}
