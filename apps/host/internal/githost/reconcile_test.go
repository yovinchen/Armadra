package githost

import (
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// Reconciliation after a restart (§5.3, Git 设计 §10).
//
// The rule is deliberately unhelpful, and the tests are about exactly that: an
// interrupted push is not retried, is not failed, and is not succeeded. It is
// left as the one honest thing anybody can say about it.

// leftRunning writes an entry in the state a killed Host leaves behind.
func (f *fixture) leftRunning(kind pb.GitActionKind, expectedHead string) *pb.GitOperation {
	f.t.Helper()
	action := []byte(`{"kind":"x"}`)
	operation := &pb.GitOperation{
		OperationId:     "0000000000000009-orphan-" + kind.String(),
		Scope:           scopeAt(mainPath, repositoryA),
		Action:          action,
		ActionSha256:    digest(action),
		Expected:        &pb.GitExpectation{HeadOid: expectedHead},
		Kind:            kind,
		State:           pb.GitOperationState_GIT_OPERATION_STATE_RUNNING,
		CreatedAtUnixMs: f.clock.UnixMilli(),
		StartedAtUnixMs: f.clock.UnixMilli(),
	}
	stored, _, err := f.service.put(fixtureContext, "test/"+operation.GetOperationId(), workspaceID, operation, 0)
	if err != nil {
		f.t.Fatal(err)
	}
	return stored
}

// Anything that could have reached a remote is unknown, and stays unknown. No
// local reading settles it, and this Host will not pretend otherwise.
func TestAnInterruptedPushStaysUnknown(t *testing.T) {
	f := newFixture(t)
	f.own()
	orphan := f.leftRunning(pb.GitActionKind_GIT_ACTION_KIND_PUSH, "1f2e3d4c5b6a798807162534435261708f9e0d1c")
	settled, err := f.service.Reconcile(fixtureContext)
	if err != nil {
		t.Fatal(err)
	}
	if settled != 1 {
		t.Fatalf("expected one entry to be settled, got %d", settled)
	}
	after, err := f.service.operation(fixtureContext, workspaceID, orphan.GetOperationId())
	if err != nil {
		t.Fatal(err)
	}
	if after.GetState() != pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME {
		t.Fatalf("an interrupted push was settled as %v", after.GetState())
	}
	// Nothing was re-run. A re-run push that the first attempt had already
	// delivered advances the remote ref twice.
	started, _ := f.executor.order()
	if len(started) != 0 {
		t.Fatalf("reconciliation ran a command: %v", started)
	}
}

// A commit is the one case a reading settles: the operation named the HEAD it
// was decided against, so a HEAD that is no longer that one is the commit
// having landed.
func TestAnInterruptedCommitIsSettledByReadingHead(t *testing.T) {
	f := newFixture(t)
	f.own()
	before := "1f2e3d4c5b6a798807162534435261708f9e0d1c"
	f.executor.head = "aabbccddeeff00112233445566778899aabbccdd"
	orphan := f.leftRunning(pb.GitActionKind_GIT_ACTION_KIND_COMMIT, before)
	if _, err := f.service.Reconcile(fixtureContext); err != nil {
		t.Fatal(err)
	}
	after, err := f.service.operation(fixtureContext, workspaceID, orphan.GetOperationId())
	if err != nil {
		t.Fatal(err)
	}
	if after.GetState() != pb.GitOperationState_GIT_OPERATION_STATE_SUCCEEDED {
		t.Fatalf("a commit whose HEAD moved was settled as %v", after.GetState())
	}
}

// The same commit with an unchanged HEAD did not land. That is a failure, and
// it is safe to call one: nothing happened, so nothing is unknown.
func TestAnInterruptedCommitWhoseHeadDidNotMoveFailed(t *testing.T) {
	f := newFixture(t)
	f.own()
	head := "1f2e3d4c5b6a798807162534435261708f9e0d1c"
	f.executor.head = head
	orphan := f.leftRunning(pb.GitActionKind_GIT_ACTION_KIND_COMMIT, head)
	if _, err := f.service.Reconcile(fixtureContext); err != nil {
		t.Fatal(err)
	}
	after, err := f.service.operation(fixtureContext, workspaceID, orphan.GetOperationId())
	if err != nil {
		t.Fatal(err)
	}
	if after.GetState() != pb.GitOperationState_GIT_OPERATION_STATE_FAILED {
		t.Fatalf("a commit that never landed was settled as %v", after.GetState())
	}
}

// A rebase interrupted halfway leaves a repository a person has to look at. An
// automatic verdict on it would be a guess wearing a check's clothes.
func TestAnInterruptedRebaseIsUnknown(t *testing.T) {
	f := newFixture(t)
	f.own()
	orphan := f.leftRunning(pb.GitActionKind_GIT_ACTION_KIND_START_REBASE, "1f2e3d4c5b6a798807162534435261708f9e0d1c")
	if _, err := f.service.Reconcile(fixtureContext); err != nil {
		t.Fatal(err)
	}
	after, err := f.service.operation(fixtureContext, workspaceID, orphan.GetOperationId())
	if err != nil {
		t.Fatal(err)
	}
	if after.GetState() != pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME {
		t.Fatalf("an interrupted rebase was settled as %v", after.GetState())
	}
}

// Queued and never started is the one case the Host may answer for itself:
// nothing ran, so nothing is unknown.
func TestAnEntryThatNeverStartedIsCancelled(t *testing.T) {
	f := newFixture(t)
	f.own()
	orphan := f.leftRunning(pb.GitActionKind_GIT_ACTION_KIND_PUSH, "")
	queued := proto.Clone(orphan).(*pb.GitOperation)
	queued.State = pb.GitOperationState_GIT_OPERATION_STATE_QUEUED
	queued.StartedAtUnixMs = 0
	if _, _, err := f.service.put(fixtureContext, "test/requeue", workspaceID, queued, orphan.GetRevision()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Reconcile(fixtureContext); err != nil {
		t.Fatal(err)
	}
	after, err := f.service.operation(fixtureContext, workspaceID, orphan.GetOperationId())
	if err != nil {
		t.Fatal(err)
	}
	if after.GetState() != pb.GitOperationState_GIT_OPERATION_STATE_CANCELLED {
		t.Fatalf("an entry that never started was settled as %v", after.GetState())
	}
}

// While the Runtime owns the domain there is nothing of this Host's in flight,
// and rewriting rows it does not own would be a second writer.
func TestReconciliationDoesNothingWhileTheRuntimeOwnsTheDomain(t *testing.T) {
	f := newFixture(t)
	f.own()
	orphan := f.leftRunning(pb.GitActionKind_GIT_ACTION_KIND_PUSH, "")
	// Hand the domain back before reconciling.
	record, err := f.store.Ownership(fixtureContext, Domain)
	if err != nil {
		t.Fatal(err)
	}
	record.Owner = "runtime"
	record.Epoch = 3
	if _, err = f.store.PutOwnership(fixtureContext, record, record.Revision); err != nil {
		t.Fatal(err)
	}
	settled, err := f.service.Reconcile(fixtureContext)
	if err != nil {
		t.Fatal(err)
	}
	if settled != 0 {
		t.Fatalf("reconciliation touched %d rows it does not own", settled)
	}
	after, err := f.service.operation(fixtureContext, workspaceID, orphan.GetOperationId())
	if err != nil {
		t.Fatal(err)
	}
	if after.GetState() != pb.GitOperationState_GIT_OPERATION_STATE_RUNNING {
		t.Fatalf("a row was rewritten under another owner: %v", after.GetState())
	}
}
