package canvashost

import (
	"context"
	"errors"
	"strings"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
)

// Caller is the already-authenticated device. Nothing in a request supplies
// identity: the session does, and the scope in the request only selects which
// workspace is being asked about.
type Caller struct {
	PrincipalID string
	DeviceID    string
	DeviceEpoch uint64
	WorkspaceID string
	Scopes      []auth.Scope
}

type Options struct {
	Store  *storage.Store
	HostID string
	// Now exists so the switch state machine and its tests share one clock.
	Now func() time.Time
}

type Service struct {
	store   *storage.Store
	options Options
}

func New(options Options) (*Service, error) {
	if options.Store == nil || len(options.HostID) != 32 {
		return nil, ErrInvalid
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Service{store: options.Store, options: options}, nil
}

func (s *Service) now() int64 { return s.options.Now().UnixMilli() }

func (c Caller) valid() bool {
	return c.PrincipalID != "" && c.DeviceID != "" && c.DeviceEpoch > 0 && validID(c.WorkspaceID) && len(c.Scopes) > 0
}

// authorize checks the verified session's own grants for this workspace and
// this Host. An empty or host-wide request is never widened here.
func (s *Service) authorize(caller Caller, permission string) error {
	if s == nil {
		return ErrAuthorization
	}
	if !caller.valid() {
		return ErrAuthorization
	}
	if !auth.Permits(caller.Scopes, []auth.Scope{{Permission: permission, WorkspaceID: caller.WorkspaceID, ExecutionHostID: s.options.HostID}}) {
		return ErrAuthorization
	}
	return nil
}

// authorizeWrite additionally refuses when this Host is not the settled owner
// of the canvas domain. There is no dual-write mode: while the Runtime owns
// the domain, or while a switch is open, the Host serves reads and refuses
// every mutation with one stable code.
func (s *Service) authorizeWrite(ctx context.Context, caller Caller) error {
	if err := s.authorize(caller, ScopeWrite); err != nil {
		return err
	}
	record, err := s.store.Ownership(ctx, storage.OwnershipDomainCanvas)
	if errors.Is(err, storage.ErrNotFound) {
		// No switch has ever been recorded, so the Runtime still owns writes.
		return ErrOwnershipMoved
	}
	if err != nil {
		return err
	}
	if record.Owner != storage.OwnerHost || record.Phase != storage.OwnershipSettled {
		return ErrOwnershipMoved
	}
	return nil
}

func pageSize(limit uint32) int {
	if limit == 0 {
		return 100
	}
	if limit > MaxPage {
		return MaxPage
	}
	return int(limit)
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

// ListWorkspaces answers with the caller's own workspace only. The canvas
// surface is workspace-scoped end to end: a device granted one workspace must
// not learn that other workspaces exist by reading an empty page for them.
func (s *Service) ListWorkspaces(ctx context.Context, caller Caller, after string, limit uint32) (*pb.ListCanvasWorkspacesResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	if after != "" && !validID(after) {
		return nil, ErrInvalid
	}
	page, err := s.store.List(ctx, storage.ListOptions{WorkspaceID: caller.WorkspaceID, Kind: KindWorkspace, AfterID: after, Limit: pageSize(limit)})
	if err != nil {
		return nil, err
	}
	result := &pb.ListCanvasWorkspacesResponse{NextId: page.NextID, HasMore: page.HasMore}
	for _, entity := range page.Entities {
		workspace, err := decodeWorkspace(entity)
		if err != nil {
			return nil, err
		}
		result.Workspaces = append(result.Workspaces, workspace)
	}
	return result, nil
}

func (s *Service) PutWorkspace(ctx context.Context, caller Caller, operationID string, workspace *pb.CanvasWorkspace, expected uint64) (*pb.PutCanvasWorkspaceResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	if err := validateWorkspace(workspace); err != nil {
		return nil, err
	}
	if workspace.WorkspaceId != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	payload, err := encodeWorkspace(workspace)
	if err != nil {
		return nil, err
	}
	result, err := s.apply(ctx, caller, operationID, []storage.Change{{Key: workspaceKey(caller.WorkspaceID), ExpectedRevision: expected, Payload: payload}})
	if err != nil {
		return nil, err
	}
	stored, err := s.store.Read(ctx, workspaceKey(caller.WorkspaceID))
	if err != nil {
		return nil, err
	}
	saved, err := decodeWorkspace(stored)
	if err != nil {
		return nil, err
	}
	return &pb.PutCanvasWorkspaceResponse{Workspace: saved, Receipt: receipt(result)}, nil
}

// DeleteCanvasWorkspace removes the workspace record and every canvas, node,
// edge and annotation under it in one transaction, leaving revisioned
// tombstones. Nothing under the workspace's root path is read or removed: this
// deletes the Host's record of a project, never the project.
func (s *Service) DeleteWorkspace(ctx context.Context, caller Caller, operationID, workspaceID string, expected uint64) (*pb.DeleteCanvasWorkspaceResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	if workspaceID != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	changes := []storage.Change{}
	for _, kind := range []string{KindNode, KindEdge, KindAnnotation, KindCanvas} {
		entities, err := s.collect(ctx, caller.WorkspaceID, kind, "")
		if err != nil {
			return nil, err
		}
		for _, entity := range entities {
			changes = append(changes, storage.Change{Key: entity.Key, ExpectedRevision: entity.Revision, Delete: true})
		}
	}
	changes = append(changes, storage.Change{Key: workspaceKey(workspaceID), ExpectedRevision: expected, Delete: true})
	if len(changes) > MaxDocumentChanges {
		return nil, storage.ErrInvalid
	}
	result, err := s.apply(ctx, caller, operationID, changes)
	if err != nil {
		return nil, err
	}
	return &pb.DeleteCanvasWorkspaceResponse{WorkspaceId: workspaceID, Receipt: receipt(result)}, nil
}

// ---------------------------------------------------------------------------
// Canvases and documents
// ---------------------------------------------------------------------------

func (s *Service) ListCanvases(ctx context.Context, caller Caller, after string, limit uint32) (*pb.ListCanvasesResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	if after != "" && !validID(after) {
		return nil, ErrInvalid
	}
	page, err := s.store.List(ctx, storage.ListOptions{WorkspaceID: caller.WorkspaceID, Kind: KindCanvas, AfterID: after, Limit: pageSize(limit)})
	if err != nil {
		return nil, err
	}
	result := &pb.ListCanvasesResponse{NextId: page.NextID, HasMore: page.HasMore}
	for _, entity := range page.Entities {
		canvas, err := decodeCanvas(entity)
		if err != nil {
			return nil, err
		}
		result.Canvases = append(result.Canvases, canvas)
	}
	return result, nil
}

// collect walks every live entity of one kind, optionally restricted to one
// canvas's contiguous key range. Deleted tombstones are skipped: a caller that
// needs to know a key once existed reads the event stream, not this listing.
func (s *Service) collect(ctx context.Context, workspaceID, kind, canvasID string) ([]storage.Entity, error) {
	prefix := ""
	after := ""
	if canvasID != "" {
		prefix = canvasID + "/"
		after = prefix
	}
	result := []storage.Entity{}
	for {
		page, err := s.store.List(ctx, storage.ListOptions{WorkspaceID: workspaceID, Kind: kind, AfterID: after, Limit: storage.MaxPageSize})
		if err != nil {
			return nil, err
		}
		for _, entity := range page.Entities {
			if prefix != "" && !strings.HasPrefix(entity.ID, prefix) {
				return result, nil
			}
			result = append(result, entity)
		}
		if !page.HasMore || page.NextID == after {
			return result, nil
		}
		after = page.NextID
	}
}

func (s *Service) document(ctx context.Context, workspaceID, canvasID string) (*pb.CanvasDocument, error) {
	entity, err := s.store.Read(ctx, canvasKey(workspaceID, canvasID))
	if err != nil {
		return nil, err
	}
	if entity.Deleted {
		return nil, storage.ErrNotFound
	}
	canvas, err := decodeCanvas(entity)
	if err != nil {
		return nil, err
	}
	document := &pb.CanvasDocument{Canvas: canvas}
	nodes, err := s.collect(ctx, workspaceID, KindNode, canvasID)
	if err != nil {
		return nil, err
	}
	for _, item := range nodes {
		node, err := decodeNode(item)
		if err != nil {
			return nil, err
		}
		document.Nodes = append(document.Nodes, node)
	}
	edges, err := s.collect(ctx, workspaceID, KindEdge, canvasID)
	if err != nil {
		return nil, err
	}
	for _, item := range edges {
		edge, err := decodeEdge(item)
		if err != nil {
			return nil, err
		}
		document.Edges = append(document.Edges, edge)
	}
	annotations, err := s.collect(ctx, workspaceID, KindAnnotation, canvasID)
	if err != nil {
		return nil, err
	}
	for _, item := range annotations {
		annotation, err := decodeAnnotation(item)
		if err != nil {
			return nil, err
		}
		document.Annotations = append(document.Annotations, annotation)
	}
	// The sequence is read after the content, so resuming from it can only
	// replay a change the reader may already hold — never skip one.
	_, last, err := s.store.Watermark(ctx)
	if err != nil {
		return nil, err
	}
	document.EventSequence = last
	return document, nil
}

func (s *Service) GetDocument(ctx context.Context, caller Caller, canvasID string) (*pb.GetCanvasDocumentResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	if !validID(canvasID) {
		return nil, ErrInvalid
	}
	document, err := s.document(ctx, caller.WorkspaceID, canvasID)
	if err != nil {
		return nil, err
	}
	return &pb.GetCanvasDocumentResponse{Document: document}, nil
}

// SaveDocument stores the canvas row, its nodes, edges and annotations in one
// transaction. Only what actually changed becomes a change: an object whose
// bytes are identical produces no write and no event, which keeps a save that
// moved one node from republishing an entire canvas.
//
// Objects present in storage but absent from the request are deleted, so a
// save is the whole document, not a partial merge. Every change carries the
// revision the client read, so a concurrent editor's write is a CONFLICT
// rather than a silent overwrite.
func (s *Service) SaveDocument(ctx context.Context, caller Caller, request *pb.SaveCanvasDocumentRequest) (*pb.SaveCanvasDocumentResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	if request == nil || request.Canvas == nil {
		return nil, ErrInvalid
	}
	canvas := request.Canvas
	if err := validateCanvas(canvas, caller.WorkspaceID); err != nil {
		return nil, err
	}
	changes, err := s.documentChanges(ctx, caller.WorkspaceID, request)
	if err != nil {
		return nil, err
	}
	if len(changes) > MaxDocumentChanges {
		return nil, storage.ErrInvalid
	}
	// A save whose content already matched storage leaves it untouched, and the
	// receipt says so explicitly rather than inventing a transaction id.
	stored := &pb.CanvasOperationReceipt{OperationId: request.OperationId, Replayed: true}
	if len(changes) > 0 {
		result, err := s.apply(ctx, caller, request.OperationId, changes)
		if err != nil {
			return nil, err
		}
		stored = receipt(result)
	}
	document, err := s.document(ctx, caller.WorkspaceID, canvas.CanvasId)
	if err != nil {
		return nil, err
	}
	return &pb.SaveCanvasDocumentResponse{Document: document, Receipt: stored}, nil
}

func (s *Service) documentChanges(ctx context.Context, workspaceID string, request *pb.SaveCanvasDocumentRequest) ([]storage.Change, error) {
	canvas := request.Canvas
	changes := []storage.Change{}
	payload, err := encodeCanvas(canvas)
	if err != nil {
		return nil, err
	}
	existing, err := s.store.Read(ctx, canvasKey(workspaceID, canvas.CanvasId))
	switch {
	case errors.Is(err, storage.ErrNotFound):
		if request.ExpectedRevision != 0 {
			return nil, storage.ErrConflict
		}
		changes = append(changes, storage.Change{Key: canvasKey(workspaceID, canvas.CanvasId), Payload: payload})
	case err != nil:
		return nil, err
	default:
		if existing.Revision != request.ExpectedRevision {
			return nil, &storage.RevisionConflict{Key: canvasKey(workspaceID, canvas.CanvasId), Expected: request.ExpectedRevision, Actual: existing.Revision}
		}
		if existing.Deleted || string(existing.Payload) != string(payload) {
			changes = append(changes, storage.Change{Key: canvasKey(workspaceID, canvas.CanvasId), ExpectedRevision: existing.Revision, Payload: payload})
		}
	}

	seen := map[storage.Key]bool{}
	add := func(key storage.Key, expected uint64, payload []byte) error {
		if seen[key] {
			return ErrInvalid
		}
		seen[key] = true
		current, err := s.store.Read(ctx, key)
		switch {
		case errors.Is(err, storage.ErrNotFound):
			if expected != 0 {
				return storage.ErrConflict
			}
			changes = append(changes, storage.Change{Key: key, Payload: payload})
			return nil
		case err != nil:
			return err
		}
		if current.Revision != expected {
			return &storage.RevisionConflict{Key: key, Expected: expected, Actual: current.Revision}
		}
		if current.Deleted || string(current.Payload) != string(payload) {
			changes = append(changes, storage.Change{Key: key, ExpectedRevision: current.Revision, Payload: payload})
		}
		return nil
	}

	nodeIDs := map[string]bool{}
	for _, node := range request.Nodes {
		if err = validateNode(node, canvas.CanvasId); err != nil {
			return nil, err
		}
		nodeIDs[node.NodeId] = true
	}
	// A frame reference that names a node this save does not contain would
	// leave the canvas with a nested node whose parent does not exist.
	for _, node := range request.Nodes {
		if node.ParentId != "" && !nodeIDs[node.ParentId] {
			return nil, ErrInvalid
		}
	}
	for _, node := range request.Nodes {
		encoded, err := encodeNode(node)
		if err != nil {
			return nil, err
		}
		if err = add(objectKey(workspaceID, KindNode, canvas.CanvasId, node.NodeId), node.Revision, encoded); err != nil {
			return nil, err
		}
	}
	for _, edge := range request.Edges {
		if err = validateEdge(edge, canvas.CanvasId); err != nil {
			return nil, err
		}
		// A dangling link is refused rather than stored and hidden later.
		if !nodeIDs[edge.SourceNodeId] || !nodeIDs[edge.TargetNodeId] {
			return nil, ErrInvalid
		}
		encoded, err := encodeEdge(edge)
		if err != nil {
			return nil, err
		}
		if err = add(objectKey(workspaceID, KindEdge, canvas.CanvasId, edge.EdgeId), edge.Revision, encoded); err != nil {
			return nil, err
		}
	}
	for _, annotation := range request.Annotations {
		if err = validateAnnotation(annotation, canvas.CanvasId); err != nil {
			return nil, err
		}
		if !nodeIDs[annotation.NodeId] {
			return nil, ErrInvalid
		}
		encoded, err := encodeAnnotation(annotation)
		if err != nil {
			return nil, err
		}
		if err = add(objectKey(workspaceID, KindAnnotation, canvas.CanvasId, annotation.AnnotationId), annotation.Revision, encoded); err != nil {
			return nil, err
		}
	}

	for _, kind := range []string{KindNode, KindEdge, KindAnnotation} {
		entities, err := s.collect(ctx, workspaceID, kind, canvas.CanvasId)
		if err != nil {
			return nil, err
		}
		for _, entity := range entities {
			if seen[entity.Key] {
				continue
			}
			changes = append(changes, storage.Change{Key: entity.Key, ExpectedRevision: entity.Revision, Delete: true})
		}
	}
	return changes, nil
}

func (s *Service) DeleteCanvas(ctx context.Context, caller Caller, operationID, canvasID string, expected uint64) (*pb.DeleteCanvasResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	if !validID(canvasID) {
		return nil, ErrInvalid
	}
	changes := []storage.Change{}
	for _, kind := range []string{KindNode, KindEdge, KindAnnotation} {
		entities, err := s.collect(ctx, caller.WorkspaceID, kind, canvasID)
		if err != nil {
			return nil, err
		}
		for _, entity := range entities {
			changes = append(changes, storage.Change{Key: entity.Key, ExpectedRevision: entity.Revision, Delete: true})
		}
	}
	changes = append(changes, storage.Change{Key: canvasKey(caller.WorkspaceID, canvasID), ExpectedRevision: expected, Delete: true})
	if len(changes) > MaxDocumentChanges {
		return nil, storage.ErrInvalid
	}
	result, err := s.apply(ctx, caller, operationID, changes)
	if err != nil {
		return nil, err
	}
	return &pb.DeleteCanvasResponse{CanvasId: canvasID, Receipt: receipt(result)}, nil
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

// operationKey namespaces the caller-supplied id by principal and workspace, so
// two devices cannot collide on a plain "save-1" and a replay is only ever
// matched against the same principal's own earlier request. The id is an
// idempotency key, never an authorization token.
func operationKey(caller Caller, operationID string) (string, error) {
	if operationID == "" || len(operationID) > 200 || strings.ContainsAny(operationID, "\x00\n") {
		return "", ErrInvalid
	}
	return "canvas/" + caller.PrincipalID + "/" + caller.WorkspaceID + "/" + operationID, nil
}

func (s *Service) apply(ctx context.Context, caller Caller, operationID string, changes []storage.Change) (storage.ApplyResult, error) {
	key, err := operationKey(caller, operationID)
	if err != nil {
		return storage.ApplyResult{}, err
	}
	return s.store.Apply(ctx, key, changes)
}

func receipt(result storage.ApplyResult) *pb.CanvasOperationReceipt {
	value := &pb.CanvasOperationReceipt{
		OperationId:   result.OperationID,
		TransactionId: result.TransactionID,
		FirstSequence: result.FirstSequence,
		LastSequence:  result.LastSequence,
		Replayed:      result.Replayed,
	}
	for _, revision := range result.Revisions {
		id := revision.ID
		if kind := entityKind(revision.Kind); kind == pb.CanvasEntityKind_CANVAS_ENTITY_KIND_NODE || kind == pb.CanvasEntityKind_CANVAS_ENTITY_KIND_EDGE || kind == pb.CanvasEntityKind_CANVAS_ENTITY_KIND_ANNOTATION {
			if index := strings.IndexByte(id, '/'); index >= 0 {
				id = id[index+1:]
			}
		}
		value.Revisions = append(value.Revisions, &pb.CanvasRevision{Kind: entityKind(revision.Kind), EntityId: id, Revision: revision.Revision, Deleted: revision.Deleted})
	}
	return value
}
