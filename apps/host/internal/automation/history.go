package automation

import (
	"context"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// Projecting the runs that already existed before the history index did.
//
// The index is written with every new run ([historyEntry]), so only a database
// that predates it needs this. Without the projection those runs would simply
// stop appearing in the panel — the history would look as if it had been
// truncated, which is worse than the unordered pages it replaced.
//
// It is idempotent and marked done per workspace, so a Host that restarts a
// hundred times does the walk once. It is also additive: it never rewrites,
// reorders or deletes a run, only writes the index row a run is missing.

// EnsureRunHistory projects every stored run of every workspace into the
// history index, once per workspace.
//
// Called at start-up, before the schedule loop: an interleaved materialize
// writes its own row and this walk simply finds it already there.
func (e *Engine) EnsureRunHistory(ctx context.Context) error {
	workspaces, err := e.store.WorkspacesOfKind(ctx, runKind)
	if err != nil {
		return err
	}
	for _, workspace := range workspaces {
		if workspace == "" {
			continue
		}
		if err = e.backfillWorkspaceHistory(ctx, workspace); err != nil {
			return err
		}
	}
	return nil
}

// historyProjected reports whether this workspace has already been walked.
func (e *Engine) historyProjected(ctx context.Context, workspace string) (bool, error) {
	marker := new(pb.AutomationPlanRef)
	rev, err := e.optional(ctx, entityKey(workspace, historyStateKind, "v1"), marker)
	if err != nil {
		return false, err
	}
	return rev != 0, nil
}

func (e *Engine) backfillWorkspaceHistory(ctx context.Context, workspace string) error {
	done, err := e.historyProjected(ctx, workspace)
	if err != nil || done {
		return err
	}
	after := ""
	for {
		page, err := e.store.List(ctx, storage.ListOptions{WorkspaceID: workspace, Kind: runKind, AfterID: after, Limit: historyBackfillBatch})
		if err != nil {
			return err
		}
		updates := []update{}
		for _, entity := range page.Entities {
			run := new(pb.AutomationRun)
			if proto.Unmarshal(entity.Payload, run) != nil || run.Id != entity.ID || run.PlanId == "" {
				return storage.ErrCorrupt
			}
			key := entityKey(workspace, historyKind, historyID(run.PlanId, run.ScheduledAtUnixMs, run.Id))
			// A tombstone is not "absent": storage keeps its revision so a
			// resurrection cannot be confused with a first write, and a row
			// created with revision 0 over one would be refused.
			existing, err := e.store.Read(ctx, key)
			switch {
			case err == nil && !existing.Deleted:
				continue
			case err == nil:
				updates = append(updates, update{key, existing.Revision, &pb.AutomationRunRef{RunId: run.Id, PlanId: run.PlanId, WorkspaceId: workspace}})
				continue
			case errors.Is(err, storage.ErrNotFound):
			default:
				return err
			}
			updates = append(updates, update{key, 0, &pb.AutomationRunRef{RunId: run.Id, PlanId: run.PlanId, WorkspaceId: workspace}})
		}
		if len(updates) > 0 {
			// A concurrent materialize may have written the same row between
			// the read and the commit. That row is the one we wanted; losing
			// the race is not a failure.
			if err = e.commit(ctx, "host", "backfill-run-history", updates...); err != nil && !errors.Is(err, storage.ErrConflict) {
				return err
			}
		}
		if !page.HasMore {
			break
		}
		after = page.NextID
	}
	// The marker is a plain ref to the workspace, written last: a crash in the
	// middle leaves the walk to run again, which is safe because it only ever
	// adds rows that are missing.
	err = e.commit(ctx, "host", "mark-run-history", update{entityKey(workspace, historyStateKind, "v1"), 0, &pb.AutomationPlanRef{WorkspaceId: workspace}})
	if errors.Is(err, storage.ErrConflict) {
		return nil
	}
	return err
}
