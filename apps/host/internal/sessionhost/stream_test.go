package sessionhost

import (
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// A session's lifecycle and one run of it are two kinds on the stream, not one.
// A client watching a terminal cares about the first; a run history cares about
// the second; publishing them as one kind would make every consumer decode a
// backend reference to discover nothing it wanted moved.
func TestTheStreamPublishesSessionsAndRunsSeparately(t *testing.T) {
	f := newFixture(t)
	f.own()
	created := f.create("session-one", "node-one", "node-one")
	if _, err := f.service.StartSession(fixtureContext, f.caller(ScopeWrite, workspaceID), &pb.StartSessionRequest{
		OperationId: "session/session-one/start", ExpectedRevision: created.GetRevision(), SessionId: "session-one",
	}); err != nil {
		t.Fatal(err)
	}
	events, err := f.store.GetEvents(fixtureContext, storage.EventQuery{})
	if err != nil {
		t.Fatal(err)
	}
	projector := EventProjector{}
	kinds := map[string]int{}
	var runEnvelope *pb.EventEnvelope
	for _, event := range events.Events {
		envelope, err := projector.Project(event)
		if err != nil {
			t.Fatal(err)
		}
		if envelope == nil {
			continue
		}
		if envelope.GetDomain() != pb.EventDomain_EVENT_DOMAIN_SESSION {
			t.Fatalf("an event was published in the wrong domain: %v", envelope.GetDomain())
		}
		kinds[envelope.GetKind()]++
		if envelope.GetKind() == "run" {
			runEnvelope = envelope
		}
	}
	if kinds["session"] == 0 || kinds["run"] == 0 {
		t.Fatalf("the stream did not carry both kinds: %v", kinds)
	}
	// A run that started or ended decides whether the user is looking at a live
	// pane. It must not sit behind a slow subscriber's backlog of edits.
	if runEnvelope.GetPriority() != pb.EventPriority_EVENT_PRIORITY_HIGH {
		t.Fatalf("a run change was published at ordinary priority: %v", runEnvelope.GetPriority())
	}
	// The run's identifier names both halves of its identity, and the decoded
	// entity carries the session it belongs to even though the storage row has
	// only the compound key.
	if runEnvelope.GetEntityId() != "session-one/1" {
		t.Fatalf("a run event does not name its generation: %q", runEnvelope.GetEntityId())
	}
	if runEnvelope.GetSessionRun().GetSessionId() != "session-one" {
		t.Fatalf("the decoded run does not name its session: %+v", runEnvelope.GetSessionRun())
	}
}

// A closed session carries no entity. An empty decoded session would read like
// one whose launch was cleared rather than one that is gone.
func TestAClosedSessionIsPublishedAsATombstone(t *testing.T) {
	f := newFixture(t)
	f.own()
	created := f.create("session-one", "node-one", "node-one")
	if _, err := f.service.CloseSession(fixtureContext, f.caller(ScopeWrite, workspaceID), &pb.CloseSessionRequest{
		OperationId: "session/session-one/close", ExpectedRevision: created.GetRevision(), SessionId: "session-one",
	}); err != nil {
		t.Fatal(err)
	}
	events, err := f.store.GetEvents(fixtureContext, storage.EventQuery{})
	if err != nil {
		t.Fatal(err)
	}
	last := events.Events[len(events.Events)-1]
	envelope, err := EventProjector{}.Project(last)
	if err != nil {
		t.Fatal(err)
	}
	if !envelope.GetDeleted() || envelope.GetSession() != nil {
		t.Fatalf("a tombstone was published with an entity: %+v", envelope)
	}
	if envelope.GetEntityId() != "session-one" || envelope.GetRevision() == 0 {
		t.Fatalf("a tombstone has to name what it closed, and at which revision: %+v", envelope)
	}
}

// A row this projector does not own returns nil, so the hub can hand the same
// event to the next domain instead of publishing a shape nobody can read.
func TestTheProjectorDeclinesOtherDomainsEvents(t *testing.T) {
	envelope, err := EventProjector{}.Project(storage.Event{Entity: storage.Entity{Key: storage.Key{Kind: "filesystem.root", ID: "w"}}})
	if err != nil || envelope != nil {
		t.Fatalf("the session projector claimed another domain's event: %v %+v", err, envelope)
	}
}
