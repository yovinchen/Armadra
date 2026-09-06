package fshost

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
	"google.golang.org/protobuf/proto"
)

// runtime stands in for the Runtime at the other end of the Worker channel. It
// reads the package the Host wrote, "applies" it by remembering the roots, and
// answers both halves of the handback: the import report and, separately, its
// own reading of its rows.
type runtime struct {
	stored     map[string]*pb.WorkspaceRoot
	refuseRead bool
	drop       string
	issue      string
}

func newRuntime() *runtime { return &runtime{stored: map[string]*pb.WorkspaceRoot{}} }

func (r *runtime) SupportsReverseImport() bool { return true }

func (r *runtime) ApplyReverseExport(_ context.Context, domain, path string, index []byte, epoch uint64, importID string) (*pb.ReverseImportReport, error) {
	if domain != ExportDomain {
		return nil, errors.New("wrong domain")
	}
	raw, err := os.ReadFile(filepath.Join(path, ExportIndexFile))
	if err != nil {
		return nil, err
	}
	parsed := new(exportIndex)
	if err = json.Unmarshal(raw, parsed); err != nil {
		return nil, err
	}
	report := &pb.ReverseImportReport{
		ImportId:    importID,
		Domain:      domain,
		Epoch:       parsed.Epoch,
		IndexSha256: index,
		EntityCount: parsed.EntityCount,
	}
	for _, file := range parsed.Files {
		payload, err := os.ReadFile(filepath.Join(path, file.Name))
		if err != nil {
			return nil, err
		}
		// The entity file is a four-byte length prefix and one record.
		record := new(pb.ReverseExportRecord)
		if err = proto.Unmarshal(payload[4:4+binary.BigEndian.Uint32(payload[:4])], record); err != nil {
			return nil, err
		}
		root := record.GetWorkspaceRoot()
		if root == nil {
			return nil, errors.New("a filesystem package carried something else")
		}
		r.stored[root.GetWorkspaceId()] = root
		content := file.ContentSha256
		if r.drop == root.GetWorkspaceId() {
			continue
		}
		digest := make([]byte, 32)
		for index := 0; index < 32; index++ {
			digest[index] = hexNibble(content[index*2])<<4 | hexNibble(content[index*2+1])
		}
		report.Reexported = append(report.Reexported, &pb.ReverseExportFile{
			Name:          file.Name,
			WorkspaceId:   root.GetWorkspaceId(),
			ContentSha256: digest,
			EntityCount:   file.EntityCount,
		})
	}
	if r.issue != "" {
		report.Issues = append(report.Issues, &pb.ExportIssue{Code: r.issue, Severity: "error"})
	}
	return report, nil
}

func hexNibble(value byte) byte {
	switch {
	case value >= '0' && value <= '9':
		return value - '0'
	case value >= 'a' && value <= 'f':
		return value - 'a' + 10
	default:
		return 0
	}
}

func (r *runtime) WorkspaceRoots(context.Context) ([]*pb.WorkspaceRoot, error) {
	if r.refuseRead {
		return nil, errors.New("this Worker cannot read its roots")
	}
	result := []*pb.WorkspaceRoot{}
	for _, root := range r.stored {
		result = append(result, root)
	}
	return result, nil
}

func (f *fixture) release(peer ownership.ReverseImporter, exportOnly bool) (*pb.OwnershipReport, error) {
	f.t.Helper()
	return f.service.AsProjector().Release(fixtureContext, ownership.Handback{
		Directory:        filepath.Join(f.t.TempDir(), "package"),
		Epoch:            2,
		Importer:         peer,
		AcceptExportOnly: exportOnly,
	})
}

// A handback is four steps, and the last one is the only one that proves
// anything: the Runtime reads its own rows back and this Host compares them
// with the package it wrote.
func TestHandbackCarriesEveryRootAndIsCheckedAgainstTheWorkersOwnReading(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	f.own()
	peer := newRuntime()
	report, err := f.release(peer, false)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Matched {
		for _, check := range report.Checks {
			if !check.Matched {
				t.Errorf("check %s: differences %v", check.Check, check.Differences)
			}
		}
		t.Fatal("a clean handback reported differences")
	}
	checks := map[string]bool{}
	for _, check := range report.Checks {
		checks[check.Check] = check.Matched
	}
	for _, name := range []string{"filesystem.export_roots", "reverse.import", "reverse.workspaces", "reverse.unsupported_entity", "filesystem.worker_roots"} {
		if !checks[name] {
			t.Fatalf("check %s did not run or did not match: %v", name, checks)
		}
	}
	// The package really carried both roots, with the path and the permissions
	// the Host held.
	if len(peer.stored) != 2 {
		t.Fatalf("the package did not carry both roots: %+v", peer.stored)
	}
	if peer.stored[remoteID].GetExecutionHostId() != "构建机" || peer.stored[remoteID].GetCanonicalPath() != "/srv/项目" {
		t.Fatalf("the remote root did not survive the package: %+v", peer.stored[remoteID])
	}
}

// The epoch stays with the Host on every failure below, which is the safe
// direction: the Host still holds every registration and the operator can fix
// the cause and run the same rollback again.
func TestHandbackRefusesWhenTheOtherSideCannotConfirmIt(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	f.own()

	// A workspace the Runtime never reported back.
	dropped := newRuntime()
	dropped.drop = remoteID
	if _, err := f.release(dropped, false); !errors.Is(err, ownership.ErrReverseImportFailed) {
		t.Fatalf("a missing workspace did not block the handback: %v", err)
	}

	// An issue the Runtime raised blocks it whatever the digests say: an
	// unsupported entity is exactly the case where the rows are consistent and
	// still incomplete.
	raised := newRuntime()
	raised.issue = "reverse.unsupported_entity"
	if _, err := f.release(raised, false); !errors.Is(err, ownership.ErrReverseImportFailed) {
		t.Fatalf("a reported issue did not block the handback: %v", err)
	}

	// A Worker that cannot read its own roots cannot confirm the handback.
	refusing := newRuntime()
	refusing.refuseRead = true
	if _, err := f.release(refusing, false); !errors.Is(err, ownership.ErrReverseImportFailed) {
		t.Fatalf("a Worker that could not read its roots did not block the handback: %v", err)
	}
}

// A Worker too old to report its roots at all is a distinct case from one that
// tried and disagreed: it is refused, and the check names why, rather than
// passing because nothing was compared.
func TestAWorkerThatCannotReportRootsBlocksTheHandback(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	f.own()
	report, err := f.release(exportOnlyPeer{newRuntime()}, false)
	if !errors.Is(err, ownership.ErrReverseImportFailed) {
		t.Fatalf("an unverifiable handback was accepted: %v", err)
	}
	for _, check := range report.Checks {
		if check.Check == "filesystem.worker_roots" && !check.Matched &&
			len(check.Differences) == 1 && check.Differences[0] == "unsupported" {
			return
		}
	}
	t.Fatalf("the refusal did not name the missing capability: %+v", report.Checks)
}

// exportOnlyPeer can apply a package and cannot report its roots.
type exportOnlyPeer struct{ *runtime }

func (exportOnlyPeer) WorkspaceRoots() {}

// The danger switch stops after the export, and says so by leaving the package
// on disk with nothing applied.
func TestAcceptExportOnlyStopsAfterTheExport(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	f.own()
	peer := newRuntime()
	report, err := f.release(peer, true)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Matched || len(peer.stored) != 0 {
		t.Fatalf("an export-only handback reached the Runtime: %+v", peer.stored)
	}
}

// A directory that already holds a package is refused: it is the only copy of a
// previous reversal attempt, and a second one uses a new directory.
func TestExportRefusesToOverwriteAPackage(t *testing.T) {
	f := newFixture(t)
	f.stageBoth()
	if _, err := f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	f.own()
	directory := filepath.Join(t.TempDir(), "package")
	if _, err := f.service.Export(fixtureContext, directory, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Export(fixtureContext, directory, 2); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a second export overwrote the first: %v", err)
	}
}
