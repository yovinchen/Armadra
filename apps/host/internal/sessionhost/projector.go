package sessionhost

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
)

// The session domain's half of a write-ownership switch
// (Go Host 业务所有权迁移 §2.11 steps 3-5, §2.12).
//
// The state machine in internal/ownership knows nothing about sessions. What it
// needs from each domain is three answers — how the data is taken over, how it
// is handed back, and where the Host's event stream stands — and this file is
// the session domain giving them.
//
// One thing here is specific to this domain and is the reason §1.2 calls its
// rollback cost "medium": the records describe *live processes*. A switch that
// verified every row and then walked away would leave this Host holding
// sessions it has never spoken to, which is indistinguishable from sessions
// that have died. So the adoption ends with a reclaim: the Host asks the
// execution host what it actually holds, and records that. A reclaim that
// cannot reach the Worker is not a failed switch — the rows are correct and the
// sessions are recorded LOST, which is a state an operator can act on and a
// later reclaim can resolve.
//
// The handback's comparison is the one both sides can be checked against: after
// the Runtime applies the package, this Host asks the *Worker* to read its own
// `terminal_sessions` rows back (worker.proto action 27) and compares them with
// what the package described. A report assembled from the request would say
// what the Runtime was asked to store; the Worker's own reading says what it
// holds.

// SessionReader is the optional half of the Runtime channel this domain uses to
// read the Worker's own sessions. It is separate from the importer because a
// Worker that can apply a package and one that can report its sessions are two
// different statements, and a Worker too old for the second must make the
// handback refuse rather than pass unverified.
type SessionReader interface {
	WorkerSessions(ctx context.Context) (*pb.WorkerSessionStates, error)
}

// Projector is the session service seen as one domain of the switch.
type Projector struct{ service *Service }

// AsProjector exposes the service to the ownership state machine.
func (s *Service) AsProjector() Projector { return Projector{service: s} }

// Adopt projects the staged `terminal_sessions` rows into session records,
// verifies them, and then reconciles them against what the execution host
// actually holds. A report that did not match is returned with ErrNotVerified
// rather than silently accepted.
func (p Projector) Adopt(ctx context.Context, adoption ownership.Adoption) (*pb.OwnershipReport, error) {
	report, err := p.service.Adopt(ctx, adoption.ImportID)
	if err != nil {
		return report, err
	}
	if !report.GetMatched() {
		return report, ownership.ErrNotVerified
	}
	// The rows are right; now find out which of them still have a process.
	// This is the step that turns "the record says RUNNING" into "somebody has
	// looked", and it is deliberately not allowed to fail the switch: a Worker
	// that cannot be reached leaves the sessions LOST, which is the honest
	// state and one a later reclaim resolves.
	outcome, reclaimErr := p.service.Reclaim(ctx, "")
	builder := new(checkBuilder)
	if reclaimErr != nil {
		builder.record("session.reclaim", 0, 0, []string{"unavailable"})
	} else {
		builder.record("session.reclaim",
			uint64(len(outcome.Reconciled)+len(outcome.Ended)+len(outcome.Lost)),
			uint64(len(outcome.Reconciled)+len(outcome.Ended)+len(outcome.Lost)), nil)
	}
	report.Checks = append(report.Checks, builder.checks...)
	if reclaimErr != nil {
		report.Matched = false
		return report, errors.Join(ownership.ErrNotVerified, reclaimErr)
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
	// The epoch has not moved and the Host still holds every record, so a
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
	builder.record("reverse.sessions", index.EntityCount, reread, differences)

	unsupported := []string{}
	for _, issue := range result.GetIssues() {
		if issue.GetSeverity() != "warning" {
			unsupported = append(unsupported, issue.GetCode())
		}
	}
	builder.record("reverse.unsupported_entity", 0, uint64(len(unsupported)), unsupported)

	if err = p.compareWorkerSessions(ctx, handback, builder); err != nil {
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

// compareWorkerSessions asks the Worker to read its own `terminal_sessions`
// rows and compares them with this Host's records. This is the check the
// reverse import report cannot make for itself: it is produced by the side that
// stored the rows, from the rows, rather than from the request that asked for
// them.
//
// Tombstones are excluded from the comparison. A closed session's row was
// deleted from `terminal_sessions` before this Host ever held it, so a Worker
// that does not list one is agreeing rather than differing.
func (p Projector) compareWorkerSessions(ctx context.Context, handback ownership.Handback, builder *checkBuilder) error {
	reader, ok := handback.Importer.(SessionReader)
	if !ok {
		// A Worker that cannot report its sessions cannot complete this
		// handback. Refusing here leaves the epoch with the Host, which is the
		// safe direction: the Host still holds every record.
		builder.record("session.worker_sessions", 0, 0, []string{"unsupported"})
		return nil
	}
	states, err := reader.WorkerSessions(ctx)
	if err != nil {
		return errors.Join(ownership.ErrReverseImportFailed, err)
	}
	held := map[string]*pb.WorkerSessionState{}
	for _, state := range states.GetSessions() {
		held[state.GetSessionId()] = state
	}
	sessions, err := p.service.store.AllSessions(ctx)
	if err != nil {
		return err
	}
	differences := []string{}
	var expected, matched uint64
	for _, session := range sessions {
		if session.Deleted {
			continue
		}
		expected++
		actual, ok := held[session.SessionID]
		if !ok {
			differences = append(differences, session.SessionID)
			continue
		}
		matched++
		// The three properties a rollback has to have put back: which node owns
		// the session, which logical key survives a recycle, and which
		// generation the pane is on. A path that differs is a session pointed
		// at the wrong directory; a generation that differs is a client typing
		// into a pane nobody is reading.
		if actual.GetSessionKey() != session.SessionKey ||
			actual.GetOwnerNodeId() != session.OwnerNodeID ||
			actual.GetGeneration() != session.Generation {
			differences = append(differences, session.SessionID)
		}
	}
	builder.record("session.worker_sessions", expected, matched, differences)
	return nil
}
