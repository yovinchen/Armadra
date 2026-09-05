package canvashost

import (
	"context"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// The event outbox as clients see it (host protocol design §3.3).
//
// Events are written in the same transaction as the entities they describe and
// numbered by one durable per-Host sequence, so a client resumes with the
// sequence it last applied and receives exactly what it missed. Three answers
// are possible and they are deliberately different:
//
//   - OK: here are the next events.
//   - SNAPSHOT_REQUIRED: your cursor is older than what is still retained.
//     Apply a snapshot, then resume from the sequence it reports.
//   - CURSOR_AHEAD: your cursor is beyond this Host's watermark. That is a
//     different Host or a restored database, and rewinding you to the
//     watermark would silently drop the changes you already applied.
//
// An empty page is never used to mean any of these; each is a stated status.

// SubscribeEvents reads one page of business events after the client's cursor.
// Events are filtered to the caller's workspace, and only canvas kinds are
// published: staged migration rows and Host configuration are not canvas
// content and must not appear in a client's change stream.
func (s *Service) SubscribeEvents(ctx context.Context, caller Caller, after uint64, limit uint32) (*pb.CanvasEventPage, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	page, err := s.store.GetEvents(ctx, storage.EventQuery{After: after, Limit: pageSize(limit)})
	if err != nil {
		return nil, err
	}
	result := &pb.CanvasEventPage{
		NextCursor:    page.NextCursor,
		MinCursor:     page.MinCursor,
		HighWatermark: page.HighWatermark,
		HasMore:       page.HasMore,
	}
	switch page.Status {
	case storage.SnapshotRequired:
		result.Status = pb.CanvasCursorStatus_CANVAS_CURSOR_STATUS_SNAPSHOT_REQUIRED
		return result, nil
	case storage.CursorAhead:
		result.Status = pb.CanvasCursorStatus_CANVAS_CURSOR_STATUS_CURSOR_AHEAD
		return result, nil
	}
	result.Status = pb.CanvasCursorStatus_CANVAS_CURSOR_STATUS_OK
	for _, event := range page.Events {
		if event.WorkspaceID != caller.WorkspaceID {
			continue
		}
		envelope, err := envelope(event)
		if err != nil {
			return nil, err
		}
		if envelope == nil {
			continue
		}
		result.Events = append(result.Events, envelope)
	}
	return result, nil
}

// envelope converts one stored event. A kind this version does not publish
// returns nil rather than an envelope with an unspecified kind, so a client
// never has to guess what an empty payload meant.
func envelope(event storage.Event) (*pb.CanvasEventEnvelope, error) {
	kind := entityKind(event.Kind)
	if kind == pb.CanvasEntityKind_CANVAS_ENTITY_KIND_UNSPECIFIED {
		return nil, nil
	}
	result := &pb.CanvasEventEnvelope{
		Sequence:         event.Sequence,
		TransactionId:    event.TransactionID,
		OperationId:      event.OperationID,
		TransactionIndex: uint32(event.TransactionIndex),
		TransactionSize:  uint32(event.TransactionSize),
		WorkspaceId:      event.WorkspaceID,
		Kind:             kind,
		// The identifier the client sent, not the composed storage key.
		EntityId: objectID(event.ID),
		Revision: event.Revision,
		Deleted:  event.Deleted,
	}
	// A deletion carries no entity: the tombstone's revision and id are the
	// whole statement, and an empty decoded object would read like a cleared
	// node rather than a removed one.
	if event.Deleted {
		return result, nil
	}
	switch kind {
	case pb.CanvasEntityKind_CANVAS_ENTITY_KIND_WORKSPACE:
		value, err := decodeWorkspace(event.Entity)
		if err != nil {
			return nil, err
		}
		result.Entity = &pb.CanvasEventEnvelope_Workspace{Workspace: value}
	case pb.CanvasEntityKind_CANVAS_ENTITY_KIND_CANVAS:
		value, err := decodeCanvas(event.Entity)
		if err != nil {
			return nil, err
		}
		result.Entity = &pb.CanvasEventEnvelope_Canvas{Canvas: value}
	case pb.CanvasEntityKind_CANVAS_ENTITY_KIND_NODE:
		value, err := decodeNode(event.Entity)
		if err != nil {
			return nil, err
		}
		result.Entity = &pb.CanvasEventEnvelope_Node{Node: value}
	case pb.CanvasEntityKind_CANVAS_ENTITY_KIND_EDGE:
		value, err := decodeEdge(event.Entity)
		if err != nil {
			return nil, err
		}
		result.Entity = &pb.CanvasEventEnvelope_Edge{Edge: value}
	case pb.CanvasEntityKind_CANVAS_ENTITY_KIND_ANNOTATION:
		value, err := decodeAnnotation(event.Entity)
		if err != nil {
			return nil, err
		}
		result.Entity = &pb.CanvasEventEnvelope_Annotation{Annotation: value}
	}
	return result, nil
}

// GetSnapshot answers a client whose cursor fell behind the retained floor.
// It pages by canvas id so a large workspace does not have to arrive in one
// frame, and it reports the sequence the snapshot is consistent with. That
// sequence is read before the content, so resuming from it can only replay a
// change the snapshot already contains and never skip one.
func (s *Service) GetSnapshot(ctx context.Context, caller Caller, after string, limit uint32) (*pb.CanvasSnapshotResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	if after != "" && !validID(after) {
		return nil, ErrInvalid
	}
	_, sequence, err := s.store.Watermark(ctx)
	if err != nil {
		return nil, err
	}
	result := &pb.CanvasSnapshotResponse{Sequence: sequence, NextId: after}
	// The workspace record travels with the first page only; a continuation
	// already has it and re-sending it would look like a second change.
	if after == "" {
		entity, err := s.store.Read(ctx, workspaceKey(caller.WorkspaceID))
		if err == nil && !entity.Deleted {
			workspace, err := decodeWorkspace(entity)
			if err != nil {
				return nil, err
			}
			result.Workspaces = append(result.Workspaces, workspace)
		} else if err != nil && !isNotFound(err) {
			return nil, err
		}
	}
	page, err := s.store.List(ctx, storage.ListOptions{WorkspaceID: caller.WorkspaceID, Kind: KindCanvas, AfterID: after, Limit: pageSize(limit)})
	if err != nil {
		return nil, err
	}
	result.HasMore = page.HasMore
	result.NextId = page.NextID
	for _, entity := range page.Entities {
		canvas, err := decodeCanvas(entity)
		if err != nil {
			return nil, err
		}
		result.Canvases = append(result.Canvases, canvas)
		document, err := s.document(ctx, caller.WorkspaceID, canvas.CanvasId)
		if err != nil {
			return nil, err
		}
		result.Nodes = append(result.Nodes, document.Nodes...)
		result.Edges = append(result.Edges, document.Edges...)
		result.Annotations = append(result.Annotations, document.Annotations...)
	}
	return result, nil
}

func isNotFound(err error) bool { return errors.Is(err, storage.ErrNotFound) }
