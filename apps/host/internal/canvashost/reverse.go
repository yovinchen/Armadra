package canvashost

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
)

// The canvas half of steps 2 to 4 of a handback (Go Host 业务所有权迁移 §2.12).
//
// The state machine writes nothing itself: it decides that the domain may be
// handed back and calls the projector, which exports (export.go) and then runs
// what is below. The Runtime applies the package, re-reads its own rows, and
// reports their canonical digests; those digests are compared workspace by
// workspace with the ones the package named, and a single difference blocks the
// handover.
//
// The re-read is what makes the comparison worth doing. A report assembled from
// the request would say what the Runtime was asked to store; the digest of a
// re-read says what it actually holds.

// reverseImport applies a package this Host just wrote and appends the
// comparison to `report`. It returns an error unless every workspace in the
// package came back with the digest and entity count the package named.
func (s *Service) reverseImport(ctx context.Context, importer ownership.ReverseImporter, directory string, epoch uint64, report *pb.CanvasConsistencyReport) error {
	index, indexDigest, err := readExportIndex(directory)
	if err != nil {
		return err
	}
	if index.Epoch != epoch {
		return fmt.Errorf("%w: the package names epoch %d, not %d", ownership.ErrReverseImportFailed, index.Epoch, epoch)
	}
	// The identifier is the package's own index digest, so re-running an
	// interrupted rollback replays the same import instead of starting another.
	importID := hex.EncodeToString(indexDigest)
	result, err := importer.ApplyReverseExport(ctx, ExportDomain, directory, indexDigest, epoch, importID)
	if err != nil {
		return errors.Join(ownership.ErrReverseImportFailed, err)
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
			return ownership.ErrReverseImportFailed
		}
	}
	return nil
}
