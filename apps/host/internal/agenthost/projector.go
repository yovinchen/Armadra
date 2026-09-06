package agenthost

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
)

// The agent domain's half of a write-ownership switch
// (Go Host 业务所有权迁移 §2.11 steps 3-5, §2.12).
//
// The state machine in internal/ownership knows nothing about agents. What it
// needs from each domain is three answers — how the data is taken over, how it
// is handed back, and where the Host's event stream stands — and this file is
// the agent domain giving them.
//
// Two things are specific to this domain and are why §1.2 calls its rollback
// cost "medium-high".
//
// The first is that a switch can land while something is in flight. A handoff
// this Host adopted as DISPATCHING was claimed by a Runtime that is now not the
// writer, and nobody will ever settle it; the adoption therefore ends by
// reconciling those into UNKNOWN_OUTCOME, which is the honest reading and one a
// person can resolve. A resend would be a second copy of somebody's work in
// front of an agent that may already be acting on the first.
//
// The second is that the handback's comparison has to be made by the Runtime
// rather than assembled from the request. After the package is applied, this
// Host asks the *Worker* to read its own agent rows back (worker.proto action
// 28) and compares them with what the package described. A report built from
// what the Runtime was asked to store would make every handback pass.

// AgentReader is the optional half of the Runtime channel this domain uses to
// read the Worker's own rows. It is separate from the importer because a Worker
// that can apply a package and one that can report its agents are two different
// statements, and a Worker too old for the second must make the handback refuse
// rather than pass unverified.
type AgentReader interface {
	WorkerAgents(ctx context.Context) (*pb.WorkerAgentStates, error)
}

// Projector is the agent service seen as one domain of the switch.
type Projector struct{ service *Service }

// AsProjector exposes the service to the ownership state machine.
func (s *Service) AsProjector() Projector { return Projector{service: s} }

// Adopt projects the staged agent rows, verifies them, and then settles
// whatever was in flight when the domain moved.
func (p Projector) Adopt(ctx context.Context, adoption ownership.Adoption) (*pb.OwnershipReport, error) {
	report, err := p.service.Adopt(ctx, adoption.ImportID)
	if err != nil {
		return report, err
	}
	if !report.GetMatched() {
		return report, ownership.ErrNotVerified
	}
	// A handoff adopted mid-dispatch was claimed by a process that is no longer
	// the writer. Leaving it claimed would leave it claimed forever.
	settled, err := p.service.ReconcileHandoffs(ctx)
	builder := new(checkBuilder)
	if err != nil {
		builder.record("agent.handoffs.reconcile", 0, 0, []string{"failed"})
		report.Checks = append(report.Checks, builder.checks...)
		report.Matched = false
		return report, errors.Join(ownership.ErrNotVerified, err)
	}
	builder.record("agent.handoffs.reconcile", uint64(settled), uint64(settled), nil)
	report.Checks = append(report.Checks, builder.checks...)
	return report, nil
}

// Release hands the domain back. The export is the first of four steps: the
// package then goes to the Runtime, the Runtime re-reads its rows, and the
// comparison below decides whether the epoch may move at all.
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
	builder.record("reverse.agents", index.EntityCount, reread, differences)

	unsupported := []string{}
	for _, issue := range result.GetIssues() {
		if issue.GetSeverity() != "warning" {
			unsupported = append(unsupported, issue.GetCode())
		}
	}
	builder.record("reverse.unsupported_entity", 0, uint64(len(unsupported)), unsupported)

	if err = p.compareWorkerAgents(ctx, handback, builder); err != nil {
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

// compareWorkerAgents asks the Worker to read its own agent rows and compares
// them with this Host's records.
//
// This is the check the reverse import report cannot make for itself: it is
// produced by the side that stored the rows, from the rows, rather than from
// the request that asked for them.
//
// Only the statuses are compared. They are the projection every other agent
// record hangs off — an approval whose node has no status is one no board can
// draw — and they are the one table the Worker can read back without this
// comparison turning into a second implementation of the whole domain.
func (p Projector) compareWorkerAgents(ctx context.Context, handback ownership.Handback, builder *checkBuilder) error {
	reader, ok := handback.Importer.(AgentReader)
	if !ok {
		// A Worker that cannot report its agents cannot complete this handback.
		// Refusing here leaves the epoch with the Host, which is the safe
		// direction: the Host still holds every record.
		builder.record("agent.worker_agents", 0, 0, []string{"unsupported"})
		return nil
	}
	states, err := reader.WorkerAgents(ctx)
	if err != nil {
		return errors.Join(ownership.ErrReverseImportFailed, err)
	}
	held := map[string]*pb.WorkerAgentState{}
	for _, state := range states.GetAgents() {
		held[state.GetNodeId()] = state
	}
	statuses, err := p.service.store.AllAgentStatus(ctx)
	if err != nil {
		return err
	}
	differences := []string{}
	var expected, matched uint64
	for _, status := range statuses {
		if status.Deleted {
			continue
		}
		expected++
		actual, ok := held[status.NodeID]
		if !ok {
			differences = append(differences, status.NodeID)
			continue
		}
		matched++
		// The three properties a rollback has to have put back: which state the
		// node is in, whose CLI it is, and how many messages are waiting. A
		// state that differs is a node drawn as idle when it is blocked; an
		// unread count that differs is a badge that is wrong.
		if actual.GetState() != pb.AgentState(status.State) ||
			actual.GetAgentId() != status.AgentID ||
			actual.GetUnread() != status.Unread {
			differences = append(differences, status.NodeID)
		}
	}
	builder.record("agent.worker_agents", expected, matched, differences)
	return nil
}
