package sessionhost

import (
	"errors"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// Mounting a node is a read. Creating a session is a separate decision with an
// operation id and a revision behind it — which is the whole point of moving
// the domain, because a page that rendered twice used to start two programs.
func TestCreatingIsNotStarting(t *testing.T) {
	f := newFixture(t)
	f.own()
	created := f.create("session-one", "node-one", "node-one")
	if created.GetStatus() != pb.SessionStatus_SESSION_STATUS_PENDING {
		t.Fatalf("a created session claims to be running: %v", created.GetStatus())
	}
	if created.GetGeneration() != 0 || created.GetBackendKind() != "" {
		t.Fatalf("a created session claims a process: %+v", created)
	}
	if f.worker.starts != 0 {
		t.Fatalf("creating asked the Worker for a process: %d", f.worker.starts)
	}
	// The read a mounting node makes finds the session and starts nothing.
	got, err := f.service.GetSession(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.GetSessionRequest{SessionKey: "node-one"})
	if err != nil || got.GetSession().GetSessionId() != "session-one" || got.GetRun() != nil {
		t.Fatalf("the mount read did not find the pending session: %v %+v", err, got)
	}
	if f.worker.starts != 0 {
		t.Fatalf("reading asked the Worker for a process: %d", f.worker.starts)
	}
}

// A client that read revision 0 and decided to start loses to one that already
// started. Two clients pressing start produce one process, and the second one
// is refused before any Worker is asked.
func TestOnlyOneStartReachesTheWorker(t *testing.T) {
	f := newFixture(t)
	f.own()
	created := f.create("session-one", "node-one", "node-one")
	caller := f.caller(ScopeWrite, workspaceID)
	started, err := f.service.StartSession(fixtureContext, caller, &pb.StartSessionRequest{
		OperationId:      "session/session-one/start-a",
		ExpectedRevision: created.GetRevision(),
		SessionId:        "session-one",
	})
	if err != nil {
		t.Fatal(err)
	}
	if started.GetSession().GetStatus() != pb.SessionStatus_SESSION_STATUS_RUNNING ||
		started.GetSession().GetGeneration() != 1 || started.GetRun().GetGeneration() != 1 {
		t.Fatalf("the start did not record what the Worker reported: %+v", started)
	}
	// The backend and its reference come from the Worker. This Host never
	// invents either, because it never created a pane.
	if started.GetSession().GetBackendKind() != "tmux" || started.GetRun().GetBackendRef() == "" {
		t.Fatalf("the run does not carry the Worker's own backend: %+v", started.GetRun())
	}
	second, err := f.service.StartSession(fixtureContext, caller, &pb.StartSessionRequest{
		OperationId:      "session/session-one/start-b",
		ExpectedRevision: created.GetRevision(),
		SessionId:        "session-one",
	})
	conflict := new(storage.RevisionConflict)
	if !errors.As(err, &conflict) || second != nil {
		t.Fatalf("a second client started a second process: %v %+v", err, second)
	}
	if f.worker.starts != 1 {
		t.Fatalf("the Worker was asked more than once: %d", f.worker.starts)
	}
}

// Replaying an interrupted start must not ask for a second process. The receipt
// says the decision already reached the database, so the answer is what is
// recorded.
func TestReplayedStartDoesNotStartASecondProcess(t *testing.T) {
	f := newFixture(t)
	f.own()
	created := f.create("session-one", "node-one", "node-one")
	request := &pb.StartSessionRequest{
		OperationId:      "session/session-one/start",
		ExpectedRevision: created.GetRevision(),
		SessionId:        "session-one",
	}
	first, err := f.service.StartSession(fixtureContext, f.caller(ScopeWrite, workspaceID), request)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := f.service.StartSession(fixtureContext, f.caller(ScopeWrite, workspaceID), request)
	if err != nil {
		t.Fatal(err)
	}
	if f.worker.starts != 1 {
		t.Fatalf("a replay asked the Worker again: %d", f.worker.starts)
	}
	if replay.GetSession().GetGeneration() != first.GetSession().GetGeneration() {
		t.Fatalf("a replay answered about a different run: %+v", replay)
	}
}

// A Worker that refuses leaves the session LOST rather than EXITED. Nobody
// watched anything end, and calling that EXITED would invite a client to start
// a second program on top of a first.
func TestAWorkerThatRefusesLeavesTheSessionLostNotExited(t *testing.T) {
	f := newFixture(t)
	f.own()
	created := f.create("session-one", "node-one", "node-one")
	f.worker.failStart = true
	if _, err := f.service.StartSession(fixtureContext, f.caller(ScopeWrite, workspaceID), &pb.StartSessionRequest{
		OperationId:      "session/session-one/start",
		ExpectedRevision: created.GetRevision(),
		SessionId:        "session-one",
	}); err == nil {
		t.Fatal("a refused start reported success")
	}
	stored := f.session("session-one")
	if stored.Status != int32(pb.SessionStatus_SESSION_STATUS_LOST) {
		t.Fatalf("a refused start was recorded as %v", pb.SessionStatus(stored.Status))
	}
	if stored.ReasonCode != "session.run.unreachable" {
		t.Fatalf("the refusal has no reason a client can render: %q", stored.ReasonCode)
	}
}

// Terminating ends the run and keeps the record; closing withdraws the intent
// and kills nothing. Conflating them would make "remove this from my board" and
// "kill this program" one button.
func TestTerminatingKeepsTheRecordAndClosingKillsNothing(t *testing.T) {
	f := newFixture(t)
	f.own()
	created := f.create("session-one", "node-one", "node-one")
	caller := f.caller(ScopeWrite, workspaceID)
	started, err := f.service.StartSession(fixtureContext, caller, &pb.StartSessionRequest{
		OperationId: "session/session-one/start", ExpectedRevision: created.GetRevision(), SessionId: "session-one",
	})
	if err != nil {
		t.Fatal(err)
	}
	ended, err := f.service.TerminateSession(fixtureContext, caller, &pb.TerminateSessionRequest{
		OperationId:      "session/session-one/terminate",
		ExpectedRevision: started.GetSession().GetRevision(),
		SessionId:        "session-one",
		Mode:             "process",
	})
	if err != nil {
		t.Fatal(err)
	}
	if ended.GetSession().GetStatus() != pb.SessionStatus_SESSION_STATUS_EXITED ||
		ended.GetSession().GetTerminationIntent() != pb.TerminationIntent_TERMINATION_INTENT_USER {
		t.Fatalf("terminating did not record an ending: %+v", ended.GetSession())
	}
	// The Runtime's own word is kept verbatim, because the enum is lossy and a
	// rollback has to put the exact column value back.
	if ended.GetSession().GetReasonCode() != "session.termination.process" {
		t.Fatalf("the Runtime's own termination word was lost: %q", ended.GetSession().GetReasonCode())
	}
	// The record survives, with its run history.
	runs, err := f.store.SessionRuns(fixtureContext, "session-one")
	if err != nil || len(runs) != 1 || runs[0].EndedAtMS == 0 {
		t.Fatalf("the run history did not record the ending: %v %+v", err, runs)
	}
	closed, err := f.service.CloseSession(fixtureContext, caller, &pb.CloseSessionRequest{
		OperationId:      "session/session-one/close",
		ExpectedRevision: ended.GetSession().GetRevision(),
		SessionId:        "session-one",
	})
	if err != nil || closed.GetSessionId() != "session-one" {
		t.Fatal(err)
	}
	// Closing asked the Worker for nothing: the one signal was the terminate.
	if f.worker.signals != 1 {
		t.Fatalf("closing signalled a process: %d signals", f.worker.signals)
	}
	if _, err = f.service.Session(fixtureContext, "session-one"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a closed session is still offered: %v", err)
	}
}

// An interrupt stops the foreground program and leaves the shell. Recording it
// as an ending would make the pane the user is still typing into look dead.
func TestInterruptDoesNotEndTheSession(t *testing.T) {
	f := newFixture(t)
	f.own()
	created := f.create("session-one", "node-one", "node-one")
	caller := f.caller(ScopeWrite, workspaceID)
	started, err := f.service.StartSession(fixtureContext, caller, &pb.StartSessionRequest{
		OperationId: "session/session-one/start", ExpectedRevision: created.GetRevision(), SessionId: "session-one",
	})
	if err != nil {
		t.Fatal(err)
	}
	after, err := f.service.TerminateSession(fixtureContext, caller, &pb.TerminateSessionRequest{
		OperationId:      "session/session-one/interrupt",
		ExpectedRevision: started.GetSession().GetRevision(),
		SessionId:        "session-one",
		Mode:             "interrupt",
	})
	if err != nil {
		t.Fatal(err)
	}
	if after.GetSession().GetStatus() != pb.SessionStatus_SESSION_STATUS_RUNNING {
		t.Fatalf("an interrupt ended the session: %v", after.GetSession().GetStatus())
	}
	if after.GetSession().GetEndedAtUnixMs() != 0 {
		t.Fatal("an interrupt stamped an ending time on a live session")
	}
}

// Recycling is one method, not terminate-then-start: a client that died between
// the two would leave a session recorded as running with no process behind it.
func TestRecyclingIsOneDecisionAndKeepsTheHistory(t *testing.T) {
	f := newFixture(t)
	f.own()
	created := f.create("session-one", "node-one", "node-one")
	caller := f.caller(ScopeWrite, workspaceID)
	started, err := f.service.StartSession(fixtureContext, caller, &pb.StartSessionRequest{
		OperationId: "session/session-one/start", ExpectedRevision: created.GetRevision(), SessionId: "session-one",
	})
	if err != nil {
		t.Fatal(err)
	}
	recycled, err := f.service.RecycleSession(fixtureContext, caller, &pb.RecycleSessionRequest{
		OperationId:      "session/session-one/recycle",
		ExpectedRevision: started.GetSession().GetRevision(),
		SessionId:        "session-one",
	})
	if err != nil {
		t.Fatal(err)
	}
	if recycled.GetSession().GetGeneration() != 2 || recycled.GetRun().GetGeneration() != 2 {
		t.Fatalf("the recycle did not move to the Worker's new generation: %+v", recycled)
	}
	if recycled.GetSession().GetStatus() != pb.SessionStatus_SESSION_STATUS_RUNNING {
		t.Fatalf("the recycled session is not running: %v", recycled.GetSession().GetStatus())
	}
	// The logical key survives, which is what makes a mounting node find the
	// same session after somebody recycled it.
	if recycled.GetSession().GetSessionKey() != "node-one" {
		t.Fatalf("the recycle changed the logical key: %q", recycled.GetSession().GetSessionKey())
	}
	runs, err := f.store.SessionRuns(fixtureContext, "session-one")
	if err != nil || len(runs) != 2 {
		t.Fatalf("the recycle lost the previous run: %v %d", err, len(runs))
	}
}

// A signal aimed at a generation the execution host has already replaced is
// refused. "Stop what I am looking at" must never become "stop whatever is
// there now".
func TestASignalAgainstAReplacedGenerationIsRefused(t *testing.T) {
	f := newFixture(t)
	f.own()
	created := f.create("session-one", "node-one", "node-one")
	caller := f.caller(ScopeWrite, workspaceID)
	started, err := f.service.StartSession(fixtureContext, caller, &pb.StartSessionRequest{
		OperationId: "session/session-one/start", ExpectedRevision: created.GetRevision(), SessionId: "session-one",
	})
	if err != nil {
		t.Fatal(err)
	}
	// The pane is replaced underneath: the Worker moves on to generation 2.
	f.worker.generation = 2
	f.worker.held["session-one"].Generation = 2
	_, err = f.service.TerminateSession(fixtureContext, caller, &pb.TerminateSessionRequest{
		OperationId:      "session/session-one/terminate",
		ExpectedRevision: started.GetSession().GetRevision(),
		SessionId:        "session-one",
		Mode:             "process",
	})
	if !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a stale signal reached the current pane: %v", err)
	}
	// And nothing was recorded as ended, because nothing was.
	if status := f.session("session-one").Status; status != int32(pb.SessionStatus_SESSION_STATUS_RUNNING) {
		t.Fatalf("a refused signal changed the record: %v", pb.SessionStatus(status))
	}
}

// The surface is workspace-scoped end to end. A device granted one workspace
// must not learn which programs are running in another, or where.
func TestTheSurfaceIsWorkspaceScoped(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.create("session-one", "node-one", "node-one")
	stranger := f.caller(ScopeRead, otherID)
	if _, err := f.service.GetSession(fixtureContext, stranger, &pb.GetSessionRequest{SessionId: "session-one"}); !errors.Is(err, ErrAuthorization) {
		t.Fatalf("another workspace read this one's session: %v", err)
	}
	listed, err := f.service.ListSessions(fixtureContext, stranger, &pb.ListSessionsRequest{})
	if err != nil || len(listed.GetSessions()) != 0 {
		t.Fatalf("another workspace listed this one's sessions: %v %+v", err, listed)
	}
	// And a read grant is not a write grant.
	if _, err = f.service.CloseSession(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.CloseSessionRequest{
		OperationId: "session/session-one/close", ExpectedRevision: 1, SessionId: "session-one",
	}); !errors.Is(err, ErrAuthorization) {
		t.Fatalf("a read grant closed a session: %v", err)
	}
}

// Every mutation refuses while this Host is not the settled owner. There is no
// dual-write mode, and reads keep answering the whole time.
func TestWritesRefuseUntilTheDomainHasSettledHere(t *testing.T) {
	f := newFixture(t)
	caller := f.caller(ScopeWrite, workspaceID)
	if _, err := f.service.CreateSession(fixtureContext, caller, &pb.CreateSessionRequest{
		OperationId: "session/session-one/create",
		Session: &pb.Session{
			SessionId: "session-one", WorkspaceId: workspaceID, SessionKey: "node-one",
			Kind:   pb.SessionKind_SESSION_KIND_TERMINAL,
			Launch: &pb.SessionLaunch{Shell: "/bin/zsh", WorkingDirectory: "/项目/一"},
		},
	}); !errors.Is(err, ErrOwnershipMoved) {
		t.Fatalf("a write landed while the Runtime still owns the domain: %v", err)
	}
	// The read answers, and says there is nothing — which is true.
	if _, err := f.service.GetSession(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.GetSessionRequest{SessionId: "session-one"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a read failed while the Runtime owns the domain: %v", err)
	}
}

// Asking about a session by identifier and by key are two different questions.
// Naming both would let them disagree, and resolving that by precedence would
// answer about a session the caller did not ask for.
func TestGetRefusesToBeAskedTwoQuestionsAtOnce(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.create("session-one", "node-one", "node-one")
	caller := f.caller(ScopeRead, workspaceID)
	for _, request := range []*pb.GetSessionRequest{
		{},
		{SessionId: "session-one", SessionKey: "node-one"},
	} {
		if _, err := f.service.GetSession(fixtureContext, caller, request); !errors.Is(err, ErrInvalid) {
			t.Fatalf("an ambiguous lookup was answered: %+v %v", request, err)
		}
	}
}

// The two forwarded methods are execution: the answers come from the transcript
// or the live pane, and this Host resolves which session and which machine and
// nothing else.
func TestForwardedReadsGoToTheExecutionHost(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.create("session-one", "node-one", "node-one")
	caller := f.caller(ScopeRead, workspaceID)
	title, err := f.service.SuggestTitle(fixtureContext, caller, &pb.SuggestSessionTitleRequest{SessionId: "session-one"})
	if err != nil || title.GetTitle() != "标题 session-one" || title.GetSource() != "terminal" {
		t.Fatalf("the title did not come from the execution host: %v %+v", err, title)
	}
	usage, err := f.service.ContextUsage(fixtureContext, caller, &pb.GetSessionContextUsageRequest{SessionId: "session-one"})
	if err != nil || len(usage.GetUsage()) == 0 || len(usage.GetUsageSha256()) != 32 {
		t.Fatalf("the usage snapshot did not come back whole: %v %+v", err, usage)
	}
	// A Host with no channel says so, rather than answering with nothing.
	f.unreachable = true
	if _, err = f.service.SuggestTitle(fixtureContext, caller, &pb.SuggestSessionTitleRequest{SessionId: "session-one"}); !errors.Is(err, ErrNoWorker) {
		t.Fatalf("an unreachable execution host answered a title: %v", err)
	}
}

// The frozen launch is what makes a start reproducible. Its digest covers the
// decision and nothing that moves on its own, so two readings of an unchanged
// session agree.
func TestTheLaunchDigestCoversTheDecisionAndNothingElse(t *testing.T) {
	base := &pb.SessionLaunch{
		Shell:            "/bin/zsh",
		Command:          "claude",
		Args:             []string{"--permission-mode", "plan"},
		WorkingDirectory: "/项目/一",
		Agent:            &pb.AgentLaunchSpec{AgentId: "claude", WorkingDirectory: "/项目/一"},
		EnvRefs:          []string{"ANTHROPIC_API_KEY"},
	}
	first := LaunchDigest(base)
	// A digest that moved on its own would make the switch's own comparison
	// permanently false, so the fields that describe *this record* are absent
	// from it by construction; the only way to change it is to change the
	// command.
	if string(LaunchDigest(base)) != string(first) {
		t.Fatal("the launch digest is not stable")
	}
	for _, changed := range []*pb.SessionLaunch{
		{Shell: "/bin/bash", Command: base.Command, Args: base.Args, WorkingDirectory: base.WorkingDirectory, Agent: base.Agent, EnvRefs: base.EnvRefs},
		{Shell: base.Shell, Command: base.Command, Args: []string{"--permission-mode", "acceptEdits"}, WorkingDirectory: base.WorkingDirectory, Agent: base.Agent, EnvRefs: base.EnvRefs},
		{Shell: base.Shell, Command: base.Command, Args: base.Args, WorkingDirectory: "/项目/二", Agent: base.Agent, EnvRefs: base.EnvRefs},
	} {
		if string(LaunchDigest(changed)) == string(first) {
			t.Fatalf("a different command produced the same digest: %+v", changed)
		}
	}
	// An environment *value* can never enter the launch at all: only names are
	// carried, and a name that looks like an assignment is refused.
	if _, err := freeze(&pb.SessionLaunch{Shell: "/bin/zsh", WorkingDirectory: "/项目/一", EnvRefs: []string{"TOKEN=secret"}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a secret was accepted into a frozen launch: %v", err)
	}
	// And a relative or traversing directory is not a directory anywhere.
	for _, path := range []string{"项目", "/项目/../etc", ""} {
		if _, err := freeze(&pb.SessionLaunch{Shell: "/bin/zsh", WorkingDirectory: path}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%q was frozen as a working directory: %v", path, err)
		}
	}
}
