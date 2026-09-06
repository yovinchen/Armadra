package settingshost

import (
	"errors"
	"strings"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
)

// Taking settings over reads the Runtime's document across the live link and
// projects it. The report is what authorizes the epoch to move, so it compares
// the digest, the key set and the registry — all against what the Worker said,
// never against a restatement of what we just stored.
func TestAdoptProjectsTheRuntimeDocumentAndMatches(t *testing.T) {
	f := newFixture(t)
	channel := &fakeChannel{exported: snapshotOf(baseDocument, buildBox())}
	report, err := f.service.AsProjector().Adopt(t.Context(), ownership.Adoption{ImportID: "import-1", Link: channel})
	if err != nil {
		t.Fatalf("adoption refused: %v", err)
	}
	if !report.Matched || report.Domain != pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_SETTINGS {
		t.Fatalf("report: %+v", report)
	}
	for _, name := range []string{"settings.document_sha256", "settings.keys", "settings.execution_hosts"} {
		if check := checkNamed(report, name); check == nil || !check.Matched {
			t.Fatalf("check %s came back as %+v", name, check)
		}
	}
	if report.EntityCount != 2 {
		t.Fatalf("the adoption counted %d entities", report.EntityCount)
	}
	// The document is now readable through the ordinary surface.
	f.own()
	stored, err := f.get()
	if err != nil {
		t.Fatal(err)
	}
	if string(stored.Document.Document) != baseDocument {
		t.Fatalf("the adopted document reads back as %q", stored.Document.Document)
	}
}

// Re-running an interrupted switch must converge, not write a second time.
func TestAdoptIsSafeToRunAgain(t *testing.T) {
	f := newFixture(t)
	channel := &fakeChannel{exported: snapshotOf(baseDocument, buildBox())}
	projector := f.service.AsProjector()
	if _, err := projector.Adopt(t.Context(), ownership.Adoption{ImportID: "import-1", Link: channel}); err != nil {
		t.Fatal(err)
	}
	watermark := f.watermark()
	report, err := projector.Adopt(t.Context(), ownership.Adoption{ImportID: "import-1", Link: channel})
	if err != nil || !report.Matched {
		t.Fatalf("the second run answered %v / %+v", err, report)
	}
	if f.watermark() != watermark {
		t.Fatal("re-running the switch wrote the document a second time")
	}
}

// A Worker whose digest does not describe the bytes it sent is a difference the
// operator has to see named, not an opaque refusal — and the epoch must not move.
func TestAdoptReportsADigestTheWorkerGotWrong(t *testing.T) {
	f := newFixture(t)
	exported := snapshotOf(baseDocument, buildBox())
	exported.Document.Sha256 = digest([]byte("a different document"))
	report, err := f.service.AsProjector().Adopt(t.Context(), ownership.Adoption{ImportID: "import-1", Link: &fakeChannel{exported: exported}})
	if !errors.Is(err, ownership.ErrNotVerified) {
		t.Fatalf("a mismatched digest was accepted: %v", err)
	}
	check := checkNamed(report, "settings.document_sha256")
	if check == nil || check.Matched || len(check.Differences) != 1 || check.Differences[0] != GlobalEntityID {
		t.Fatalf("the failing check came back as %+v", check)
	}
	// The other two still ran: a report that stopped at the first difference
	// would send the operator back for a second run to learn the rest.
	if checkNamed(report, "settings.execution_hosts") == nil {
		t.Fatal("the report stopped after the first difference")
	}
}

// The registry is compared as two independent derivations. A Worker that
// derived a different Worker path is naming a different machine to start.
func TestAdoptReportsARegistryTheWorkerDerivedDifferently(t *testing.T) {
	f := newFixture(t)
	elsewhere := buildBox()
	elsewhere.Ssh.WorkerPath = "/somewhere/else/worker"
	report, err := f.service.AsProjector().Adopt(t.Context(), ownership.Adoption{ImportID: "import-1", Link: &fakeChannel{exported: snapshotOf(baseDocument, elsewhere)}})
	if !errors.Is(err, ownership.ErrNotVerified) {
		t.Fatalf("a differing registry was accepted: %v", err)
	}
	check := checkNamed(report, "settings.execution_hosts")
	if check == nil || check.Matched || len(check.Differences) != 1 || check.Differences[0] != "build-box" {
		t.Fatalf("the failing check came back as %+v", check)
	}
	// A difference names the host, never the path it disagreed about.
	for _, difference := range check.Differences {
		if strings.Contains(difference, "/") {
			t.Fatalf("a difference carried a path: %q", difference)
		}
	}
}

// A link that cannot carry a settings frame is refused before anything is
// written, so an operator is never left with rows from a switch that could not
// have completed.
func TestAdoptRefusesALinkWithoutTheSettingsFrames(t *testing.T) {
	f := newFixture(t)
	watermark := f.watermark()
	_, err := f.service.AsProjector().Adopt(t.Context(), ownership.Adoption{ImportID: "import-1", Link: epochOnlyLink{}})
	if !errors.Is(err, ownership.ErrUnsupportedDomain) {
		t.Fatalf("an epoch-only link was accepted: %v", err)
	}
	if f.watermark() != watermark {
		t.Fatal("a refused adoption still wrote something")
	}
}

// A document the Host cannot read structurally is refused before projection:
// there would be no registry to project it into.
func TestAdoptRefusesAnUnreadableDocument(t *testing.T) {
	f := newFixture(t)
	for name, exported := range map[string]*pb.WorkerSettingsSnapshot{
		"not an object":  snapshotOf(`["theme"]`),
		"unknown schema": schemaVersion(snapshotOf(baseDocument), 7),
		"a device overlay": func() *pb.WorkerSettingsSnapshot {
			value := snapshotOf(baseDocument)
			value.Document.Scope = pb.SettingsScope_SETTINGS_SCOPE_DEVICE
			value.Document.DeviceId = "device-1"
			return value
		}(),
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			if _, err := f.service.AsProjector().Adopt(t.Context(), ownership.Adoption{ImportID: "import-1", Link: &fakeChannel{exported: exported}}); !errors.Is(err, ErrInvalid) {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
	if f.watermark() != 0 {
		t.Fatal("a refused adoption wrote something")
	}
}

func schemaVersion(snapshot *pb.WorkerSettingsSnapshot, version uint32) *pb.WorkerSettingsSnapshot {
	snapshot.Document.SchemaVersion = version
	return snapshot
}
