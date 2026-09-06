package githost

import (
	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// The git domain's contribution to the cross-domain event stream
// (Go Host 业务所有权迁移 §2.3, §2.10).
//
// A git operation is the one entity in this codebase a person literally watches
// change: it goes queued -> running -> finished while they look at it. That is
// why the queue's writes go through the storage kernel rather than beside it —
// the row and the event that announces it are one transaction, so a panel never
// shows a push as still running after the Host has already recorded that it is
// not, and never shows a conflict the record does not have.

// EventProjector publishes git entities onto the shared stream. It holds no
// state; the Host assembles one and hands it to the hub.
type EventProjector struct{}

func (EventProjector) Domain() pb.EventDomain { return pb.EventDomain_EVENT_DOMAIN_GIT }

// Project converts one stored event. A row this projector does not own returns
// nil rather than an envelope with an unspecified kind, so the hub can hand the
// same event to the next domain instead of publishing a shape nobody can read.
func (EventProjector) Project(event storage.Event) (*pb.EventEnvelope, error) {
	kind := ""
	switch event.Kind {
	case OperationKind:
		kind = "operation"
	case RepositoryKind:
		kind = "repository"
	case CloneKind:
		kind = "clone"
	default:
		return nil, nil
	}
	result := &pb.EventEnvelope{
		Sequence:         event.Sequence,
		TransactionId:    event.TransactionID,
		OperationId:      event.OperationID,
		TransactionIndex: uint32(event.TransactionIndex),
		TransactionSize:  uint32(event.TransactionSize),
		WorkspaceId:      event.WorkspaceID,
		Domain:           pb.EventDomain_EVENT_DOMAIN_GIT,
		// The domain's own vocabulary: the stored kind keeps its `git.` prefix,
		// the stream names the entity.
		Kind:     kind,
		EntityId: event.ID,
		Priority: pb.EventPriority_EVENT_PRIORITY_NORMAL,
		Revision: event.Revision,
		Deleted:  event.Deleted,
	}
	if event.Deleted {
		return result, nil
	}
	switch event.Kind {
	case OperationKind:
		operation := new(pb.GitOperation)
		if err := proto.Unmarshal(event.Payload, operation); err != nil {
			return nil, storage.ErrCorrupt
		}
		operation.Revision = event.Revision
		result.Entity = &pb.EventEnvelope_GitOperation{GitOperation: operation}
	case RepositoryKind:
		state := new(pb.RepositoryState)
		if err := proto.Unmarshal(event.Payload, state); err != nil {
			return nil, storage.ErrCorrupt
		}
		state.Revision = event.Revision
		result.Entity = &pb.EventEnvelope_GitRepositoryState{GitRepositoryState: state}
	case CloneKind:
		job := new(pb.GitCloneJob)
		if err := proto.Unmarshal(event.Payload, job); err != nil {
			return nil, storage.ErrCorrupt
		}
		job.Revision = event.Revision
		result.Entity = &pb.EventEnvelope_GitCloneJob{GitCloneJob: job}
	}
	return result, nil
}
