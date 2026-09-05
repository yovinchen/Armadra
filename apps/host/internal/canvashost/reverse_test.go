package canvashost

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
)

// The rollback with a real reverse import (Go Host 业务所有权迁移 §2.12).
//
// The first phase's rollback wrote a package and stopped. What is covered here
// is the part that makes it a rollback: the package reaches the Runtime, the
// Runtime reports what it then holds, and the epoch moves only if those two
// descriptions agree.

// hostEdit makes a change that exists only on the Host, which is the whole
// reason a rollback needs a reverse import at all.
func hostEdit(t *testing.T, f *fixture, name string) {
	t.Helper()
	document := take(t, f)
	document.Canvas.Name = name
	if _, err := f.service.SaveDocument(fixtureContext, f.caller(ScopeRead, ScopeWrite), &pb.SaveCanvasDocumentRequest{
		OperationId: "host-edit-" + name, Canvas: document.Canvas, ExpectedRevision: document.Canvas.Revision,
		Nodes: document.Nodes, Edges: document.Edges, Annotations: document.Annotations,
	}); err != nil {
		t.Fatal(err)
	}
}

// rollback runs the canvas back through the generic state machine, which is
// the only implementation of the switch: the fake Runtime is both halves of the
// channel, exactly as the real Worker client is.
func rollback(t *testing.T, f *fixture, runtime *fakeRuntime, directory string, acceptExportOnly bool) (*pb.OwnershipSwitchResponse, error) {
	t.Helper()
	return f.switches.SwitchOffline(fixtureContext, ownership.Request{
		Domain:           Domain,
		Target:           pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME,
		Handoff:          runtime,
		Importer:         runtime,
		ExportDirectory:  directory,
		AcceptExportOnly: acceptExportOnly,
	})
}

// The change the Host made while it owned the canvas travels back, and the
// operator needs no flag to say they accept losing it.
func TestRollbackAppliesTheHostsChangesToTheRuntime(t *testing.T) {
	f, importID := migrated(t)
	runtime := newFakeRuntime()
	switchToHost(t, f, importID, runtime)
	hostEdit(t, f, "只在 Host 上改过")

	directory := filepath.Join(t.TempDir(), "reverse")
	result, err := rollback(t, f, runtime, directory, false)
	if err != nil {
		t.Fatalf("a rollback with a Host-side change was refused: %v", err)
	}
	if runtime.reverseCalls != 1 || runtime.reversePath != directory {
		t.Fatalf("the package did not reach the Runtime: %d call(s) at %q", runtime.reverseCalls, runtime.reversePath)
	}
	if result.Ownership.Owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME || result.Ownership.Epoch != 3 {
		t.Fatalf("the rollback settled on the wrong state: %v", result.Ownership)
	}
	// The identifier is the package's own index digest, so an interrupted
	// rollback that is re-run replays one import instead of starting a second.
	raw, err := os.ReadFile(filepath.Join(directory, ExportIndexFile))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.reverseImportID != hex.EncodeToString(digest(raw)) {
		t.Fatalf("the import identifier is not the package's index digest: %q", runtime.reverseImportID)
	}
	// The report names the comparison the handover rested on.
	found := map[string]bool{}
	for _, check := range result.Report.Checks {
		found[check.Check] = check.Matched
	}
	for _, name := range []string{"reverse.import", "reverse.workspaces", "reverse.unsupported_entity"} {
		if matched, ok := found[name]; !ok || !matched {
			t.Fatalf("the report is missing a matched %s check: %v", name, result.Report.Checks)
		}
	}
}

// An import that answered successfully while storing something else is the
// failure this whole comparison exists for.
func TestRollbackRefusesWhenTheRuntimeReadsBackSomethingElse(t *testing.T) {
	f, importID := migrated(t)
	runtime := newFakeRuntime()
	switchToHost(t, f, importID, runtime)
	hostEdit(t, f, "Host 的改动")
	runtime.reverseWrongDigest = true

	directory := filepath.Join(t.TempDir(), "reverse")
	result, err := rollback(t, f, runtime, directory, false)
	if !errors.Is(err, ownership.ErrReverseImportFailed) {
		t.Fatalf("a rollback the Runtime did not store was accepted: %v", err)
	}
	if result == nil || result.Report == nil || result.Report.Matched {
		t.Fatal("the refusal did not carry the report that explains it")
	}
	if runtime.owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST || runtime.epoch != 2 {
		t.Fatalf("the epoch moved despite the refusal: %v %d", runtime.owner, runtime.epoch)
	}
	status, err := f.service.Status(fixtureContext)
	if err != nil {
		t.Fatal(err)
	}
	if status.Owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST || status.Phase != pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_SETTLED {
		t.Fatalf("a refused rollback left the record moved: %v", status)
	}
	// The Host still owns the canvas, so nothing was lost: the operator fixes
	// the cause and runs the same rollback into a new directory.
	hostEdit(t, f, "回滚失败后仍能写入")
}

// An entity the Runtime cannot store blocks the handover even when every
// digest it did read back matches.
func TestRollbackRefusesAnUnsupportedEntity(t *testing.T) {
	f, importID := migrated(t)
	runtime := newFakeRuntime()
	switchToHost(t, f, importID, runtime)
	runtime.reverseIssue = "reverse.unsupported_entity"

	_, err := rollback(t, f, runtime, filepath.Join(t.TempDir(), "reverse"), false)
	if !errors.Is(err, ownership.ErrReverseImportFailed) {
		t.Fatalf("a package the Runtime could not fully apply was accepted: %v", err)
	}
	if runtime.owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST {
		t.Fatal("the epoch moved despite an unsupported entity")
	}
}

// A Worker that cannot import at all is refused before anything is written, so
// the operator is not left holding a package they have to reason about.
func TestRollbackRefusesAWorkerThatCannotImport(t *testing.T) {
	f, importID := migrated(t)
	runtime := newFakeRuntime()
	switchToHost(t, f, importID, runtime)
	runtime.reverseUnsupported = true

	directory := filepath.Join(t.TempDir(), "reverse")
	if _, err := rollback(t, f, runtime, directory, false); !errors.Is(err, ownership.ErrReverseImportUnsupported) {
		t.Fatalf("a rollback was planned against a Worker that cannot finish it: %v", err)
	}
	if _, err := os.Stat(directory); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the refusal still wrote an export package")
	}
	// The escape hatch stays available and stays explicit.
	if _, err := rollback(t, f, runtime, directory, true); err != nil {
		t.Fatalf("the acknowledged export-only rollback failed: %v", err)
	}
	if runtime.reverseCalls != 0 {
		t.Fatal("an export-only rollback still tried to import")
	}
	if runtime.owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME || runtime.epoch != 3 {
		t.Fatalf("the export-only rollback did not hand the epoch back: %v %d", runtime.owner, runtime.epoch)
	}
}

// The package the Runtime reads is described by the index, and the index has to
// say which format, which domain and which epoch it belongs to.
func TestTheExportIndexNamesItsFormatDomainAndEpoch(t *testing.T) {
	f, importID := migrated(t)
	runtime := newFakeRuntime()
	switchToHost(t, f, importID, runtime)
	directory := filepath.Join(t.TempDir(), "reverse")
	if _, err := rollback(t, f, runtime, directory, false); err != nil {
		t.Fatal(err)
	}
	index, indexDigest, err := readExportIndex(directory)
	if err != nil {
		t.Fatal(err)
	}
	if index.FormatVersion != 2 || index.Domain != ExportDomain || index.Epoch != 2 {
		t.Fatalf("the index does not describe this package: %+v", index)
	}
	if len(index.Files) != 1 || index.EntityCount == 0 || index.Files[0].EntityCount != index.EntityCount {
		t.Fatalf("the index does not count its own entities: %+v", index.Files)
	}
	// Every file carries two digests, and they describe different things: the
	// bytes on disk, and the canonical records inside them.
	payload, err := os.ReadFile(filepath.Join(directory, index.Files[0].Name))
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(digest(payload)) != index.Files[0].Sha256 {
		t.Fatal("the on-disk digest does not describe the file")
	}
	if index.Files[0].ContentSha256 == index.Files[0].Sha256 {
		t.Fatal("the canonical digest is the on-disk digest, so revisions were not cleared")
	}
	records, err := decodeFakeRecords(payload)
	if err != nil {
		t.Fatal(err)
	}
	content, err := canonicalDigest(records)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(content) != index.Files[0].ContentSha256 {
		t.Fatal("the canonical digest does not describe the records")
	}

	// An index edited after the package was written no longer hashes to what
	// the Runtime was told to expect, which is the point of sending the digest.
	raw, err := os.ReadFile(filepath.Join(directory, ExportIndexFile))
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(indexDigest) != hex.EncodeToString(digest(raw)) {
		t.Fatal("the index digest is not the digest of the index bytes")
	}
	var decoded map[string]any
	if err = json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, ok := decoded["contentSha256"]; ok {
		t.Fatal("the canonical digest belongs to a file, not to the index")
	}
}
