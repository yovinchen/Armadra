package settingshost

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
)

// handback prepares a Host that owns the domain and holds a document, and
// returns the directory a rollback should write its package into.
func (f *fixture) handback() string {
	f.t.Helper()
	f.own()
	f.mustPut("save-1", baseDocument, 0)
	return filepath.Join(f.t.TempDir(), "export")
}

// The package the Runtime is owed: written, then read back off the disk and
// re-hashed, because a digest taken from the buffer that was just written
// proves nothing about what reached the disk.
func TestReleaseWritesAPackageAReaderCanVerify(t *testing.T) {
	f := newFixture(t)
	directory := f.handback()
	channel := &fakeChannel{}
	report, err := f.service.AsProjector().Release(t.Context(), ownership.Handback{Directory: directory, Epoch: 3, Importer: channel})
	if err != nil {
		t.Fatalf("handback refused: %v", err)
	}
	if !report.Matched {
		t.Fatalf("report: %+v", report)
	}
	document, hosts, err := ReadExportPackage(directory)
	if err != nil {
		t.Fatalf("the package this Host wrote does not read back: %v", err)
	}
	if string(document.Document) != baseDocument || len(hosts) != 1 || hosts[0].ExecutionHostId != "build-box" {
		t.Fatalf("the package carries %q and %+v", document.Document, hosts)
	}
	// The Runtime was asked to store exactly what the package holds, at the
	// epoch it names, under an identifier derived from the package itself.
	if len(channel.imported) != 1 {
		t.Fatalf("the Runtime was asked %d times", len(channel.imported))
	}
	request := channel.imported[0]
	if request.ExpectedEpoch != 3 || request.Direction != pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_IMPORT {
		t.Fatalf("the import request was %+v", request)
	}
	if len(request.ImportId) != 64 {
		t.Fatalf("the import id %q is not the package digest", request.ImportId)
	}
	for _, name := range []string{"settings.export", "reverse.settings.document_sha256", "reverse.settings.keys", "reverse.settings.execution_hosts", "reverse.event_sequence"} {
		if check := checkNamed(report, name); check == nil || !check.Matched {
			t.Fatalf("check %s came back as %+v", name, check)
		}
	}
}

// A directory that already holds something is refused: overwriting it would
// destroy the only copy of a previous reversal attempt.
func TestReleaseRefusesADirectoryThatIsNotEmpty(t *testing.T) {
	f := newFixture(t)
	directory := f.handback()
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "already-here"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := f.service.AsProjector().Release(t.Context(), ownership.Handback{Directory: directory, Epoch: 3, Importer: &fakeChannel{}})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("a non-empty directory was accepted: %v", err)
	}
	// A relative path is refused for the same reason it is everywhere else: it
	// would resolve against whatever the working directory happens to be.
	if _, err = f.service.AsProjector().Release(t.Context(), ownership.Handback{Directory: "export", Epoch: 3, Importer: &fakeChannel{}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a relative directory was accepted: %v", err)
	}
}

// The comparison is against the Runtime's own re-read. A Runtime that stored
// something else fails on the digest, and the epoch stays with the Host —
// which is the safe direction, because the Host still holds every row.
func TestReleaseRefusesWhenTheRuntimeStoredSomethingElse(t *testing.T) {
	f := newFixture(t)
	directory := f.handback()
	elsewhere := snapshotOf(strings.Replace(baseDocument, `"dark"`, `"light"`, 1), buildBox())
	elsewhere.Applied = true
	watermark := f.watermark()
	report, err := f.service.AsProjector().Release(t.Context(), ownership.Handback{Directory: directory, Epoch: 3, Importer: &fakeChannel{reread: elsewhere}})
	if !errors.Is(err, ownership.ErrReverseImportFailed) {
		t.Fatalf("a Runtime that stored something else was accepted: %v", err)
	}
	if report.Matched {
		t.Fatal("a failed handback reported a match")
	}
	check := checkNamed(report, "reverse.settings.document_sha256")
	if check == nil || check.Matched {
		t.Fatalf("the failing check came back as %+v", check)
	}
	if f.watermark() != watermark {
		t.Fatal("a failed handback wrote to the Host")
	}
}

// The danger switch stops after the export. It is the one path that leaves the
// Host's data only inside the package, so nothing must reach the Runtime.
func TestAcceptExportOnlyStopsAtThePackage(t *testing.T) {
	f := newFixture(t)
	directory := f.handback()
	channel := &fakeChannel{}
	report, err := f.service.AsProjector().Release(t.Context(), ownership.Handback{Directory: directory, Epoch: 3, AcceptExportOnly: true})
	if err != nil || !report.Matched {
		t.Fatalf("the export-only handback answered %v / %+v", err, report)
	}
	if len(channel.imported) != 0 {
		t.Fatal("the export-only handback still contacted the Runtime")
	}
	if checkNamed(report, "reverse.settings.document_sha256") != nil {
		t.Fatal("the export-only handback reported a comparison it never made")
	}
}

// A link that cannot carry a settings frame cannot complete a handback. The
// package is written and intact; the epoch has not moved.
func TestReleaseRefusesALinkWithoutTheSettingsFrames(t *testing.T) {
	f := newFixture(t)
	directory := f.handback()
	_, err := f.service.AsProjector().Release(t.Context(), ownership.Handback{Directory: directory, Epoch: 3, Importer: epochOnlyLink{}})
	if !errors.Is(err, ownership.ErrReverseImportUnsupported) {
		t.Fatalf("an epoch-only link was accepted: %v", err)
	}
	if _, _, err = ReadExportPackage(directory); err != nil {
		t.Fatalf("the package was not left intact: %v", err)
	}
}

// A package edited between writing and applying is refused by the reader rather
// than trusted because this Host wrote it.
func TestAnEditedPackageIsRefusedByItsOwnReader(t *testing.T) {
	f := newFixture(t)
	directory := f.handback()
	if _, err := f.service.AsProjector().Release(t.Context(), ownership.Handback{Directory: directory, Epoch: 3, AcceptExportOnly: true}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, ExportDocumentFile)
	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, append(stored, 0), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err = ReadExportPackage(directory); !errors.Is(err, ErrInvalid) {
		t.Fatalf("an edited package was accepted: %v", err)
	}
}

// A per-device overlay is not carried by the package, so a rollback names it
// rather than dropping a device's own keybinding layer in silence.
func TestReleaseRefusesToStrandADeviceOverlay(t *testing.T) {
	f := newFixture(t)
	directory := f.handback()
	overlay := document(`{"keybindings":{"device":{"toggle":"ctrl+k"}}}`)
	overlay.Scope = pb.SettingsScope_SETTINGS_SCOPE_DEVICE
	overlay.DeviceId = "device-1"
	if _, err := f.service.Put(t.Context(), f.caller, &pb.PutSettingsRequest{OperationId: "overlay", Document: overlay}); err != nil {
		t.Fatal(err)
	}
	report, err := f.service.AsProjector().Release(t.Context(), ownership.Handback{Directory: directory, Epoch: 3, AcceptExportOnly: true})
	if !errors.Is(err, ownership.ErrNotVerified) {
		t.Fatalf("a stranded overlay was exported silently: %v", err)
	}
	check := checkNamed(report, "settings.export")
	if check == nil || check.Matched || len(check.Differences) != 1 || check.Differences[0] != DevicePrefix+"device-1" {
		t.Fatalf("the failing check came back as %+v", check)
	}
}
