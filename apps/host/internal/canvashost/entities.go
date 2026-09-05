// Package canvashost is the Host's workspace and canvas business surface
// (H01 / C02). It stores canvas content as revisioned entities in the shared
// storage kernel, so every write is CAS-checked, receives an idempotency
// receipt and publishes its events from the same transaction.
//
// The package owns no execution. Terminals, files, Git and Hooks stay with the
// Rust Runtime whatever this package's ownership record says, and nothing here
// starts a process or touches a workspace directory.
package canvashost

import (
	"errors"
	"regexp"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const (
	ScopeRead  = "canvas:read"
	ScopeWrite = "canvas:write"

	KindWorkspace  = "canvas.workspace"
	KindCanvas     = "canvas.canvas"
	KindNode       = "canvas.node"
	KindEdge       = "canvas.edge"
	KindAnnotation = "canvas.annotation"

	// One save is one transaction, so it cannot exceed the kernel's change
	// ceiling. A save only carries what actually changed, which keeps ordinary
	// editing far below this; a document that genuinely needs more is refused
	// rather than split, because splitting would publish half a canvas.
	MaxDocumentChanges = storage.MaxChanges

	// The whiteboard snapshot is opaque bytes. This ceiling matches the web
	// client's own limit; the Host never parses what is inside it.
	MaxWhiteboardBytes = 8 << 20
	MaxNodeDataBytes   = 1 << 20
	MaxLabels          = 64
	MaxNoteBytes       = 8 << 10
	MaxAssetsPerNode   = 64
	MaxPage            = 500
)

var (
	ErrInvalid       = errors.New("invalid canvas request")
	ErrAuthorization = errors.New("canvas permission denied")
	// ErrOwnershipMoved is the stable refusal a write gets when this process is
	// not the current owner of the canvas domain, or while a switch is open.
	ErrOwnershipMoved = errors.New("ownership_moved")
	// ErrTooManyChanges means one request needs more changes than a single
	// transaction may carry. It is refused rather than split, because a split
	// save would publish half a canvas as if it were whole.
	ErrTooManyChanges = errors.New("canvas request exceeds one transaction")
)

// Identifiers are the ones the client already uses, so a migration keeps them
// unchanged. A separator is excluded because entity keys are composed with it.
var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$`)

func validID(value string) bool { return idPattern.MatchString(value) }

// scoped composes the storage entity id for an object that belongs to one
// canvas. The canvas prefix makes a canvas's objects a contiguous key range,
// so reading one document never scans another canvas's rows. Both halves are
// validated to exclude the separator, so the composition cannot be ambiguous.
func scoped(canvasID, objectID string) string { return canvasID + "/" + objectID }

// objectID recovers the client's own identifier from a scoped entity key. A
// canvas identifier cannot contain the separator, so the first one always ends
// the prefix; a key without one is returned unchanged, which is what the
// workspace and canvas kinds store.
func objectID(entityID string) string {
	if index := strings.IndexByte(entityID, '/'); index >= 0 {
		return entityID[index+1:]
	}
	return entityID
}

func workspaceKey(workspaceID string) storage.Key {
	return storage.Key{WorkspaceID: workspaceID, Kind: KindWorkspace, ID: workspaceID}
}
func canvasKey(workspaceID, canvasID string) storage.Key {
	return storage.Key{WorkspaceID: workspaceID, Kind: KindCanvas, ID: canvasID}
}
func objectKey(workspaceID, kind, canvasID, objectID string) storage.Key {
	return storage.Key{WorkspaceID: workspaceID, Kind: kind, ID: scoped(canvasID, objectID)}
}

// Payloads are stored without their revision: the storage kernel owns that
// number, and keeping a second copy inside the bytes would let the two drift.
// Marshalling is deterministic so an unchanged object produces identical bytes
// and therefore no event.
func encode(message proto.Message) ([]byte, error) {
	return (proto.MarshalOptions{Deterministic: true}).Marshal(message)
}

func encodeWorkspace(value *pb.CanvasWorkspace) ([]byte, error) {
	clone, _ := proto.Clone(value).(*pb.CanvasWorkspace)
	clone.Revision = 0
	return encode(clone)
}
func encodeCanvas(value *pb.Canvas) ([]byte, error) {
	clone, _ := proto.Clone(value).(*pb.Canvas)
	clone.Revision = 0
	return encode(clone)
}
func encodeNode(value *pb.CanvasNode) ([]byte, error) {
	clone, _ := proto.Clone(value).(*pb.CanvasNode)
	clone.Revision = 0
	return encode(clone)
}
func encodeEdge(value *pb.CanvasEdge) ([]byte, error) {
	clone, _ := proto.Clone(value).(*pb.CanvasEdge)
	clone.Revision = 0
	return encode(clone)
}
func encodeAnnotation(value *pb.CanvasAnnotation) ([]byte, error) {
	clone, _ := proto.Clone(value).(*pb.CanvasAnnotation)
	clone.Revision = 0
	return encode(clone)
}

func decodeWorkspace(entity storage.Entity) (*pb.CanvasWorkspace, error) {
	value := new(pb.CanvasWorkspace)
	if err := proto.Unmarshal(entity.Payload, value); err != nil {
		return nil, storage.ErrCorrupt
	}
	value.Revision = entity.Revision
	return value, nil
}
func decodeCanvas(entity storage.Entity) (*pb.Canvas, error) {
	value := new(pb.Canvas)
	if err := proto.Unmarshal(entity.Payload, value); err != nil {
		return nil, storage.ErrCorrupt
	}
	value.Revision = entity.Revision
	return value, nil
}
func decodeNode(entity storage.Entity) (*pb.CanvasNode, error) {
	value := new(pb.CanvasNode)
	if err := proto.Unmarshal(entity.Payload, value); err != nil {
		return nil, storage.ErrCorrupt
	}
	value.Revision = entity.Revision
	return value, nil
}
func decodeEdge(entity storage.Entity) (*pb.CanvasEdge, error) {
	value := new(pb.CanvasEdge)
	if err := proto.Unmarshal(entity.Payload, value); err != nil {
		return nil, storage.ErrCorrupt
	}
	value.Revision = entity.Revision
	return value, nil
}
func decodeAnnotation(entity storage.Entity) (*pb.CanvasAnnotation, error) {
	value := new(pb.CanvasAnnotation)
	if err := proto.Unmarshal(entity.Payload, value); err != nil {
		return nil, storage.ErrCorrupt
	}
	value.Revision = entity.Revision
	return value, nil
}

func entityKind(kind string) pb.CanvasEntityKind {
	switch kind {
	case KindWorkspace:
		return pb.CanvasEntityKind_CANVAS_ENTITY_KIND_WORKSPACE
	case KindCanvas:
		return pb.CanvasEntityKind_CANVAS_ENTITY_KIND_CANVAS
	case KindNode:
		return pb.CanvasEntityKind_CANVAS_ENTITY_KIND_NODE
	case KindEdge:
		return pb.CanvasEntityKind_CANVAS_ENTITY_KIND_EDGE
	case KindAnnotation:
		return pb.CanvasEntityKind_CANVAS_ENTITY_KIND_ANNOTATION
	default:
		return pb.CanvasEntityKind_CANVAS_ENTITY_KIND_UNSPECIFIED
	}
}

func validateWorkspace(value *pb.CanvasWorkspace) error {
	if value == nil || !validID(value.WorkspaceId) {
		return ErrInvalid
	}
	if len(value.Name) > 512 || len(value.RootPath) > 32768 || len(value.Color) > 64 {
		return ErrInvalid
	}
	if strings.ContainsRune(value.RootPath, 0) {
		return ErrInvalid
	}
	return nil
}

func validateCanvas(value *pb.Canvas, workspaceID string) error {
	if value == nil || !validID(value.CanvasId) || value.WorkspaceId != workspaceID {
		return ErrInvalid
	}
	if len(value.Name) > 512 {
		return ErrInvalid
	}
	if board := value.Whiteboard; board != nil {
		if len(board.Snapshot) > MaxWhiteboardBytes || len(board.EngineVersion) > 64 {
			return ErrInvalid
		}
		// A digest that does not describe the bytes is worse than none: a
		// migration compares digests, and a wrong one silently passes.
		if len(board.Sha256) != 0 && len(board.Sha256) != 32 {
			return ErrInvalid
		}
	}
	return nil
}

func validateNode(value *pb.CanvasNode, canvasID string) error {
	if value == nil || !validID(value.NodeId) || value.CanvasId != canvasID {
		return ErrInvalid
	}
	if value.ParentId != "" && (!validID(value.ParentId) || value.ParentId == value.NodeId) {
		return ErrInvalid
	}
	if len(value.Type) == 0 || len(value.Type) > 64 || len(value.Title) > 1024 || len(value.Color) > 64 {
		return ErrInvalid
	}
	if len(value.DataJson) > MaxNodeDataBytes || len(value.Assets) > MaxAssetsPerNode {
		return ErrInvalid
	}
	for _, asset := range value.Assets {
		if asset == nil || len(asset.RelativePath) == 0 || len(asset.RelativePath) > 4096 {
			return ErrInvalid
		}
		if len(asset.Sha256) != 32 {
			return ErrInvalid
		}
	}
	return nil
}

func validateEdge(value *pb.CanvasEdge, canvasID string) error {
	if value == nil || !validID(value.EdgeId) || value.CanvasId != canvasID {
		return ErrInvalid
	}
	if !validID(value.SourceNodeId) || !validID(value.TargetNodeId) || value.SourceNodeId == value.TargetNodeId {
		return ErrInvalid
	}
	// Only context links are persisted; derived rope and subagent edges are a
	// client-side projection and must not reach storage under a link's name.
	if value.Kind != pb.CanvasEdgeKind_CANVAS_EDGE_KIND_LINK {
		return ErrInvalid
	}
	return nil
}

func validateAnnotation(value *pb.CanvasAnnotation, canvasID string) error {
	if value == nil || !validID(value.AnnotationId) || value.CanvasId != canvasID || !validID(value.NodeId) {
		return ErrInvalid
	}
	if len(value.Labels) > MaxLabels || len(value.Note) > MaxNoteBytes {
		return ErrInvalid
	}
	for _, label := range value.Labels {
		if len(label) == 0 || len(label) > 128 {
			return ErrInvalid
		}
	}
	return nil
}
