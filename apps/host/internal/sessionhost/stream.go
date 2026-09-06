package sessionhost

import (
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// The session domain's contribution to the cross-domain event stream
// (Go Host 业务所有权迁移 §2.3, §2.10).
//
// Two kinds travel here rather than one. A session's lifecycle and one run of
// it change for different reasons and at different rates: a node that is
// waiting to be started, a pane that exited, a Worker that came back with a new
// generation. A client watching a terminal cares about the first; a run history
// cares about the second; publishing them as one kind would make every
// consumer decode a backend reference to discover nothing it wanted moved.
//
// Run events carry the high priority §2.3 reserves for control-shaped changes.
// A run that started or ended is what decides whether the user is looking at a
// live pane, and it must not sit behind a slow subscriber's backlog of
// ordinary edits.

// EventProjector publishes sessions and their runs onto the shared stream. It
// holds no state; the Host assembles one and hands it to the hub.
type EventProjector struct{}

func (EventProjector) Domain() pb.EventDomain { return pb.EventDomain_EVENT_DOMAIN_SESSION }

// Project converts one stored event. A row this projector does not own returns
// nil rather than an envelope with an unspecified kind, so the hub can hand the
// same event to the next domain instead of publishing a shape nobody can read.
func (EventProjector) Project(event storage.Event) (*pb.EventEnvelope, error) {
	switch event.Kind {
	case storage.SessionKind:
		return sessionEnvelope(event)
	case storage.SessionRunKind:
		return runEnvelope(event)
	}
	return nil, nil
}

func envelope(event storage.Event, kind string, priority pb.EventPriority) *pb.EventEnvelope {
	return &pb.EventEnvelope{
		Sequence:         event.Sequence,
		TransactionId:    event.TransactionID,
		OperationId:      event.OperationID,
		TransactionIndex: uint32(event.TransactionIndex),
		TransactionSize:  uint32(event.TransactionSize),
		WorkspaceId:      event.WorkspaceID,
		Domain:           pb.EventDomain_EVENT_DOMAIN_SESSION,
		// The domain's own vocabulary: the stored kind keeps its `session.`
		// prefix, the stream names the entity.
		Kind:     kind,
		EntityId: event.ID,
		Priority: priority,
		Revision: event.Revision,
		Deleted:  event.Deleted,
	}
}

func sessionEnvelope(event storage.Event) (*pb.EventEnvelope, error) {
	result := envelope(event, "session", pb.EventPriority_EVENT_PRIORITY_NORMAL)
	// A closed session carries no entity: the identifier and the revision are
	// the whole statement, and an empty decoded session would read like one
	// whose launch was cleared rather than one that is gone.
	if event.Deleted {
		return result, nil
	}
	session := new(pb.Session)
	if err := proto.Unmarshal(event.Payload, session); err != nil {
		return nil, storage.ErrCorrupt
	}
	session.Revision = event.Revision
	result.Entity = &pb.EventEnvelope_Session{Session: session}
	return result, nil
}

func runEnvelope(event storage.Event) (*pb.EventEnvelope, error) {
	result := envelope(event, "run", pb.EventPriority_EVENT_PRIORITY_HIGH)
	// A run's stored identifier is `<session>/<generation>`, because a run is
	// identified by both. The workspace is not on the row — a run is a fact
	// about a process, not about a workspace — so it is filled in from the
	// session half of the identifier only where a consumer needs it, and left
	// as the storage event carried it otherwise.
	run := new(pb.SessionRun)
	if err := proto.Unmarshal(event.Payload, run); err != nil {
		return nil, storage.ErrCorrupt
	}
	run.Revision = event.Revision
	if run.GetSessionId() == "" {
		if session, _, found := strings.Cut(event.ID, "/"); found {
			run.SessionId = session
		}
	}
	result.Entity = &pb.EventEnvelope_SessionRun{SessionRun: run}
	return result, nil
}
