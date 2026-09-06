package fshost

import (
	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// The filesystem domain's contribution to the cross-domain event stream
// (Go Host 业务所有权迁移 §2.3, §2.10).
//
// A permission change is the event that matters here, and it is the reason the
// registration is stored through the storage kernel rather than beside it: the
// row and the event that announces it are one transaction, so a client is never
// left rendering access the Host has already revoked.

// EventProjector publishes workspace roots onto the shared stream. It holds no
// state; the Host assembles one and hands it to the hub.
type EventProjector struct{}

func (EventProjector) Domain() pb.EventDomain { return pb.EventDomain_EVENT_DOMAIN_FILESYSTEM }

// Project converts one stored event. A row this projector does not own returns
// nil rather than an envelope with an unspecified kind, so the hub can hand the
// same event to the next domain instead of publishing a shape nobody can read.
func (EventProjector) Project(event storage.Event) (*pb.EventEnvelope, error) {
	if event.Kind != storage.RootKind {
		return nil, nil
	}
	result := &pb.EventEnvelope{
		Sequence:         event.Sequence,
		TransactionId:    event.TransactionID,
		OperationId:      event.OperationID,
		TransactionIndex: uint32(event.TransactionIndex),
		TransactionSize:  uint32(event.TransactionSize),
		WorkspaceId:      event.WorkspaceID,
		Domain:           pb.EventDomain_EVENT_DOMAIN_FILESYSTEM,
		// The domain's own vocabulary: the stored kind keeps its `filesystem.`
		// prefix, the stream names the entity.
		Kind:     "root",
		EntityId: event.ID,
		Priority: pb.EventPriority_EVENT_PRIORITY_NORMAL,
		Revision: event.Revision,
		Deleted:  event.Deleted,
	}
	// A withdrawal carries no entity: the identifier and the revision are the
	// whole statement, and an empty decoded root would read like a workspace
	// whose access was cleared rather than one whose registration is gone.
	if event.Deleted {
		return result, nil
	}
	root := new(pb.WorkspaceRoot)
	if err := proto.Unmarshal(event.Payload, root); err != nil {
		return nil, storage.ErrCorrupt
	}
	root.Revision = event.Revision
	result.Entity = &pb.EventEnvelope_FilesystemRoot{FilesystemRoot: root}
	return result, nil
}
