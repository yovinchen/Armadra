package canvashost

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

func nodeByID(document *pb.CanvasDocument, id string) *pb.CanvasNode {
	for _, node := range document.Nodes {
		if node.NodeId == id {
			return node
		}
	}
	return nil
}

func take(t *testing.T, f *fixture) *pb.CanvasDocument {
	t.Helper()
	result, err := f.service.GetDocument(fixtureContext, f.caller(ScopeRead), canvasID)
	if err != nil {
		t.Fatal(err)
	}
	return result.Document
}

// C02: a real Runtime export carrying tldraw drawings, an image asset, nested
// frames, a context link and a whiteboard snapshot must arrive on the Host with
// every one of those unchanged. Each assertion below is one acceptance item.
func TestMigratedCanvasMatchesTheExportItemByItem(t *testing.T) {
	f := newFixture(t)
	importID := f.stage()
	if _, err := f.service.Materialize(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	report, err := f.service.Verify(fixtureContext, importID)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Matched {
		for _, check := range report.Checks {
			if !check.Matched {
				t.Errorf("check %s: expected %d actual %d differences %v", check.Check, check.ExpectedCount, check.ActualCount, check.Differences)
			}
		}
		t.Fatal("a clean migration reported differences")
	}

	document := take(t, f)
	if document.Canvas.CanvasId != canvasID || document.Canvas.Name != "默认画布" || document.Canvas.SortOrder != 7 {
		t.Fatalf("canvas identity or ordering changed: %v", document.Canvas)
	}
	if v := document.Canvas.Viewport; v == nil || v.X != -12.5 || v.Y != 4.25 || v.Zoom != 1.5 {
		t.Fatalf("viewport changed: %v", document.Canvas.Viewport)
	}
	// The whiteboard is opaque: the bytes and the digest are what the export
	// recorded, and nothing on the Host re-serialized them.
	board := document.Canvas.Whiteboard
	digest := sha256.Sum256([]byte(whiteboardJSON))
	if board == nil || string(board.Snapshot) != whiteboardJSON || !bytes.Equal(board.Sha256, digest[:]) || board.Bytes != uint64(len(whiteboardJSON)) {
		t.Fatal("the whiteboard snapshot or its digest changed")
	}

	if len(document.Nodes) != 5 {
		t.Fatalf("expected five nodes, found %d", len(document.Nodes))
	}
	// Frame nesting survives all three levels.
	if node := nodeByID(document, innerFrame); node == nil || node.ParentId != outerFrame {
		t.Fatal("the inner frame lost its parent")
	}
	for _, id := range []string{terminalID, stickyID} {
		if node := nodeByID(document, id); node == nil || node.ParentId != innerFrame {
			t.Fatalf("node %s left its nested frame", id)
		}
	}
	if node := nodeByID(document, outerFrame); node == nil || node.ParentId != "" {
		t.Fatal("the outer frame gained a parent")
	}

	// Positions and sizes, including the difference between an absent size and
	// a zero one: the terminal node had no width or height in the source.
	sticky := nodeByID(document, stickyID)
	if sticky == nil || sticky.Position.X != 31.5 || sticky.Position.Y != -9.75 {
		t.Fatalf("sticky position changed: %v", sticky.GetPosition())
	}
	if sticky.Size == nil || sticky.Size.Width != 240 || sticky.Size.Height != 180 {
		t.Fatalf("sticky size changed: %v", sticky.GetSize())
	}
	terminal := nodeByID(document, terminalID)
	if terminal.Size != nil {
		t.Fatal("a node with no stored size gained one")
	}
	if terminal.Collapsed == nil || !terminal.GetCollapsed() {
		t.Fatal("the collapsed flag was lost")
	}
	if terminal.ExpandedHeight != nil {
		t.Fatal("an unset expanded height became a value")
	}

	// The context link keeps both endpoints.
	if len(document.Edges) != 1 {
		t.Fatalf("expected one context link, found %d", len(document.Edges))
	}
	edge := document.Edges[0]
	if edge.EdgeId != linkID || edge.SourceNodeId != terminalID || edge.TargetNodeId != stickyID || edge.Kind != pb.CanvasEdgeKind_CANVAS_EDGE_KIND_LINK {
		t.Fatalf("the context link changed: %v", edge)
	}

	// Labels and the header note travel as their own object, byte for byte.
	if len(document.Annotations) != 1 {
		t.Fatalf("expected one annotation, found %d", len(document.Annotations))
	}
	annotation := document.Annotations[0]
	var labels []string
	if err = json.Unmarshal([]byte(stickyLabels), &labels); err != nil {
		t.Fatal(err)
	}
	if annotation.NodeId != stickyID || annotation.Note != stickyNote || !equalStrings(annotation.Labels, labels) {
		t.Fatalf("the note or labels changed: %v", annotation)
	}

	// The image asset keeps its content digest and the node that referenced it.
	image := nodeByID(document, imageID)
	if len(image.Assets) != 1 {
		t.Fatalf("expected one asset reference, found %d", len(image.Assets))
	}
	assetDigest := sha256.Sum256(fixtureAsset)
	if image.Assets[0].RelativePath != ".armadra/assets/proof.png" || !bytes.Equal(image.Assets[0].Sha256, assetDigest[:]) || image.Assets[0].Bytes != uint64(len(fixtureAsset)) {
		t.Fatalf("the asset reference changed: %v", image.Assets[0])
	}
	if string(image.DataJson) != imageData {
		t.Fatal("the node payload was rewritten")
	}
}

// A difference is a failure. Removing one staged node has to surface as an
// unmatched report, not as a canvas that quietly lost a node.
func TestVerificationFailsWhenTheProjectionIsIncomplete(t *testing.T) {
	f := newFixture(t)
	importID := f.stage()
	if _, err := f.service.Materialize(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	key := objectKey(workspaceID, KindNode, canvasID, stickyID)
	entity, err := f.store.Read(fixtureContext, key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.Apply(fixtureContext, "test/drop-node", []storage.Change{{Key: key, ExpectedRevision: entity.Revision, Delete: true}}); err != nil {
		t.Fatal(err)
	}
	report, err := f.service.Verify(fixtureContext, importID)
	if err != nil {
		t.Fatal(err)
	}
	if report.Matched {
		t.Fatal("a canvas missing a node verified as consistent")
	}
	found := false
	for _, check := range report.Checks {
		if check.Check == "nodes" && !check.Matched {
			found = true
			for _, id := range check.Differences {
				if id == stickyID {
					return
				}
			}
		}
	}
	if !found {
		t.Fatal("the node check did not report the missing identifier")
	}
	t.Fatal("the missing node was not named in the report")
}

// A tampered asset must not migrate silently: the digest is re-computed from
// the staged file, and a mismatch stops the switch.
func TestVerificationFailsWhenAStagedAssetDiffers(t *testing.T) {
	f := newFixture(t)
	importID := f.stage()
	stage, err := f.store.GetStaging(fixtureContext, importID)
	if err != nil {
		t.Fatal(err)
	}
	staged := filepath.Join(f.dir, filepath.FromSlash(stage.RelativePath), "assets", "proof.png")
	if err = os.Chmod(staged, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(staged, []byte("different bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Materialize(fixtureContext, importID); !errors.Is(err, storage.ErrCorrupt) {
		t.Fatalf("a modified asset was accepted: %v", err)
	}
}

// Materialization is idempotent: running it twice produces no second write and
// therefore no second event, so a resumed switch does not churn history.
func TestMaterializeIsIdempotent(t *testing.T) {
	f := newFixture(t)
	importID := f.stage()
	if _, err := f.service.Materialize(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	_, first, err := f.store.Watermark(fixtureContext)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Materialize(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	_, second, err := f.store.Watermark(fixtureContext)
	if err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Fatalf("a repeated projection published %d extra events", second-first)
	}
}

func migrated(t *testing.T) (*fixture, string) {
	t.Helper()
	f := newFixture(t)
	importID := f.stage()
	if _, err := f.service.Materialize(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	return f, importID
}

// The Host serves reads before it owns writes — that is the whole point of the
// staged state — but every mutation is refused with one stable code.
func TestHostRefusesWritesUntilItOwnsTheDomain(t *testing.T) {
	f, _ := migrated(t)
	if _, err := f.service.GetDocument(fixtureContext, f.caller(ScopeRead), canvasID); err != nil {
		t.Fatalf("a read was refused while the Runtime owned writes: %v", err)
	}
	document := take(t, f)
	_, err := f.service.SaveDocument(fixtureContext, f.caller(ScopeRead, ScopeWrite), &pb.SaveCanvasDocumentRequest{
		OperationId:      "save-1",
		Canvas:           document.Canvas,
		ExpectedRevision: document.Canvas.Revision,
		Nodes:            document.Nodes,
		Edges:            document.Edges,
		Annotations:      document.Annotations,
	})
	if !errors.Is(err, ErrOwnershipMoved) {
		t.Fatalf("the Host accepted a write it does not own: %v", err)
	}
}

func switchToHost(t *testing.T, f *fixture, importID string, runtime *fakeRuntime) *pb.OwnershipSwitchResponse {
	t.Helper()
	result, err := f.switches.SwitchOffline(fixtureContext, ownership.Request{
		Domain:   Domain,
		Target:   pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST,
		ImportID: importID,
		Handoff:  runtime,
		Importer: runtime,
	})
	if err != nil {
		t.Fatalf("the switch failed: %v", err)
	}
	return result
}

func TestSwitchMovesTheEpochOnBothSides(t *testing.T) {
	f, importID := migrated(t)
	runtime := newFakeRuntime()
	result := switchToHost(t, f, importID, runtime)
	if result.Ownership.Owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST || result.Ownership.Phase != pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_SETTLED {
		t.Fatalf("the Host did not settle as the owner: %v", result.Ownership)
	}
	if result.Ownership.Epoch != 2 || runtime.epoch != 2 || runtime.owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST {
		t.Fatalf("the epoch did not advance on both sides: host %d runtime %d", result.Ownership.Epoch, runtime.epoch)
	}
	if result.Report == nil || !result.Report.Matched {
		t.Fatal("the switch did not carry the verification report it rested on")
	}
	// Writes now work, and CAS still applies.
	document := take(t, f)
	document.Canvas.Name = "改名后的画布"
	saved, err := f.service.SaveDocument(fixtureContext, f.caller(ScopeRead, ScopeWrite), &pb.SaveCanvasDocumentRequest{
		OperationId:      "rename-1",
		Canvas:           document.Canvas,
		ExpectedRevision: document.Canvas.Revision,
		Nodes:            document.Nodes,
		Edges:            document.Edges,
		Annotations:      document.Annotations,
	})
	if err != nil {
		t.Fatalf("the Host refused a write it owns: %v", err)
	}
	if saved.Document.Canvas.Name != "改名后的画布" || saved.Document.Canvas.Revision != document.Canvas.Revision+1 {
		t.Fatalf("the save did not advance the canvas revision: %v", saved.Document.Canvas)
	}
	if saved.Receipt.Replayed {
		t.Fatal("a first save reported itself as a replay")
	}
}

// An unverified import must not move anything, and the operator must be able to
// see which check failed.
func TestSwitchRefusesAnUnverifiedImport(t *testing.T) {
	f := newFixture(t)
	importID := f.stage()
	// Nothing was materialized on purpose in an earlier step; Switch does it,
	// so instead break one staged row so the projection cannot match.
	key := storage.Key{WorkspaceID: workspaceID, Kind: KindNode, ID: scoped(canvasID, "unexpected-node")}
	payload, err := encodeNode(&pb.CanvasNode{NodeId: "unexpected-node", CanvasId: canvasID, Type: "sticky", Position: &pb.CanvasPoint{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.Apply(fixtureContext, "test/extra-node", []storage.Change{{Key: key, Payload: payload}}); err != nil {
		t.Fatal(err)
	}
	runtime := newFakeRuntime()
	result, err := f.switches.SwitchOffline(fixtureContext, ownership.Request{
		Domain:   Domain,
		Target:   pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST,
		ImportID: importID,
		Handoff:  runtime,
	})
	if !errors.Is(err, ownership.ErrNotVerified) {
		t.Fatalf("an unverified import was allowed to switch: %v", err)
	}
	if result == nil || result.Report == nil || result.Report.Matched {
		t.Fatal("the refusal did not carry the report that caused it")
	}
	if runtime.setCalls != 0 {
		t.Fatal("the Runtime was told about a switch that never passed verification")
	}
	status, err := f.service.Status(fixtureContext)
	if err != nil {
		t.Fatal(err)
	}
	if status.Owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME || status.Phase != pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_SETTLED {
		t.Fatalf("a failed switch left ownership state behind: %v", status)
	}
}

// A lost reply is not a lost write. The Host asks the Runtime what it stored
// and converges, rather than guessing.
func TestSwitchResumesAfterALostReply(t *testing.T) {
	f, importID := migrated(t)
	runtime := newFakeRuntime()
	runtime.setErr = errors.New("pipe closed")
	runtime.applyBeforeError = true
	result, err := f.switches.SwitchOffline(fixtureContext, ownership.Request{
		Domain:   Domain,
		Target:   pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST,
		ImportID: importID,
		Handoff:  runtime,
	})
	if err != nil {
		t.Fatalf("a stored-but-unacknowledged handoff did not converge: %v", err)
	}
	if result.Ownership.Owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST || result.Ownership.Epoch != 2 {
		t.Fatalf("the resumed switch settled on the wrong state: %v", result.Ownership)
	}
}

// A handoff that never reached the Runtime restores the previous settled
// record, so there is no half-switched state to clean up by hand.
func TestSwitchRestoresTheRecordWhenTheRuntimeRefused(t *testing.T) {
	f, importID := migrated(t)
	runtime := newFakeRuntime()
	runtime.setErr = errors.New("refused")
	_, err := f.switches.SwitchOffline(fixtureContext, ownership.Request{
		Domain:   Domain,
		Target:   pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST,
		ImportID: importID,
		Handoff:  runtime,
	})
	if err == nil {
		t.Fatal("a refused handoff reported success")
	}
	status, err := f.service.Status(fixtureContext)
	if err != nil {
		t.Fatal(err)
	}
	if status.Owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME || status.Phase != pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_SETTLED {
		t.Fatalf("a refused switch left the record unsettled: %v", status)
	}
	if status.ReasonCode != ownership.ReasonFailed {
		t.Fatalf("the failure was not recorded: %s", status.ReasonCode)
	}
}

// When the Host cannot learn what the Runtime stored, the window stays open on
// purpose. Both sides keep refusing writes until an operator re-runs the switch.
func TestSwitchLeavesTheWindowOpenOnAnUnknownOutcome(t *testing.T) {
	f, importID := migrated(t)
	runtime := newFakeRuntime()
	request := ownership.Request{Domain: Domain, Target: pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST, ImportID: importID, Handoff: runtime}
	runtime.setErr = errors.New("pipe closed")
	runtime.applyBeforeError = true
	runtime.getErr = nil
	// The first Get succeeds (to read the current epoch), the second fails.
	failing := &failingSecondGet{fakeRuntime: runtime}
	request.Handoff = failing
	_, err := f.switches.SwitchOffline(fixtureContext, request)
	if !errors.Is(err, ownership.ErrUnknownOutcome) {
		t.Fatalf("an unreadable Runtime was treated as a definite answer: %v", err)
	}
	status, err := f.service.Status(fixtureContext)
	if err != nil {
		t.Fatal(err)
	}
	if status.Phase != pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_SWITCHING || status.ReasonCode != ownership.ReasonUnknown {
		t.Fatalf("the maintenance window was closed without an answer: %v", status)
	}
	// The Host still refuses writes while the window is open.
	document := take(t, f)
	_, err = f.service.SaveDocument(fixtureContext, f.caller(ScopeRead, ScopeWrite), &pb.SaveCanvasDocumentRequest{
		OperationId: "save-during-window", Canvas: document.Canvas, ExpectedRevision: document.Canvas.Revision,
		Nodes: document.Nodes, Edges: document.Edges, Annotations: document.Annotations,
	})
	if !errors.Is(err, ErrOwnershipMoved) {
		t.Fatalf("the Host wrote during an open maintenance window: %v", err)
	}
}

type failingSecondGet struct {
	*fakeRuntime
	calls int
}

func (f *failingSecondGet) GetWriteOwnership(ctx context.Context, domain string) (*pb.WorkerWriteOwnership, error) {
	f.calls++
	if f.calls > 1 {
		return nil, errors.New("pipe closed")
	}
	return f.fakeRuntime.GetWriteOwnership(ctx, domain)
}

// Rollback owes the Runtime an export and refuses without one.
func TestRollbackRequiresAReverseExport(t *testing.T) {
	f, importID := migrated(t)
	runtime := newFakeRuntime()
	switchToHost(t, f, importID, runtime)
	_, err := f.switches.SwitchOffline(fixtureContext, ownership.Request{
		Domain:   Domain,
		Target:   pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME,
		Handoff:  runtime,
		Importer: runtime,
	})
	if !errors.Is(err, ownership.ErrExportRequired) {
		t.Fatalf("a rollback without an export was accepted: %v", err)
	}
}

func TestRollbackReturnsWritesToTheRuntime(t *testing.T) {
	f, importID := migrated(t)
	runtime := newFakeRuntime()
	switchToHost(t, f, importID, runtime)
	directory := filepath.Join(t.TempDir(), "reverse")
	result, err := f.switches.SwitchOffline(fixtureContext, ownership.Request{
		Domain:          Domain,
		Target:          pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME,
		Handoff:         runtime,
		Importer:        runtime,
		ExportDirectory: directory,
	})
	if err != nil {
		t.Fatalf("the rollback failed: %v", err)
	}
	if result.Ownership.Owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME || result.Ownership.Epoch != 3 {
		t.Fatalf("the rollback settled on the wrong state: %v", result.Ownership)
	}
	if runtime.owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME || runtime.epoch != 3 {
		t.Fatalf("the Runtime was not told about the rollback: %v %d", runtime.owner, runtime.epoch)
	}
	// The Host refuses writes again, and its reads still work.
	document := take(t, f)
	_, err = f.service.SaveDocument(fixtureContext, f.caller(ScopeRead, ScopeWrite), &pb.SaveCanvasDocumentRequest{
		OperationId: "after-rollback", Canvas: document.Canvas, ExpectedRevision: document.Canvas.Revision,
		Nodes: document.Nodes, Edges: document.Edges, Annotations: document.Annotations,
	})
	if !errors.Is(err, ErrOwnershipMoved) {
		t.Fatalf("the Host kept writing after handing the epoch back: %v", err)
	}
	// The reverse package holds the canvas the Runtime has to take back.
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected one workspace file and one index, found %d", len(entries))
	}
}

// A Runtime reporting an older epoch than this Host already saw acknowledged is
// a restored or foreign database, and must not be switched silently.
func TestSwitchRefusesAStaleRuntime(t *testing.T) {
	f, importID := migrated(t)
	runtime := newFakeRuntime()
	switchToHost(t, f, importID, runtime)
	runtime.epoch = 1
	runtime.owner = pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME
	_, err := f.switches.SwitchOffline(fixtureContext, ownership.Request{
		Domain:          Domain,
		Target:          pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME,
		Handoff:         runtime,
		Importer:        runtime,
		ExportDirectory: filepath.Join(t.TempDir(), "reverse"),
	})
	if !errors.Is(err, ownership.ErrRuntimeStale) {
		t.Fatalf("a rewound Runtime was accepted: %v", err)
	}
}

func TestSwitchIsIdempotent(t *testing.T) {
	f, importID := migrated(t)
	runtime := newFakeRuntime()
	first := switchToHost(t, f, importID, runtime)
	second := switchToHost(t, f, importID, runtime)
	if !proto.Equal(first.Ownership, second.Ownership) {
		t.Fatalf("a repeated switch changed the record: %v then %v", first.Ownership, second.Ownership)
	}
	if runtime.setCalls != 1 {
		t.Fatalf("a repeated switch told the Runtime %d times", runtime.setCalls)
	}
}
