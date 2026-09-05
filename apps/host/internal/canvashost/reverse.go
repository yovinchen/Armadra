package canvashost

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"

	pb "armadra.local/host/gen/armadra/v1"
)

// The rollback's middle steps (Go Host 业务所有权迁移 §2.12).
//
// A rollback used to be "write the package and hand the epoch back", with the
// operator asserting in one flag that the Host's changes only existed in the
// package. It is now four steps, and the epoch only moves after the fourth:
//
//  1. the Host exports what it holds (export.go)
//  2. the Runtime applies that package to its own database
//  3. the Runtime re-reads its rows and reports their canonical digests
//  4. the Host compares those digests, workspace by workspace, with the ones
//     it wrote — a single difference blocks the handover
//
// Step 3 is what makes step 4 worth doing. A report assembled from the request
// would say what the Runtime was asked to store; the digest of a re-read says
// what it actually holds.

// ErrReverseImportUnsupported means the Runtime cannot apply a package at all.
// The operator's remaining option is `--accept-export-only`, and the message
// says so rather than leaving them to guess which flag it was.
var ErrReverseImportUnsupported = errors.New("the Runtime cannot apply a reverse export package")

// ErrReverseImportFailed means the package reached the Runtime but what it
// stored is not what the package described. The epoch stays with the Host,
// which is the safe direction: the Host still has every row.
var ErrReverseImportFailed = errors.New("the Runtime did not store the reverse export package")

// ReverseImporter is the half of the Worker channel a rollback needs. It is
// separate from Handoff so a test can supply one without the other, and so a
// Worker that cannot import is a compile-time distinct thing from one that can.
type ReverseImporter interface {
	SupportsReverseImport() bool
	ApplyReverseExport(ctx context.Context, domain, packagePath string, indexSha256 []byte, expectedEpoch uint64, importID string) (*pb.ReverseImportReport, error)
}

// reverseImport applies a package this Host just wrote and appends the
// comparison to `report`. It returns an error unless every workspace in the
// package came back with the digest and entity count the package named.
func (s *Service) reverseImport(ctx context.Context, importer ReverseImporter, directory string, epoch uint64, report *pb.CanvasConsistencyReport) error {
	index, indexDigest, err := readExportIndex(directory)
	if err != nil {
		return err
	}
	if index.Epoch != epoch {
		return fmt.Errorf("%w: the package names epoch %d, not %d", ErrReverseImportFailed, index.Epoch, epoch)
	}
	// The identifier is the package's own index digest, so re-running an
	// interrupted rollback replays the same import instead of starting another.
	importID := hex.EncodeToString(indexDigest)
	result, err := importer.ApplyReverseExport(ctx, ExportDomain, directory, indexDigest, epoch, importID)
	if err != nil {
		return errors.Join(ErrReverseImportFailed, err)
	}

	builder := &checkBuilder{}
	applied := []string{}
	if result.Epoch != index.Epoch {
		applied = append(applied, "epoch")
	}
	if result.EntityCount != index.EntityCount {
		applied = append(applied, "entity_count")
	}
	builder.record("reverse.import", index.EntityCount, result.EntityCount, applied)

	// The Runtime reports one entry per workspace it read back. Comparing by
	// identifier rather than by position means a reordered report is a
	// difference on the workspace it actually concerns.
	stored := map[string]*pb.ReverseExportFile{}
	for _, file := range result.Reexported {
		stored[file.WorkspaceId] = file
	}
	differences := []string{}
	named := map[string]bool{}
	var reread uint64
	for _, file := range index.Files {
		named[file.WorkspaceID] = true
		back, ok := stored[file.WorkspaceID]
		if !ok {
			differences = append(differences, file.WorkspaceID)
			continue
		}
		reread += back.EntityCount
		if hex.EncodeToString(back.ContentSha256) != file.ContentSha256 || back.EntityCount != file.EntityCount {
			differences = append(differences, file.WorkspaceID)
		}
	}
	// A workspace the Runtime reports and the package never named did not come
	// from this rollback, and is as much a difference as a missing one.
	for workspaceID := range stored {
		if !named[workspaceID] {
			differences = append(differences, workspaceID)
		}
	}
	builder.record("reverse.workspaces", index.EntityCount, reread, differences)

	// An issue the Runtime raised about the package blocks the handover on its
	// own, whatever the digests say: `reverse.unsupported_entity` is exactly
	// the case where the rows are consistent and still incomplete.
	unsupported := []string{}
	for _, issue := range result.Issues {
		if issue.Severity != "warning" {
			unsupported = append(unsupported, issue.Code)
		}
	}
	builder.record("reverse.unsupported_entity", 0, uint64(len(unsupported)), unsupported)

	report.Checks = append(report.Checks, builder.checks...)
	for _, check := range builder.checks {
		if !check.Matched {
			report.Matched = false
			return ErrReverseImportFailed
		}
	}
	return nil
}
