package githost

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
)

// link is the switch's channel, reduced to the one question the git domain asks
// across it.
type link struct {
	snapshot *pb.GitDomainSnapshot
	err      error
}

func (l *link) GitSnapshot(context.Context) (*pb.GitDomainSnapshot, error) {
	return l.snapshot, l.err
}

// The switch hands the projector its own channel, which also carries the
// ownership frames. They are never used here -- the git domain reads exactly
// one thing across the link -- but the type has to satisfy the whole interface,
// which is itself the point: a link is one connection, not one method.
func (l *link) SetWriteOwnership(context.Context, string, pb.CanvasOwnershipOwner, uint64, uint64, string) (*pb.WorkerWriteOwnership, error) {
	return nil, errors.New("the git domain never moves an epoch itself")
}

func (l *link) GetWriteOwnership(context.Context, string) (*pb.WorkerWriteOwnership, error) {
	return nil, errors.New("the git domain never reads an epoch itself")
}

// linkWithoutGit is a Runtime link that cannot carry a git frame. It is the
// case a switch has to refuse before touching an epoch.
type linkWithoutGit struct{}

func (linkWithoutGit) SetWriteOwnership(context.Context, string, pb.CanvasOwnershipOwner, uint64, uint64, string) (*pb.WorkerWriteOwnership, error) {
	return nil, errors.New("not used")
}
func (linkWithoutGit) GetWriteOwnership(context.Context, string) (*pb.WorkerWriteOwnership, error) {
	return nil, errors.New("not used")
}

// Taking the domain over is not a data migration -- the Runtime keeps no git
// table -- so the whole of the adoption is proving nothing is in flight. A
// queue with anything in it blocks the switch instead of moving the domain out
// from under a running push.
func TestAdoptionRefusesWhileTheRuntimeIsMidOperation(t *testing.T) {
	f := newFixture(t)
	projector := f.service.AsProjector()
	report, err := projector.Adopt(fixtureContext, ownership.Adoption{
		ImportID: "import-1",
		Link:     &link{snapshot: &pb.GitDomainSnapshot{Running: 1, ActiveOperationIds: []string{"push-1"}}},
	})
	if !errors.Is(err, ownership.ErrNotVerified) {
		t.Fatalf("a switch was allowed with a push in flight: %v", err)
	}
	if report.GetMatched() {
		t.Fatal("the report claimed a match")
	}
	if !hasCheck(report, "git.queue_empty", false) {
		t.Fatalf("the queue check was not the one that failed: %v", report.GetChecks())
	}

	// A clone still running blocks it too: the half-written directory's only
	// record is in the process that is about to stop being the writer.
	if _, err = projector.Adopt(fixtureContext, ownership.Adoption{
		ImportID: "import-1",
		Link:     &link{snapshot: &pb.GitDomainSnapshot{CloneJobs: 2}},
	}); !errors.Is(err, ownership.ErrNotVerified) {
		t.Fatalf("a switch was allowed with a clone running: %v", err)
	}

	// A drained Runtime is the only one a switch proceeds on.
	report, err = projector.Adopt(fixtureContext, ownership.Adoption{
		ImportID: "import-1",
		Link:     &link{snapshot: &pb.GitDomainSnapshot{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !report.GetMatched() || report.GetEntityCount() != 0 {
		t.Fatalf("a drained adoption did not verify: %v", report)
	}
}

// A link that cannot carry a git frame has no way to establish that the
// Runtime's queue is empty, so the switch refuses before an epoch is touched
// rather than after.
func TestAdoptionRefusesALinkThatCannotAnswer(t *testing.T) {
	f := newFixture(t)
	if _, err := f.service.AsProjector().Adopt(fixtureContext, ownership.Adoption{ImportID: "import-1", Link: linkWithoutGit{}}); !errors.Is(err, ownership.ErrUnsupportedDomain) {
		t.Fatalf("expected an unsupported-domain refusal, got %v", err)
	}
}

// Handing the domain back writes the one thing the Runtime cannot rebuild: the
// queue's own history, including every operation that ended without an answer.
// After the handback those entries exist nowhere else.
func TestReleaseWritesTheUnresolvedHistory(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.executor.runErr["0000000000000001-operation"] = errors.New("the worker went away")
	interrupted := f.enqueue(pb.GitActionKind_GIT_ACTION_KIND_PUSH, scopeAt(mainPath, repositoryA), "git/push-1")
	settled := f.settled(interrupted.GetOperationId())
	if settled.GetState() != pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME {
		t.Fatalf("the fixture did not produce an unknown outcome: %v", settled.GetState())
	}
	done := f.enqueue(pb.GitActionKind_GIT_ACTION_KIND_STAGE, scopeAt(mainPath, repositoryA), "git/stage-1")
	f.settled(done.GetOperationId())

	directory := filepath.Join(t.TempDir(), "package")
	report, err := f.service.AsProjector().Release(fixtureContext, ownership.Handback{Directory: directory, Epoch: 2})
	if err != nil {
		t.Fatal(err)
	}
	if !report.GetMatched() {
		t.Fatalf("a drained handback did not verify: %v", report.GetChecks())
	}
	raw, err := os.ReadFile(filepath.Join(directory, ExportIndexFile))
	if err != nil {
		t.Fatal(err)
	}
	var index struct {
		FormatVersion int    `json:"formatVersion"`
		Domain        string `json:"domain"`
		Epoch         uint64 `json:"epoch"`
		EntityCount   uint64 `json:"entityCount"`
		Unresolved    uint64 `json:"unresolved"`
	}
	if err = json.Unmarshal(raw, &index); err != nil {
		t.Fatal(err)
	}
	if index.FormatVersion != ExportFormatVersion || index.Domain != ExportDomain || index.Epoch != 2 {
		t.Fatalf("the package does not describe itself: %+v", index)
	}
	if index.EntityCount != 2 {
		t.Fatalf("the package lost an operation: %d", index.EntityCount)
	}
	// The number an operator is actually looking for is in the index, not only
	// inside the records.
	if index.Unresolved != 1 {
		t.Fatalf("the unresolved count was %d, not 1", index.Unresolved)
	}
}

// The package is written once. A second attempt uses a new directory, so the
// only copy of a previous reversal is never overwritten.
func TestReleaseRefusesToOverwriteAPackage(t *testing.T) {
	f := newFixture(t)
	f.own()
	directory := filepath.Join(t.TempDir(), "package")
	if _, err := f.service.AsProjector().Release(fixtureContext, ownership.Handback{Directory: directory, Epoch: 2}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.AsProjector().Release(fixtureContext, ownership.Handback{Directory: directory, Epoch: 2}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a second export into the same directory was allowed: %v", err)
	}
}

func hasCheck(report *pb.OwnershipReport, name string, matched bool) bool {
	for _, check := range report.GetChecks() {
		if check.GetCheck() == name && check.GetMatched() == matched {
			return true
		}
	}
	return false
}
