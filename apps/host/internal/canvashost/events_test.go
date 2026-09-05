package canvashost

import (
	"errors"
	"strings"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
)

// owned returns a fixture whose Host has already taken write ownership, which
// is the only state in which the save paths below are allowed to run.
func owned(t *testing.T) *fixture {
	t.Helper()
	f, importID := migrated(t)
	if _, err := f.service.Switch(fixtureContext, SwitchRequest{
		Target:   pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST,
		ImportID: importID,
		Handoff:  newFakeRuntime(),
	}); err != nil {
		t.Fatal(err)
	}
	return f
}

func save(t *testing.T, f *fixture, operation string, mutate func(*pb.CanvasDocument)) *pb.SaveCanvasDocumentResponse {
	t.Helper()
	document := take(t, f)
	mutate(document)
	result, err := f.service.SaveDocument(fixtureContext, f.caller(ScopeRead, ScopeWrite), &pb.SaveCanvasDocumentRequest{
		OperationId:      operation,
		Canvas:           document.Canvas,
		ExpectedRevision: document.Canvas.Revision,
		Nodes:            document.Nodes,
		Edges:            document.Edges,
		Annotations:      document.Annotations,
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// A save publishes only what changed, in one transaction, with contiguous
// sequences a subscriber can resume from.
func TestSavePublishesOnlyTheChangedObjects(t *testing.T) {
	f := owned(t)
	_, before, err := f.store.Watermark(fixtureContext)
	if err != nil {
		t.Fatal(err)
	}
	result := save(t, f, "move-sticky", func(document *pb.CanvasDocument) {
		nodeByID(document, stickyID).Position = &pb.CanvasPoint{X: 999.5, Y: -1.25}
	})
	if result.Receipt.LastSequence-result.Receipt.FirstSequence != 0 {
		t.Fatalf("moving one node published %d events", result.Receipt.LastSequence-result.Receipt.FirstSequence+1)
	}
	if result.Receipt.FirstSequence != before+1 {
		t.Fatalf("the event sequence jumped: %d after %d", result.Receipt.FirstSequence, before)
	}
	page, err := f.service.SubscribeEvents(fixtureContext, f.caller(ScopeRead), before, 100)
	if err != nil {
		t.Fatal(err)
	}
	if page.Status != pb.CanvasCursorStatus_CANVAS_CURSOR_STATUS_OK || len(page.Events) != 1 {
		t.Fatalf("expected one event, got %d with status %v", len(page.Events), page.Status)
	}
	event := page.Events[0]
	if event.Kind != pb.CanvasEntityKind_CANVAS_ENTITY_KIND_NODE || event.EntityId != stickyID {
		t.Fatalf("the event named the wrong object: %v %s", event.Kind, event.EntityId)
	}
	if event.GetNode().GetPosition().GetX() != 999.5 {
		t.Fatal("the event did not carry the new position")
	}
	if event.TransactionSize != 1 || event.TransactionIndex != 0 {
		t.Fatalf("transaction grouping is wrong: %d of %d", event.TransactionIndex, event.TransactionSize)
	}
}

// Saving the same document twice is not a change, so it publishes nothing and
// does not consume a sequence.
func TestUnchangedSavePublishesNothing(t *testing.T) {
	f := owned(t)
	_, before, err := f.store.Watermark(fixtureContext)
	if err != nil {
		t.Fatal(err)
	}
	result := save(t, f, "no-op", func(*pb.CanvasDocument) {})
	if !result.Receipt.Replayed || result.Receipt.LastSequence != 0 {
		t.Fatalf("an unchanged save claimed a transaction: %v", result.Receipt)
	}
	_, after, err := f.store.Watermark(fixtureContext)
	if err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("an unchanged save published %d events", after-before)
	}
}

// Replaying an operation id returns the original receipt; reusing it with
// different content is a conflict, never a second write.
func TestOperationIdIsAnIdempotencyKey(t *testing.T) {
	f := owned(t)
	first := save(t, f, "edit-1", func(document *pb.CanvasDocument) {
		document.Canvas.Name = "第一次改名"
	})
	document := take(t, f)
	// The same request again, with the revision the first save read.
	replay, err := f.service.SaveDocument(fixtureContext, f.caller(ScopeRead, ScopeWrite), &pb.SaveCanvasDocumentRequest{
		OperationId:      "edit-1",
		Canvas:           document.Canvas,
		ExpectedRevision: document.Canvas.Revision,
		Nodes:            document.Nodes,
		Edges:            document.Edges,
		Annotations:      document.Annotations,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !replay.Receipt.Replayed || replay.Receipt.LastSequence != 0 {
		// The content already matches, so the save is a no-op rather than a
		// stored-receipt replay. Either way it must not write again.
		if replay.Receipt.LastSequence != first.Receipt.LastSequence {
			t.Fatalf("a replayed save wrote again: %v", replay.Receipt)
		}
	}
	document.Canvas.Name = "不同的内容"
	_, err = f.service.SaveDocument(fixtureContext, f.caller(ScopeRead, ScopeWrite), &pb.SaveCanvasDocumentRequest{
		OperationId:      "edit-1",
		Canvas:           document.Canvas,
		ExpectedRevision: document.Canvas.Revision,
		Nodes:            document.Nodes,
		Edges:            document.Edges,
		Annotations:      document.Annotations,
	})
	if !errors.Is(err, storage.ErrIdempotencyConflict) {
		t.Fatalf("an operation id was reused for different content: %v", err)
	}
}

// A receipt is matched against the request that produced it, so it has to name
// the caller's own operation id — not the key the Host namespaced it into, which
// would also put this device's principal id in a response that needs no identity.
func TestReceiptEchoesTheCallerOperationId(t *testing.T) {
	f := owned(t)
	caller := f.caller(ScopeRead, ScopeWrite)
	changed := save(t, f, "edit-1", func(document *pb.CanvasDocument) {
		document.Canvas.Name = "改过的名字"
	})
	// Both paths through SaveDocument have to agree: the one that wrote a
	// transaction and the one that found nothing to change.
	unchanged := save(t, f, "edit-2", func(*pb.CanvasDocument) {})
	for expected, actual := range map[string]string{
		"edit-1": changed.Receipt.OperationId,
		"edit-2": unchanged.Receipt.OperationId,
	} {
		if actual != expected {
			t.Fatalf("expected operation id %q, got %q", expected, actual)
		}
		if strings.Contains(actual, caller.PrincipalID) || strings.Contains(actual, "canvas/") {
			t.Fatalf("the receipt leaked the composed storage key: %q", actual)
		}
	}
	document := take(t, f)
	deleted, err := f.service.DeleteCanvas(fixtureContext, caller, "drop-1", canvasID, document.Canvas.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if deleted.Receipt.OperationId != "drop-1" {
		t.Fatalf("a delete reported operation id %q", deleted.Receipt.OperationId)
	}
}

// A stale revision is a conflict that names what it saw, so a client can
// reload rather than retry blindly.
func TestConcurrentSaveIsAConflict(t *testing.T) {
	f := owned(t)
	stale := take(t, f)
	save(t, f, "first-writer", func(document *pb.CanvasDocument) {
		document.Canvas.Name = "先写的赢"
	})
	stale.Canvas.Name = "后写的输"
	_, err := f.service.SaveDocument(fixtureContext, f.caller(ScopeRead, ScopeWrite), &pb.SaveCanvasDocumentRequest{
		OperationId:      "second-writer",
		Canvas:           stale.Canvas,
		ExpectedRevision: stale.Canvas.Revision,
		Nodes:            stale.Nodes,
		Edges:            stale.Edges,
		Annotations:      stale.Annotations,
	})
	if !errors.Is(err, storage.ErrConflict) {
		t.Fatalf("a stale save overwrote a newer one: %v", err)
	}
}

// Removing a node from the document deletes it and its link, and the deletion
// travels as a tombstone rather than an empty node.
func TestRemovedObjectsBecomeTombstones(t *testing.T) {
	f := owned(t)
	_, before, err := f.store.Watermark(fixtureContext)
	if err != nil {
		t.Fatal(err)
	}
	document := take(t, f)
	nodes := []*pb.CanvasNode{}
	for _, node := range document.Nodes {
		if node.NodeId != stickyID {
			nodes = append(nodes, node)
		}
	}
	_, err = f.service.SaveDocument(fixtureContext, f.caller(ScopeRead, ScopeWrite), &pb.SaveCanvasDocumentRequest{
		OperationId:      "remove-sticky",
		Canvas:           document.Canvas,
		ExpectedRevision: document.Canvas.Revision,
		Nodes:            nodes,
	})
	if err != nil {
		t.Fatal(err)
	}
	page, err := f.service.SubscribeEvents(fixtureContext, f.caller(ScopeRead), before, 100)
	if err != nil {
		t.Fatal(err)
	}
	deletions := 0
	for _, event := range page.Events {
		if !event.Deleted {
			continue
		}
		deletions++
		if event.GetNode() != nil || event.GetEdge() != nil || event.GetAnnotation() != nil {
			t.Fatal("a tombstone carried an entity body")
		}
	}
	// The node, its annotation and the link that pointed at it.
	if deletions != 3 {
		t.Fatalf("expected three tombstones, found %d", deletions)
	}
	if nodeByID(take(t, f), stickyID) != nil {
		t.Fatal("the removed node is still served")
	}
}

// A cursor below the retained floor is answered with SNAPSHOT_REQUIRED, and the
// snapshot names the sequence to resume from. An empty page is never used to
// mean either of those.
func TestPrunedCursorAsksForASnapshot(t *testing.T) {
	f := owned(t)
	save(t, f, "edit-a", func(document *pb.CanvasDocument) { document.Canvas.Name = "A" })
	result := save(t, f, "edit-b", func(document *pb.CanvasDocument) { document.Canvas.Name = "B" })
	if err := f.store.PruneEvents(fixtureContext, result.Receipt.LastSequence); err != nil {
		t.Fatal(err)
	}
	page, err := f.service.SubscribeEvents(fixtureContext, f.caller(ScopeRead), 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if page.Status != pb.CanvasCursorStatus_CANVAS_CURSOR_STATUS_SNAPSHOT_REQUIRED {
		t.Fatalf("a pruned cursor was answered with %v", page.Status)
	}
	if page.MinCursor != result.Receipt.LastSequence {
		t.Fatalf("the retained floor was reported as %d", page.MinCursor)
	}
	snapshot, err := f.service.GetSnapshot(fixtureContext, f.caller(ScopeRead), "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Sequence < page.MinCursor {
		t.Fatal("the snapshot is older than the retention floor")
	}
	if len(snapshot.Workspaces) != 1 || len(snapshot.Canvases) != 1 || len(snapshot.Nodes) != 5 {
		t.Fatalf("the snapshot is incomplete: %d workspaces, %d canvases, %d nodes", len(snapshot.Workspaces), len(snapshot.Canvases), len(snapshot.Nodes))
	}
	// Resuming from the snapshot's sequence returns nothing new, not an error.
	resumed, err := f.service.SubscribeEvents(fixtureContext, f.caller(ScopeRead), snapshot.Sequence, 100)
	if err != nil {
		t.Fatal(err)
	}
	if resumed.Status != pb.CanvasCursorStatus_CANVAS_CURSOR_STATUS_OK || len(resumed.Events) != 0 {
		t.Fatalf("resuming from a snapshot replayed %d events with status %v", len(resumed.Events), resumed.Status)
	}
}

// A cursor beyond the watermark is a different Host or a restored database.
// Rewinding the client would silently drop what it already applied.
func TestCursorAheadIsNotRewound(t *testing.T) {
	f := owned(t)
	_, watermark, err := f.store.Watermark(fixtureContext)
	if err != nil {
		t.Fatal(err)
	}
	page, err := f.service.SubscribeEvents(fixtureContext, f.caller(ScopeRead), watermark+50, 100)
	if err != nil {
		t.Fatal(err)
	}
	if page.Status != pb.CanvasCursorStatus_CANVAS_CURSOR_STATUS_CURSOR_AHEAD || len(page.Events) != 0 {
		t.Fatalf("a cursor past the watermark was answered with %v", page.Status)
	}
	if page.HighWatermark != watermark {
		t.Fatalf("the watermark was reported as %d, not %d", page.HighWatermark, watermark)
	}
}

// Permissions are checked per operation, and a grant for another workspace does
// not reach this one.
func TestScopesNarrowTheSurface(t *testing.T) {
	f := owned(t)
	readOnly := f.caller(ScopeRead)
	document := take(t, f)
	_, err := f.service.SaveDocument(fixtureContext, readOnly, &pb.SaveCanvasDocumentRequest{
		OperationId: "no-write-scope", Canvas: document.Canvas, ExpectedRevision: document.Canvas.Revision, Nodes: document.Nodes,
	})
	if !errors.Is(err, ErrAuthorization) {
		t.Fatalf("a read-only device wrote: %v", err)
	}
	foreign := Caller{
		PrincipalID: "principal-1", DeviceID: "device-1", DeviceEpoch: 1, WorkspaceID: workspaceID,
		Scopes: []auth.Scope{{Permission: ScopeRead, WorkspaceID: "other-workspace", ExecutionHostID: fixtureHost}},
	}
	if _, err = f.service.GetDocument(fixtureContext, foreign, canvasID); !errors.Is(err, ErrAuthorization) {
		t.Fatalf("a grant for another workspace read this one: %v", err)
	}
}

// A link whose endpoints are not in the same save is refused rather than
// stored and hidden the next time the canvas is read.
func TestDanglingLinksAreRefused(t *testing.T) {
	f := owned(t)
	document := take(t, f)
	document.Edges = append(document.Edges, &pb.CanvasEdge{
		EdgeId: "edge-dangling", CanvasId: canvasID, SourceNodeId: stickyID, TargetNodeId: "missing-node",
		Kind: pb.CanvasEdgeKind_CANVAS_EDGE_KIND_LINK,
	})
	_, err := f.service.SaveDocument(fixtureContext, f.caller(ScopeRead, ScopeWrite), &pb.SaveCanvasDocumentRequest{
		OperationId: "dangling", Canvas: document.Canvas, ExpectedRevision: document.Canvas.Revision,
		Nodes: document.Nodes, Edges: document.Edges, Annotations: document.Annotations,
	})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("a dangling link was stored: %v", err)
	}
}

// A frame reference that names a node this save does not contain would leave a
// node nested inside nothing.
func TestOrphanedFrameNestingIsRefused(t *testing.T) {
	f := owned(t)
	document := take(t, f)
	nodeByID(document, stickyID).ParentId = "missing-frame"
	_, err := f.service.SaveDocument(fixtureContext, f.caller(ScopeRead, ScopeWrite), &pb.SaveCanvasDocumentRequest{
		OperationId: "orphan", Canvas: document.Canvas, ExpectedRevision: document.Canvas.Revision,
		Nodes: document.Nodes, Edges: document.Edges, Annotations: document.Annotations,
	})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("a node was nested inside a frame that does not exist: %v", err)
	}
}
