package sessionhost

import (
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
)

// start records and starts one session, which is what every reclaim test needs
// before it can disagree with the execution host about it.
func (f *fixture) start(sessionID, key, node string) *pb.Session {
	f.t.Helper()
	created := f.create(sessionID, key, node)
	started, err := f.service.StartSession(fixtureContext, f.caller(ScopeWrite, workspaceID), &pb.StartSessionRequest{
		OperationId:      "session/" + sessionID + "/start",
		ExpectedRevision: created.GetRevision(),
		SessionId:        sessionID,
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return started.GetSession()
}

// A Worker that answered and did not list the session saw it end. A Worker that
// could not be reached saw nothing, and the two must not be recorded alike:
// EXITED invites a client to start a second program, and the tmux server is
// very likely still running with the first.
func TestReclaimTellsAnEndingFromAnAbsence(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.start("session-one", "node-one", "node-one")

	// The Worker answers and no longer has it: somebody was watching.
	delete(f.worker.held, "session-one")
	outcome, err := f.service.Reclaim(fixtureContext, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(outcome.Ended) != 1 || len(outcome.Lost) != 0 {
		t.Fatalf("an observed ending was not recorded as one: %+v", outcome)
	}
	if status := f.session("session-one").Status; status != int32(pb.SessionStatus_SESSION_STATUS_EXITED) {
		t.Fatalf("the session was not recorded as ended: %v", pb.SessionStatus(status))
	}

	f2 := newFixture(t)
	f2.own()
	f2.start("session-two", "node-two", "node-two")
	// Nobody can reach the machine: nothing was observed.
	f2.unreachable = true
	outcome, err = f2.service.Reclaim(fixtureContext, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(outcome.Lost) != 1 || len(outcome.Ended) != 0 {
		t.Fatalf("an unreachable machine's session was recorded as ended: %+v", outcome)
	}
	lost := f2.session("session-two")
	if lost.Status != int32(pb.SessionStatus_SESSION_STATUS_LOST) {
		t.Fatalf("the session was not recorded as lost: %v", pb.SessionStatus(lost.Status))
	}
	if lost.ReasonCode != "session.run.unreachable" {
		t.Fatalf("a lost session has no reason a client can render: %q", lost.ReasonCode)
	}
	// And the generation is untouched: a session nobody could see has not
	// moved on, and forgetting its generation would make the next attach
	// unable to tell a live pane from a replaced one.
	if lost.Generation != 1 {
		t.Fatalf("a lost session lost its generation: %d", lost.Generation)
	}
}

// A Worker that reconnected reports the same generation, and everything the
// user was typing into keeps working. A Worker that restarted reports a higher
// one, and the old socket has to be told.
func TestReclaimRecordsTheWorkersGenerationAndNeverInventsOne(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.start("session-one", "node-one", "node-one")

	// Same Worker, same pane: nothing about the record should move, and
	// nothing should be published — re-publishing would tell every client that
	// every terminal changed each time a Host restarted.
	before := f.session("session-one")
	outcome, err := f.service.Reclaim(fixtureContext, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(outcome.Regenerated) != 0 || len(outcome.Reconciled) != 1 {
		t.Fatalf("an unchanged session was reported as changed: %+v", outcome)
	}
	after := f.session("session-one")
	if after.Revision != before.Revision || after.Generation != before.Generation {
		t.Fatalf("an unchanged reclaim rewrote the record: %d -> %d", before.Revision, after.Revision)
	}

	// The Worker restarted and created a new pane under the same logical key.
	f.worker.instance = "worker-b"
	f.worker.held["session-one"].Generation = 2
	f.worker.held["session-one"].WorkerInstanceId = "worker-b"
	outcome, err = f.service.Reclaim(fixtureContext, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(outcome.Regenerated) != 1 {
		t.Fatalf("a replaced pane was not reported: %+v", outcome)
	}
	moved := f.session("session-one")
	if moved.Generation != 2 {
		t.Fatalf("the Host did not record the Worker's new generation: %d", moved.Generation)
	}
	// The previous run stays as history, so an operator can see that a Worker
	// restart replaced somebody's shell rather than that it never happened.
	runs, err := f.store.SessionRuns(fixtureContext, "session-one")
	if err != nil || len(runs) != 2 {
		t.Fatalf("the replaced run was not kept: %v %d", err, len(runs))
	}
	claim, err := f.store.SessionClaimOf(fixtureContext, "")
	if err != nil || claim.WorkerInstanceID != "worker-b" {
		t.Fatalf("the claim did not move to the Worker that answered: %v %+v", err, claim)
	}
}

// A pending session has never been started, so a Worker that has never heard of
// it is exactly what "not started" means. Reconciling it would record an
// intent as an ending.
func TestReclaimLeavesPendingSessionsAlone(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.create("session-one", "node-one", "node-one")
	outcome, err := f.service.Reclaim(fixtureContext, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(outcome.Ended)+len(outcome.Lost)+len(outcome.Reconciled) != 0 {
		t.Fatalf("a pending session was reconciled: %+v", outcome)
	}
	if f.worker.reclaims != 0 {
		t.Fatalf("a Host with nothing to reconcile still asked: %d", f.worker.reclaims)
	}
	if status := f.session("session-one").Status; status != int32(pb.SessionStatus_SESSION_STATUS_PENDING) {
		t.Fatalf("a pending session changed: %v", pb.SessionStatus(status))
	}
}

// Reclaiming twice with nothing changing changes nothing. It is called after
// every switch and after every restart, so it has to be safe to call at any
// time.
func TestReclaimIsIdempotent(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.start("session-one", "node-one", "node-one")
	delete(f.worker.held, "session-one")
	if _, err := f.service.Reclaim(fixtureContext, ""); err != nil {
		t.Fatal(err)
	}
	first := f.session("session-one")
	if _, err := f.service.Reclaim(fixtureContext, ""); err != nil {
		t.Fatal(err)
	}
	second := f.session("session-one")
	if first.Revision != second.Revision {
		t.Fatalf("a second reclaim rewrote a settled record: %d -> %d", first.Revision, second.Revision)
	}
}

// A session on another execution host is that host's Worker's business. This
// one must not record it as lost because a different machine answered.
func TestReclaimOnlyTouchesItsOwnExecutionHost(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.start("session-one", "node-one", "node-one")
	remote, err := f.service.CreateSession(fixtureContext, f.caller(ScopeWrite, workspaceID), &pb.CreateSessionRequest{
		OperationId: "session/session-remote/create",
		Session: &pb.Session{
			SessionId: "session-remote", WorkspaceId: workspaceID, SessionKey: "node-remote",
			ExecutionHostId: "构建机", Kind: pb.SessionKind_SESSION_KIND_TERMINAL,
			Launch: &pb.SessionLaunch{Shell: "/bin/zsh", WorkingDirectory: "/srv/项目"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	started, err := f.service.StartSession(fixtureContext, f.caller(ScopeWrite, workspaceID), &pb.StartSessionRequest{
		OperationId:      "session/session-remote/start",
		ExpectedRevision: remote.GetSession().GetRevision(),
		SessionId:        "session-remote",
	})
	if err != nil {
		t.Fatal(err)
	}
	if started.GetSession().GetExecutionHostId() != "构建机" {
		t.Fatalf("the remote session lost its execution host: %+v", started.GetSession())
	}
	// This machine's Worker no longer has the local session, and says nothing
	// about the remote one — because it was never asked.
	delete(f.worker.held, "session-one")
	outcome, err := f.service.Reclaim(fixtureContext, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(outcome.Ended) != 1 || outcome.Ended[0] != "session-one" {
		t.Fatalf("the local reclaim touched the wrong sessions: %+v", outcome)
	}
	if status := f.session("session-remote").Status; status != int32(pb.SessionStatus_SESSION_STATUS_RUNNING) {
		t.Fatalf("a remote session was reconciled by the local machine: %v", pb.SessionStatus(status))
	}
}
