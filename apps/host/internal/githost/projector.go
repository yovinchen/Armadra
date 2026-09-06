package githost

import (
	"context"
	"sort"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
)

// The git domain's half of a write-ownership switch
// (Go Host 业务所有权迁移 §2.11, §3.3 git row).
//
// This is the shortest projector in the codebase, and the reason is worth
// stating: **the git domain has nothing to migrate.** The Runtime keeps no
// table for it — its queue was in memory and its clone jobs were in a map — so
// there are no rows to export, project or compare. §3.3 says as much: the git
// row's only checks are `git.queue_empty` and `git.clone_jobs_empty`, and
// "不做行核验".
//
// What a switch has to establish instead is that *nothing is in flight*. A
// domain moved while a push was running would leave the only record of that
// push in a process that is about to stop being the writer, and the question
// "did that reach the remote?" would then have no answer at all rather than an
// honest `UNKNOWN_OUTCOME`. So both directions ask the same two questions of
// the side that is giving the domain up, and refuse on a non-zero answer.
//
// The answers come from the other side's own reading, never from this one's
// expectation. Taking the domain over reads the Worker's snapshot across the
// live link; handing it back reads this Host's own queue and clone rows. A
// report assembled from what the side was *asked* would make every switch pass.

// Channel is the narrow part of the Runtime link this domain needs. It is
// smaller than the Worker client that implements it, so a test supplies one
// function rather than a process, and so a link without the git frame fails a
// type assertion instead of a switch that has already moved an epoch.
type Channel interface {
	GitSnapshot(ctx context.Context) (*pb.GitDomainSnapshot, error)
}

// drainTimeout bounds how long a handback waits for this Host's own queue to
// finish. It is short on purpose: a switch happens inside a maintenance window
// with an operator watching, and a queue that has not drained in this long is
// something they need to see rather than something to keep waiting on.
const drainTimeout = 30 * time.Second

// Projector is the git service seen as one domain of the switch.
type Projector struct{ service *Service }

// AsProjector exposes the service to the ownership state machine.
func (s *Service) AsProjector() Projector { return Projector{service: s} }

// Adopt takes the domain over.
//
// Nothing is written. The Host's queue starts empty because it has never held
// this domain before, and the Runtime has no rows to hand over. The whole of
// the adoption is proving that the Runtime is not in the middle of something.
func (p Projector) Adopt(ctx context.Context, adoption ownership.Adoption) (*pb.OwnershipReport, error) {
	channel, ok := adoption.Link.(Channel)
	if !ok {
		// The link cannot carry a git frame, so there is no way to establish
		// that the Runtime's queue is empty. Refusing here means no epoch was
		// touched.
		return nil, ownership.ErrUnsupportedDomain
	}
	snapshot, err := channel.GitSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	if snapshot == nil {
		return nil, ownership.ErrUnsupportedDomain
	}
	builder := new(checkBuilder)
	inFlight := uint64(snapshot.GetQueued()) + uint64(snapshot.GetRunning())
	builder.record("git.queue_empty", 0, inFlight, snapshot.GetActiveOperationIds())
	builder.record("git.clone_jobs_empty", 0, uint64(snapshot.GetCloneJobs()), nil)

	report := &pb.OwnershipReport{
		Domain:           pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_GIT,
		ImportId:         adoption.ImportID,
		Checks:           builder.checks,
		EntityCount:      0,
		Matched:          builder.matched(),
		VerifiedAtUnixMs: p.service.now(),
	}
	if !report.Matched {
		return report, ownership.ErrNotVerified
	}
	return report, nil
}

// Release hands the domain back.
//
// There is no reverse import, and that is not a shortcut: the Runtime has no
// git table to write into. Its queue is a process's own memory, and it starts
// empty when it starts owning the domain again — which is exactly what the
// Runtime's own guard already guarantees, since it refuses git writes until the
// epoch comes back.
//
// So a handback is two statements, both about this Host:
//
//  1. this Host's queue is empty, having been given a bounded chance to drain,
//     and
//  2. no clone it started is still running.
//
// Both are checked against this Host's own records, and a package is written
// anyway so an operator has the queue's history on disk — the one thing the
// Runtime genuinely cannot reconstruct.
func (p Projector) Release(ctx context.Context, handback ownership.Handback) (*pb.OwnershipReport, error) {
	report, err := p.service.Export(ctx, handback.Directory, handback.Epoch)
	if err != nil || handback.AcceptExportOnly {
		return report, err
	}
	drain, cancel := context.WithTimeout(ctx, drainTimeout)
	defer cancel()
	// The queue is asked to finish rather than told to stop: an operation
	// killed mid-mutation is an unknown outcome, and creating one in order to
	// complete a rollback would be the switch manufacturing the exact
	// uncertainty it exists to avoid.
	drained := p.service.queue.quiet(drain)

	builder := new(checkBuilder)
	differences := []string{}
	if !drained {
		differences = append(differences, "queue.draining")
	}
	builder.record("git.queue_empty", 0, uint64(p.service.queue.active()), differences)

	clones := 0
	workspaces, err := p.service.store.WorkspacesOfKind(ctx, CloneKind)
	if err != nil {
		return report, err
	}
	for _, workspaceID := range workspaces {
		active, err := p.service.activeClones(ctx, workspaceID)
		if err != nil {
			return report, err
		}
		clones += active
	}
	builder.record("git.clone_jobs_empty", 0, uint64(clones), nil)

	report.Checks = append(report.Checks, builder.checks...)
	if !builder.matched() {
		report.Matched = false
		return report, ownership.ErrReverseImportFailed
	}
	return report, nil
}

// Watermark is the Host's event sequence right now.
func (p Projector) Watermark(ctx context.Context) (uint64, error) {
	_, watermark, err := p.service.store.Watermark(ctx)
	return watermark, err
}

// maxDifferences bounds what one check reports. A report is read by a person in
// a maintenance window, and thirty identifiers say more than ten thousand.
const maxDifferences = 32

type checkBuilder struct{ checks []*pb.ConsistencyCheck }

func (b *checkBuilder) record(name string, expected, actual uint64, differences []string) {
	values := append([]string(nil), differences...)
	sort.Strings(values)
	if len(values) > maxDifferences {
		values = values[:maxDifferences]
	}
	b.checks = append(b.checks, &pb.ConsistencyCheck{
		Check:         name,
		ExpectedCount: expected,
		ActualCount:   actual,
		Matched:       expected == actual && len(values) == 0,
		Differences:   values,
	})
}

func (b *checkBuilder) matched() bool {
	for _, check := range b.checks {
		if !check.Matched {
			return false
		}
	}
	return true
}

var _ = storage.OwnershipDomainGit
