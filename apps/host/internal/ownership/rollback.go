package ownership

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// Handing a domain back is four steps, not two (Go Host 业务所有权迁移 §2.12).
//
// A rollback used to be "write the package and hand the epoch back", with the
// operator asserting in one flag that the Host's changes existed only in that
// package. The epoch now moves last, after the Runtime has actually taken the
// data:
//
//  1. the Host exports what it holds into an empty directory
//  2. the Runtime applies that package to its own database
//  3. the Runtime re-reads its own rows and reports their canonical digests
//  4. the domain compares those digests with the ones it wrote, and a single
//     difference blocks the handover
//
// Steps 2 to 4 are the domain's, because only the domain knows what its rows
// mean; this package decides whether they may be skipped at all and refuses a
// rollback that cannot complete before any file is written.

var (
	// ErrReverseImportUnsupported means the Runtime cannot apply a package at
	// all. It is raised before the export is written, so an operator is never
	// left holding files they now have to reason about. The remaining option is
	// AcceptExportOnly, and the CLI flag says so.
	ErrReverseImportUnsupported = errors.New("the Runtime cannot apply a reverse export package")
	// ErrReverseImportFailed means the package reached the Runtime but what it
	// stored is not what the package described. The epoch stays with the Host,
	// which is the safe direction: the Host still has every row.
	ErrReverseImportFailed = errors.New("the Runtime did not store the reverse export package")
)

// ReverseImporter is the half of the channel to the Runtime a rollback needs.
// It is separate from Handoff so a test can supply one without the other, and
// so a Runtime that cannot import is a distinct thing from one that can.
type ReverseImporter interface {
	SupportsReverseImport() bool
	ApplyReverseExport(ctx context.Context, domain, packagePath string, indexSha256 []byte, expectedEpoch uint64, importID string) (*pb.ReverseImportReport, error)
}

// Channel is one private link to the Runtime that can do both halves of a
// move. The production implementation is a Worker over the stdio protocol; a
// caller that has one passes it as both Handoff and Importer.
type Channel interface {
	Handoff
	ReverseImporter
}

// Handback is what a domain is told when it is handed back: where to write the
// package, which epoch the Runtime acknowledged (the package names it, and the
// Runtime refuses one that does not match), and how the package reaches the
// Runtime.
type Handback struct {
	Directory string
	Epoch     uint64
	// Importer is nil only when AcceptExportOnly was set: every other rollback
	// is refused before it reaches the domain.
	Importer ReverseImporter
	// AcceptExportOnly means the export is the whole handover. The domain must
	// not import, and the Host's own changes stay in the package.
	AcceptExportOnly bool
}

// Rollback hands a domain back to the Runtime from a running Host.
//
// It is the same state machine as a switch, run in the other direction, with
// one addition: the Host owes the Runtime an export before it stops being the
// writer, and an HTTPS caller must not choose where that lands. A browser
// naming a path on this machine is a filesystem write with a URL in front of
// it, so the directory is allocated here, under the Host's own export root.
//
// The CLI keeps naming its own directory: the operator is at the machine and
// wants the package somewhere they can find it.
func (s *Service) Rollback(ctx context.Context, request Request) (*pb.OwnershipSwitchResponse, error) {
	request.Target = pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME
	if request.ExportDirectory != "" {
		// An HTTPS caller cannot name one; only the CLI reaches SwitchOffline.
		return nil, ErrInvalid
	}
	if s.options.ExportRoot == "" {
		return nil, fmt.Errorf("%w: this Host has no export directory", ErrExportRequired)
	}
	if !storage.ValidOwnershipDomain(request.Domain) {
		return nil, ErrInvalid
	}
	directory, err := s.exportDirectory(request.Domain)
	if err != nil {
		return nil, err
	}
	request.ExportDirectory = directory
	return s.Switch(ctx, request)
}

// exportDirectory names a fresh directory for one reverse export. The random
// suffix is what keeps a second attempt from being asked to overwrite the only
// copy of the first one, which Export refuses outright.
func (s *Service) exportDirectory(domain string) (string, error) {
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return "", err
	}
	return filepath.Join(s.options.ExportRoot, fmt.Sprintf("%s-%d-%s", domain, s.now(), hex.EncodeToString(suffix[:]))), nil
}
