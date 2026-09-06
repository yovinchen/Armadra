package storage

import (
	"context"
	"errors"
	"testing"
)

func session(id, key string) Session {
	return Session{
		SessionID:    id,
		WorkspaceID:  "w-1",
		SessionKey:   key,
		OwnerNodeID:  key,
		Kind:         1,
		Status:       1,
		AttachState:  1,
		Intent:       1,
		Launch:       []byte("launch-" + id),
		LaunchSHA256: make([]byte, 32),
		CreatedAtMS:  1788560523004,
		UpdatedAtMS:  1788560523004,
		Payload:      []byte("session-" + id),
	}
}

func closed(id, key string) Session {
	return Session{
		SessionID:   id,
		WorkspaceID: "w-1",
		SessionKey:  key,
		Deleted:     true,
		CreatedAtMS: 1788560523004,
		UpdatedAtMS: 1788560524000,
	}
}

// A session record is CAS'd like every other record here. Two clients that both
// decided to start a session for one node produce one start and one refusal,
// rather than two programs in one pane.
func TestSessionRevisionCAS(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	if _, err := store.PutSession(ctx, "session/s-1/create", session("s-1", "node-1"), 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("a first record accepted a revision that cannot exist yet: %v", err)
	}
	if _, err := store.PutSession(ctx, "session/s-1/create", session("s-1", "node-1"), 0); err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetSession(ctx, "s-1")
	if err != nil || stored.Revision != 1 || stored.Status != 1 {
		t.Fatalf("the stored session is not the one that was recorded: %v %+v", err, stored)
	}
	// A second client that read revision 0 and decided to start is refused,
	// and told what the current revision actually is.
	stale := session("s-1", "node-1")
	stale.Status = 3
	_, err = store.PutSession(ctx, "session/s-1/start-stale", stale, 0)
	conflict := new(RevisionConflict)
	if !errors.As(err, &conflict) || conflict.Actual != 1 || conflict.Expected != 0 {
		t.Fatalf("a stale decision was applied: %v", err)
	}
	if _, err = store.PutSession(ctx, "session/s-1/start", stale, 1); err != nil {
		t.Fatal(err)
	}
	stored, err = store.GetSession(ctx, "s-1")
	if err != nil || stored.Revision != 2 || stored.Status != 3 {
		t.Fatalf("the accepted decision did not land: %v %+v", err, stored)
	}
}

// Closing leaves a tombstone with its revision, so re-creating a session under
// the same logical key has to name it. A row that simply vanished would let a
// delayed mount re-create it from revision zero.
func TestSessionCloseLeavesANamedTombstone(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	if _, err := store.PutSession(ctx, "session/s-1/create", session("s-1", "node-1"), 0); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PutSession(ctx, "session/s-1/close", closed("s-1", "node-1"), 1); err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetSession(ctx, "s-1")
	if err != nil || !stored.Deleted || stored.Revision != 2 {
		t.Fatalf("a close did not leave a revisioned tombstone: %v %+v", err, stored)
	}
	// The key lookup is what a mounting client uses, and it must not answer
	// with a closed session: attaching to one would be attaching to nothing.
	if _, err = store.GetSessionByKey(ctx, "node-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a closed session was offered for attachment: %v", err)
	}
	// Re-creating has to name the tombstone.
	if _, err = store.PutSession(ctx, "session/s-1/recreate-zero", session("s-1", "node-1"), 0); err == nil {
		t.Fatal("a closed session was resurrected from revision zero")
	}
	if _, err = store.PutSession(ctx, "session/s-1/recreate", session("s-1", "node-1"), 2); err != nil {
		t.Fatal(err)
	}
	live, err := store.GetSessionByKey(ctx, "node-1")
	if err != nil || live.SessionID != "s-1" || live.Revision != 3 {
		t.Fatalf("the resurrected session is not the one that was named: %v %+v", err, live)
	}
	// Creation time belongs to the first record: a close and a re-create are
	// not the moment this node first had a session.
	if live.CreatedAtMS != 1788560523004 {
		t.Fatalf("re-creating rewrote the creation time: %d", live.CreatedAtMS)
	}
}

// A tombstone carries no intent. A closed session that still named a launch and
// a generation would read like one that is merely hidden.
func TestSessionTombstoneCarriesNoIntent(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	if _, err := store.PutSession(ctx, "session/s-1/create", session("s-1", "node-1"), 0); err != nil {
		t.Fatal(err)
	}
	half := closed("s-1", "node-1")
	half.Generation = 3
	if _, err := store.PutSession(ctx, "session/s-1/half-close", half, 1); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a tombstone kept a generation: %v", err)
	}
}

// A run is the Worker's report about a process it created, so it is keyed by
// (session, generation) rather than CAS'd against a client: the same run
// reported twice is the same row, and a new generation is a new one.
func TestSessionRunsAreKeyedByGeneration(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	if _, err := store.PutSession(ctx, "session/s-1/create", session("s-1", "node-1"), 0); err != nil {
		t.Fatal(err)
	}
	run := SessionRun{
		SessionID:        "s-1",
		Generation:       1,
		WorkerInstanceID: "worker-a",
		BackendRef:       "armadra-node-1:0.0",
		StartedAtMS:      1788560523004,
		Payload:          []byte("run-1"),
	}
	if _, err := store.PutSessionRun(ctx, "session/s-1/run/1", run); err != nil {
		t.Fatal(err)
	}
	// A second report of the same generation updates the row rather than
	// adding one, and a different operation id is what makes it a report
	// rather than a replay.
	exit := int32(0)
	run.ExitCode = &exit
	run.EndedAtMS = 1788560524000
	run.ReasonCode = "session.exited"
	if _, err := store.PutSessionRun(ctx, "session/s-1/run/1/exit", run); err != nil {
		t.Fatal(err)
	}
	next := run
	next.Generation = 2
	next.ExitCode = nil
	next.EndedAtMS = 0
	next.ReasonCode = ""
	if _, err := store.PutSessionRun(ctx, "session/s-1/run/2", next); err != nil {
		t.Fatal(err)
	}
	runs, err := store.SessionRuns(ctx, "s-1")
	if err != nil || len(runs) != 2 {
		t.Fatalf("a recycled session lost its run history: %v %d", err, len(runs))
	}
	// "Exited with 0" and "nobody saw it end" are different facts, and the
	// history is the one place both are still visible.
	if runs[0].ExitCode == nil || *runs[0].ExitCode != 0 || runs[0].Revision != 2 {
		t.Fatalf("the first run's exit was lost: %+v", runs[0])
	}
	if runs[1].ExitCode != nil || runs[1].Generation != 2 {
		t.Fatalf("the second run claims an exit nobody observed: %+v", runs[1])
	}
	stored, err := store.GetSessionRun(ctx, "s-1", 2)
	if err != nil || stored.BackendRef != "armadra-node-1:0.0" {
		t.Fatalf("the run could not be read back: %v %+v", err, stored)
	}
}

// Every change publishes on the Host's durable sequence in the same
// transaction. A session that reached the table but not the outbox would leave
// every connected client offering to start a program that is already running.
func TestSessionChangesPublishInTheSameTransaction(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	result, err := store.PutSession(ctx, "session/s-1/create", session("s-1", "node-1"), 0)
	if err != nil || result.LastSequence == 0 {
		t.Fatalf("a session change published nothing: %v %+v", err, result)
	}
	events, err := store.GetEvents(ctx, EventQuery{})
	if err != nil || len(events.Events) != 1 {
		t.Fatalf("the outbox does not hold the change: %v %d", err, len(events.Events))
	}
	if events.Events[0].Kind != SessionKind || events.Events[0].ID != "s-1" || events.Events[0].Revision != 1 {
		t.Fatalf("the published event does not describe the session: %+v", events.Events[0])
	}
	run := SessionRun{SessionID: "s-1", Generation: 1, WorkerInstanceID: "worker-a", StartedAtMS: 1788560523004, Payload: []byte("run-1")}
	if _, err = store.PutSessionRun(ctx, "session/s-1/run/1", run); err != nil {
		t.Fatal(err)
	}
	events, err = store.GetEvents(ctx, EventQuery{})
	if err != nil || len(events.Events) != 2 || events.Events[1].Kind != SessionRunKind {
		t.Fatalf("a run change published nothing of its own: %v %+v", err, events.Events)
	}
	// The run's entity id names both halves of its identity, so a client that
	// applied one generation cannot mistake the next for the same object.
	if events.Events[1].ID != "s-1/1" {
		t.Fatalf("a run event does not name its generation: %s", events.Events[1].ID)
	}
}

// Replaying an interrupted request returns the original receipt rather than
// recording a second session. A different request under the same operation id
// is refused instead.
func TestSessionOperationIsIdempotent(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	first, err := store.PutSession(ctx, "session/s-1/create", session("s-1", "node-1"), 0)
	if err != nil {
		t.Fatal(err)
	}
	// Same statement, later clock: a retry is the same request.
	retry := session("s-1", "node-1")
	retry.UpdatedAtMS = 1788560999999
	replay, err := store.PutSession(ctx, "session/s-1/create", retry, 0)
	if err != nil || !replay.Replayed || replay.LastSequence != first.LastSequence {
		t.Fatalf("a retry was recorded as a second session: %v %+v", err, replay)
	}
	different := session("s-1", "node-1")
	different.OwnerNodeID = "node-2"
	if _, err = store.PutSession(ctx, "session/s-1/create", different, 0); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("one operation id covered two different sessions: %v", err)
	}
}

// A claim records which Worker instance speaks for an execution host. It is
// what makes EXITED and LOST decidable, and it deliberately publishes nothing:
// a Worker restart is not a business change a client renders.
func TestSessionClaimsReplaceAndPublishNothing(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	if err := store.PutSessionClaim(ctx, SessionClaim{WorkerInstanceID: "worker-a", ClaimedAtMS: 1788560523004}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutSessionClaim(ctx, SessionClaim{WorkerInstanceID: "worker-b", ClaimedAtMS: 1788560524000}); err != nil {
		t.Fatal(err)
	}
	claim, err := store.SessionClaimOf(ctx, "")
	if err != nil || claim.WorkerInstanceID != "worker-b" {
		t.Fatalf("the claim did not move to the current Worker: %v %+v", err, claim)
	}
	events, err := store.GetEvents(ctx, EventQuery{})
	if err != nil || len(events.Events) != 0 {
		t.Fatalf("a claim woke every subscriber: %v %d", err, len(events.Events))
	}
	if _, err = store.SessionClaimOf(ctx, "构建机"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an unclaimed execution host answered with a claim: %v", err)
	}
}

// Listing answers one workspace's live sessions. A closed one is not a session
// that exists, and another workspace's is not this caller's business.
func TestSessionListingIsWorkspaceScopedAndSkipsTombstones(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	for _, id := range []string{"s-1", "s-2"} {
		if _, err := store.PutSession(ctx, "session/"+id+"/create", session(id, "node-"+id), 0); err != nil {
			t.Fatal(err)
		}
	}
	other := session("s-3", "node-s-3")
	other.WorkspaceID = "w-2"
	if _, err := store.PutSession(ctx, "session/s-3/create", other, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PutSession(ctx, "session/s-2/close", closed("s-2", "node-s-2"), 1); err != nil {
		t.Fatal(err)
	}
	listed, more, err := store.ListSessions(ctx, "w-1", "", 100)
	if err != nil || more || len(listed) != 1 || listed[0].SessionID != "s-1" {
		t.Fatalf("the listing is not this workspace's live sessions: %v %v %+v", err, more, listed)
	}
	// The export walk is the one read that keeps tombstones: a rollback that
	// dropped them would let the Runtime re-create a session somebody closed.
	all, err := store.AllSessions(ctx)
	if err != nil || len(all) != 3 {
		t.Fatalf("the export walk lost a record: %v %d", err, len(all))
	}
}
