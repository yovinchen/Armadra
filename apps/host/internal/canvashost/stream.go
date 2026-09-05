package canvashost

import (
	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// The canvas domain's contribution to the cross-domain event stream
// (host business migration §2.3).
//
// The stream and `CanvasService/SubscribeEvents` publish the *same* stored
// events; only the envelope differs. Projecting here rather than in the stream
// package is what keeps that true: one decoder, one set of rules about which
// kinds are publishable, so a client on the stream and a client on the HTTPS
// page can never see two different canvases.

// EventProjector publishes canvas entities onto the shared event stream. It
// holds no state; the Host assembles one and hands it to the hub.
type EventProjector struct{}

func (EventProjector) Domain() pb.EventDomain { return pb.EventDomain_EVENT_DOMAIN_CANVAS }

// streamKind names the entity in the domain's own vocabulary. The stream
// carries the name as a string so a new canvas entity does not need a wire
// change, while the stored kind keeps its `canvas.` prefix.
func streamKind(kind string) string {
	switch kind {
	case KindWorkspace:
		return "workspace"
	case KindCanvas:
		return "canvas"
	case KindNode:
		return "node"
	case KindEdge:
		return "edge"
	case KindAnnotation:
		return "annotation"
	}
	return ""
}

// Project converts one stored canvas event. A stored row this projector does
// not own — another domain's entity, or a kind this version does not publish —
// returns nil rather than an envelope with an unspecified kind, so a client
// never has to guess what an empty payload meant.
func (EventProjector) Project(event storage.Event) (*pb.EventEnvelope, error) {
	kind := streamKind(event.Kind)
	if kind == "" {
		return nil, nil
	}
	canvas, err := envelope(event)
	if err != nil {
		return nil, err
	}
	if canvas == nil {
		return nil, nil
	}
	result := &pb.EventEnvelope{
		Sequence:         canvas.Sequence,
		TransactionId:    canvas.TransactionId,
		OperationId:      canvas.OperationId,
		TransactionIndex: canvas.TransactionIndex,
		TransactionSize:  canvas.TransactionSize,
		WorkspaceId:      canvas.WorkspaceId,
		Domain:           pb.EventDomain_EVENT_DOMAIN_CANVAS,
		Kind:             kind,
		EntityId:         canvas.EntityId,
		Priority:         pb.EventPriority_EVENT_PRIORITY_NORMAL,
		Revision:         canvas.Revision,
		Deleted:          canvas.Deleted,
	}
	// A deletion carries no entity: the tombstone's id and revision are the
	// whole statement, and an empty decoded object would read like a cleared
	// node rather than a removed one.
	if canvas.Deleted {
		return result, nil
	}
	switch value := canvas.Entity.(type) {
	case *pb.CanvasEventEnvelope_Workspace:
		result.Entity = &pb.EventEnvelope_CanvasWorkspace{CanvasWorkspace: value.Workspace}
	case *pb.CanvasEventEnvelope_Canvas:
		result.Entity = &pb.EventEnvelope_Canvas{Canvas: value.Canvas}
	case *pb.CanvasEventEnvelope_Node:
		result.Entity = &pb.EventEnvelope_CanvasNode{CanvasNode: value.Node}
	case *pb.CanvasEventEnvelope_Edge:
		result.Entity = &pb.EventEnvelope_CanvasEdge{CanvasEdge: value.Edge}
	case *pb.CanvasEventEnvelope_Annotation:
		result.Entity = &pb.EventEnvelope_CanvasAnnotation{CanvasAnnotation: value.Annotation}
	}
	return result, nil
}
