package settingshost

import (
	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// The settings domain's contribution to the cross-domain event stream
// (Go Host 业务所有权迁移 §2.3).
//
// Settings events carry an empty workspace id, because the document belongs to
// the machine. That is not a missing field: attributing the document to one
// workspace would hide a theme or keybinding change from every other workspace
// the same session is following. The stream's subscription filter admits these
// on the host-wide grant instead (eventstream/priority.go).
//
// Projecting here rather than in the stream package keeps one decoder and one
// set of rules about which kinds are publishable, so two clients can never see
// two different registries.

// EventProjector publishes settings entities onto the shared event stream. It
// holds no state; the Host assembles one and hands it to the hub.
type EventProjector struct{}

func (EventProjector) Domain() pb.EventDomain { return pb.EventDomain_EVENT_DOMAIN_SETTINGS }

// streamKind names the entity in the domain's own vocabulary. The stream
// carries the name as a string so a new settings entity does not need a wire
// change, while the stored kind keeps its `settings.` prefix.
func streamKind(kind string) string {
	switch kind {
	case KindDocument:
		return "document"
	case KindExecutionHost:
		return "executionHost"
	}
	return ""
}

// Project converts one stored settings event. A stored row this projector does
// not own — another domain's entity, or a kind this version does not publish —
// returns nil rather than an envelope with an unspecified kind, so a client
// never has to guess what an empty payload meant.
func (EventProjector) Project(event storage.Event) (*pb.EventEnvelope, error) {
	kind := streamKind(event.Kind)
	if kind == "" {
		return nil, nil
	}
	result := &pb.EventEnvelope{
		Sequence:         event.Sequence,
		TransactionId:    event.TransactionID,
		OperationId:      event.OperationID,
		TransactionIndex: uint32(event.TransactionIndex),
		TransactionSize:  uint32(event.TransactionSize),
		WorkspaceId:      event.WorkspaceID,
		Domain:           pb.EventDomain_EVENT_DOMAIN_SETTINGS,
		Kind:             kind,
		EntityId:         event.ID,
		Priority:         pb.EventPriority_EVENT_PRIORITY_NORMAL,
		Revision:         event.Revision,
		Deleted:          event.Deleted,
	}
	// A deletion carries no entity: the tombstone's id and revision are the
	// whole statement, and an empty decoded object would read like an execution
	// host whose address was cleared rather than one that was removed.
	if event.Deleted {
		return result, nil
	}
	switch event.Kind {
	case KindDocument:
		document, err := decodeDocument(event.Entity)
		if err != nil {
			return nil, err
		}
		result.Entity = &pb.EventEnvelope_SettingsDocument{SettingsDocument: document}
	case KindExecutionHost:
		host, err := decodeHost(event.Entity)
		if err != nil {
			return nil, err
		}
		result.Entity = &pb.EventEnvelope_SettingsExecutionHost{SettingsExecutionHost: host}
	}
	return result, nil
}
