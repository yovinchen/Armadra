package agenthost

import (
	"crypto/sha256"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

func hookEvent(t *testing.T, id string, observed int64) *pb.HookEvent {
	t.Helper()
	body, err := proto.Marshal(&pb.AgentStatus{
		NodeId:      nodeOne,
		WorkspaceId: workspaceID,
		AgentId:     "claude",
		State:       pb.AgentState_AGENT_STATE_DONE,
	})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	return &pb.HookEvent{
		EventId:          id,
		NodeId:           nodeOne,
		WorkspaceId:      workspaceID,
		SessionId:        "session-one",
		Provider:         "claude",
		Payload:          body,
		PayloadSha256:    sum[:],
		SchemaVersion:    1,
		Kind:             pb.HookEventKind_HOOK_EVENT_KIND_TURN_END,
		ObservedAtUnixMs: observed,
	}
}

// v9 folded a turn into agent_status and threw the turn away, so how a node
// reached its state was unrecoverable. The event is now kept as well, and kept
// once: the same event id arriving twice is one row, which is what lets the
// drain and the upcall both deliver it.
func TestAHookTurnIsKeptAsWellAsFolded(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedNode(nodeOne, "agent")

	applied, err := f.service.ObserveHookEvent(fixtureContext, hookEvent(t, "node-one/1000", 1000))
	if err != nil {
		t.Fatal(err)
	}
	if !applied {
		t.Fatal("the turn was not folded into the node's status")
	}
	stored, err := f.store.GetHookEvent(fixtureContext, "node-one/1000")
	if err != nil {
		t.Fatalf("the turn itself was not kept: %v", err)
	}
	if stored.Provider != "claude" || stored.ObservedAtMS != 1000 {
		t.Fatalf("the record does not describe the turn: %+v", stored)
	}
	// The published payload is the HookEvent a subscriber receives as entity
	// 181, not the normalized body it carries.
	published := new(pb.HookEvent)
	if err = proto.Unmarshal(stored.Payload, published); err != nil {
		t.Fatal(err)
	}
	if published.GetEventId() != "node-one/1000" || published.GetObservedAtUnixMs() != 1000 {
		t.Fatalf("the published event does not name the turn: %+v", published)
	}

	// The same event twice is one row: the drain and the upcall converge here.
	if _, err = f.service.ObserveHookEvent(fixtureContext, hookEvent(t, "node-one/1000", 1000)); err != nil {
		t.Fatal(err)
	}
	events, more, err := f.store.ListHookEvents(fixtureContext, nodeOne, 0, 10)
	if err != nil || more || len(events) != 1 {
		t.Fatalf("a replayed turn was recorded twice: %d %v %v", len(events), more, err)
	}

	// A second, later turn is a second row, newest first.
	if _, err = f.service.ObserveHookEvent(fixtureContext, hookEvent(t, "node-one/2000", 2000)); err != nil {
		t.Fatal(err)
	}
	events, _, err = f.store.ListHookEvents(fixtureContext, nodeOne, 0, 10)
	if err != nil || len(events) != 2 || events[0].EventID != "node-one/2000" {
		t.Fatalf("the history is not newest first: %+v %v", events, err)
	}
}

// The body is opaque here, so the digest is the only thing that can tell a
// truncated body from a short one. A mismatch is refused rather than stored.
func TestABodyThatDoesNotMatchItsDigestIsRefused(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedNode(nodeOne, "agent")

	event := hookEvent(t, "node-one/1000", 1000)
	event.Payload = append(event.Payload, 0)
	if _, err := f.service.ObserveHookEvent(fixtureContext, event); err == nil {
		t.Fatal("a rewritten body was accepted")
	}
	if _, err := f.store.GetHookEvent(fixtureContext, "node-one/1000"); err == nil {
		t.Fatal("a refused turn was recorded anyway")
	}
}

// The upcall arrives unasked, so the ownership check has to be on the landing
// point rather than only on the drain that calls it. While the Runtime owns the
// domain its tables are the record, and a push that wrote here as well would be
// the dual write this migration exists to avoid.
func TestAHookTurnChangesNothingWhileTheRuntimeOwnsTheDomain(t *testing.T) {
	f := newFixture(t)
	f.seedNode(nodeOne, "agent")

	applied, err := f.service.ObserveHookEvent(fixtureContext, hookEvent(t, "node-one/1000", 1000))
	if err != nil || applied {
		t.Fatalf("the Host recorded an agent event it does not own: %v %v", applied, err)
	}
	if _, err = f.store.GetHookEvent(fixtureContext, "node-one/1000"); err == nil {
		t.Fatal("a turn was kept under the wrong owner")
	}
	if _, err = f.store.GetAgentStatus(fixtureContext, nodeOne); err == nil {
		t.Fatal("a status was written under the wrong owner")
	}
}

// The projector has to claim the new kind, or the row would be stored and
// never reach a client — which is the same as not storing it, for anyone
// watching a board.
func TestTheProjectorPublishesAHookEventAsItsOwnEntity(t *testing.T) {
	event := hookEvent(t, "node-one/1000", 1000)
	payload, err := proto.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := EventProjector{}.Project(storage.Event{
		Sequence: 9,
		Entity: storage.Entity{
			Key:      storage.Key{Kind: storage.HookEventKind, ID: "node-one/1000", WorkspaceID: workspaceID},
			Revision: 1,
			Payload:  payload,
		},
	})
	if err != nil || envelope == nil {
		t.Fatalf("the projector did not claim a hook event: %v", err)
	}
	if envelope.GetKind() != "hookEvent" || envelope.GetDomain() != pb.EventDomain_EVENT_DOMAIN_AGENT {
		t.Fatalf("the envelope is not an agent hook event: %+v", envelope)
	}
	published := envelope.GetHookEvent()
	if published == nil || published.GetEventId() != "node-one/1000" {
		t.Fatalf("entity 181 was not filled in: %+v", envelope.GetEntity())
	}
}
