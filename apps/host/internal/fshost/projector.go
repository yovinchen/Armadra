package fshost

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
)

// The filesystem domain's half of a write-ownership switch
// (Go Host 业务所有权迁移 §2.11 steps 3-5, §2.12).
//
// The state machine in internal/ownership knows nothing about roots. What it
// needs from each domain is three answers — how the data is taken over, how it
// is handed back, and where the Host's event stream stands — and this file is
// the filesystem giving them.
//
// The handback is the interesting one, because it is the only place the two
// sides can be compared against something neither of them wrote alone: after
// the Runtime applies the package, this Host asks the *Worker* to read its own
// `workspaces` rows back (worker.proto action 26) and compares them with the
// registrations the package described. A report assembled from the request
// would say what the Runtime was asked to store; the Worker's own reading says
// what it holds.

// RootReader is the optional half of the Runtime channel this domain uses to
// read the Worker's own roots. It is separate from the importer because a
// Worker that can apply a package and a Worker that can report its roots are
// two different statements, and a Worker too old for the second one must make
// the handback refuse rather than pass unverified.
type RootReader interface {
	WorkspaceRoots(ctx context.Context) ([]*pb.WorkspaceRoot, error)
}

// Projector is the filesystem service seen as one domain of the switch.
type Projector struct{ service *Service }

// AsProjector exposes the service to the ownership state machine.
func (s *Service) AsProjector() Projector { return Projector{service: s} }

// Adopt projects the staged `workspaces` rows into registrations and verifies
// them. A report that did not match is returned with ErrNotVerified rather than
// silently accepted.
//
// The live link is ignored: the roots arrive in the same offline bundle the
// canvas does, so everything this needs is already staged on disk.
func (p Projector) Adopt(ctx context.Context, adoption ownership.Adoption) (*pb.OwnershipReport, error) {
	report, err := p.service.Adopt(ctx, adoption.ImportID)
	if err != nil {
		return report, err
	}
	if !report.GetMatched() {
		return report, ownership.ErrNotVerified
	}
	return report, nil
}

// Release hands the domain back. The export is the first of four steps: the
// package then goes to the Runtime, the Runtime re-reads its rows, and the
// comparison below decides whether the epoch may move at all.
//
// AcceptExportOnly is the one path that stops after the export. It exists
// because a Runtime too old to import would otherwise strand a Host that has to
// give the domain back, and it is spelled out as a danger switch everywhere it
// is reachable.
func (p Projector) Release(ctx context.Context, handback ownership.Handback) (*pb.OwnershipReport, error) {
	report, err := p.service.Export(ctx, handback.Directory, handback.Epoch)
	if err != nil || handback.AcceptExportOnly {
		return report, err
	}
	// The epoch has not moved and the Host still holds every registration, so a
	// failed import is recoverable: fix the cause, use a new export directory,
	// run the same rollback again.
	err = p.reverseImport(ctx, handback, report)
	return report, err
}

// Watermark is the Host's event sequence right now.
func (p Projector) Watermark(ctx context.Context) (uint64, error) {
	_, watermark, err := p.service.store.Watermark(ctx)
	return watermark, err
}

// reverseImport applies the package this Host just wrote and appends the
// comparison to `report`.
func (p Projector) reverseImport(ctx context.Context, handback ownership.Handback, report *pb.OwnershipReport) error {
	index, indexDigest, err := readExportIndex(handback.Directory)
	if err != nil {
		return err
	}
	if index.Epoch != handback.Epoch {
		return fmt.Errorf("%w: the package names epoch %d, not %d", ownership.ErrReverseImportFailed, index.Epoch, handback.Epoch)
	}
	// The identifier is the package's own index digest, so re-running an
	// interrupted rollback replays the same import instead of starting another.
	importID := hex.EncodeToString(indexDigest)
	result, err := handback.Importer.ApplyReverseExport(ctx, ExportDomain, handback.Directory, indexDigest, handback.Epoch, importID)
	if err != nil {
		return errors.Join(ownership.ErrReverseImportFailed, err)
	}

	builder := new(checkBuilder)
	applied := []string{}
	if result.GetEpoch() != index.Epoch {
		applied = append(applied, "epoch")
	}
	if result.GetEntityCount() != index.EntityCount {
		applied = append(applied, "entity_count")
	}
	builder.record("reverse.import", index.EntityCount, result.GetEntityCount(), applied)

	// The Runtime reports one entry per workspace it read back. Comparing by
	// identifier rather than by position means a reordered report is a
	// difference on the workspace it actually concerns.
	stored := map[string]*pb.ReverseExportFile{}
	for _, file := range result.GetReexported() {
		stored[file.GetWorkspaceId()] = file
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
		reread += back.GetEntityCount()
		if hex.EncodeToString(back.GetContentSha256()) != file.ContentSha256 || back.GetEntityCount() != file.EntityCount {
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

	unsupported := []string{}
	for _, issue := range result.GetIssues() {
		if issue.GetSeverity() != "warning" {
			unsupported = append(unsupported, issue.GetCode())
		}
	}
	builder.record("reverse.unsupported_entity", 0, uint64(len(unsupported)), unsupported)

	if err = p.compareWorkerRoots(ctx, handback, index, builder); err != nil {
		return err
	}

	report.Checks = append(report.Checks, builder.checks...)
	for _, check := range builder.checks {
		if !check.Matched {
			report.Matched = false
			return ownership.ErrReverseImportFailed
		}
	}
	return nil
}

// compareWorkerRoots asks the Worker to read its own `workspaces` rows and
// compares them with the package. This is the check the reverse import report
// cannot make for itself: it is produced by the side that stored the rows, from
// the rows, rather than from the request that asked for them.
func (p Projector) compareWorkerRoots(ctx context.Context, handback ownership.Handback, index *exportIndex, builder *checkBuilder) error {
	reader, ok := handback.Importer.(RootReader)
	if !ok {
		// A Worker that cannot report its roots cannot complete this handback.
		// Refusing here leaves the epoch with the Host, which is the safe
		// direction: the Host still holds every registration.
		builder.record("filesystem.worker_roots", index.EntityCount, 0, []string{"unsupported"})
		return nil
	}
	roots, err := reader.WorkspaceRoots(ctx)
	if err != nil {
		return errors.Join(ownership.ErrReverseImportFailed, err)
	}
	byWorkspace := map[string]*pb.WorkspaceRoot{}
	for _, root := range roots {
		byWorkspace[root.GetWorkspaceId()] = root
	}
	differences := []string{}
	var matched uint64
	for _, file := range index.Files {
		expected, err := p.service.Root(ctx, file.WorkspaceID)
		if err != nil {
			differences = append(differences, file.WorkspaceID)
			continue
		}
		actual, ok := byWorkspace[file.WorkspaceID]
		if !ok {
			differences = append(differences, file.WorkspaceID)
			continue
		}
		matched++
		permissions := actual.GetPermissions()
		if actual.GetCanonicalPath() != expected.CanonicalPath ||
			actual.GetExecutionHostId() != expected.ExecutionHostID ||
			permissions.GetRead() != expected.Read ||
			permissions.GetWrite() != expected.Write ||
			permissions.GetExecute() != expected.Execute {
			differences = append(differences, file.WorkspaceID)
		}
	}
	builder.record("filesystem.worker_roots", index.EntityCount, matched, differences)
	return nil
}
