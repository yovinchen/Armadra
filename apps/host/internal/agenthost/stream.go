package agenthost

import (
	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// The agent domain's contribution to the cross-domain event stream
// (Go Host 业务所有权迁移 §2.3, §2.10).
//
// Seven kinds rather than one, because they change for different reasons
// and a client subscribes to the ones it draws: a board follows status, a node
// header follows approvals, an inbox follows mailbox messages, a handoff card
// follows handoffs. One "agent changed" kind would make every consumer decode a
// transcript reference to discover nothing it cared about moved.
//
// Approvals carry the high priority §2.3 reserves for control-shaped changes,
// and they are the reason that reservation exists. A permission question is a
// human being waited on by a program that has stopped; it must not sit behind a
// slow subscriber's backlog of ordinary edits, because the cost of the delay is
// an agent doing nothing for as long as the queue takes to drain.

// EventProjector publishes agent records onto the shared stream. It holds no
// state; the Host assembles one and hands it to the hub.
type EventProjector struct{}

func (EventProjector) Domain() pb.EventDomain { return pb.EventDomain_EVENT_DOMAIN_AGENT }

// Project converts one stored event. A row this projector does not own returns
// nil rather than an envelope with an unspecified kind, so the hub can hand the
// same event to the next domain instead of publishing a shape nobody can read.
func (EventProjector) Project(event storage.Event) (*pb.EventEnvelope, error) {
	switch event.Kind {
	case storage.AgentStatusKind:
		return decode(event, "status", pb.EventPriority_EVENT_PRIORITY_NORMAL, new(pb.AgentStatus))
	// The turn itself, alongside the state it produced. Normal priority: the
	// state is what a board draws, and this is the history behind it.
	case storage.HookEventKind:
		return decode(event, "hookEvent", pb.EventPriority_EVENT_PRIORITY_NORMAL, new(pb.HookEvent))
	case storage.ApprovalKind:
		return decode(event, "approval", pb.EventPriority_EVENT_PRIORITY_HIGH, new(pb.Approval))
	case storage.MailboxKind:
		return decode(event, "mailbox", pb.EventPriority_EVENT_PRIORITY_NORMAL, new(pb.MailboxMessage))
	case storage.DeliveryKind:
		return decode(event, "delivery", pb.EventPriority_EVENT_PRIORITY_NORMAL, new(pb.Delivery))
	case storage.HandoffKind:
		return decode(event, "handoff", pb.EventPriority_EVENT_PRIORITY_HIGH, new(pb.Handoff))
	case storage.ContextLinksKind:
		return decode(event, "contextLinks", pb.EventPriority_EVENT_PRIORITY_NORMAL, new(pb.ContextLinks))
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
		Domain:           pb.EventDomain_EVENT_DOMAIN_AGENT,
		// The domain's own vocabulary: the stored kind keeps its `agent.`
		// prefix, the stream names the entity.
		Kind:     kind,
		EntityId: event.ID,
		Priority: priority,
		Revision: event.Revision,
		Deleted:  event.Deleted,
	}
}

// decode fills in the envelope's entity, or leaves it empty for a tombstone.
//
// A withdrawn record carries no entity: the identifier and the revision are the
// whole statement, and an empty decoded object would read like a record whose
// fields were cleared rather than one that is gone.
func decode(event storage.Event, kind string, priority pb.EventPriority, into proto.Message) (*pb.EventEnvelope, error) {
	result := envelope(event, kind, priority)
	if event.Deleted {
		return result, nil
	}
	if err := proto.Unmarshal(event.Payload, into); err != nil {
		return nil, storage.ErrCorrupt
	}
	switch typed := into.(type) {
	case *pb.AgentStatus:
		typed.Revision = event.Revision
		result.Entity = &pb.EventEnvelope_AgentStatus{AgentStatus: typed}
	case *pb.Approval:
		typed.Revision = event.Revision
		result.Entity = &pb.EventEnvelope_Approval{Approval: typed}
	case *pb.MailboxMessage:
		typed.Revision = event.Revision
		result.Entity = &pb.EventEnvelope_MailboxMessage{MailboxMessage: typed}
	case *pb.Delivery:
		typed.Revision = event.Revision
		result.Entity = &pb.EventEnvelope_Delivery{Delivery: typed}
	case *pb.Handoff:
		typed.Revision = event.Revision
		result.Entity = &pb.EventEnvelope_Handoff{Handoff: typed}
	case *pb.ContextLinks:
		typed.Revision = event.Revision
		result.Entity = &pb.EventEnvelope_ContextLinks{ContextLinks: typed}
	// A HookEvent carries no revision of its own: it is a record of something
	// that happened once, and a version number on it would imply it could
	// change.
	case *pb.HookEvent:
		result.Entity = &pb.EventEnvelope_HookEvent{HookEvent: typed}
	default:
		return nil, storage.ErrCorrupt
	}
	return result, nil
}
