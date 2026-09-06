package githost

import (
	"context"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// Reconciliation after a restart (Go Host 业务所有权迁移 §5.3, Git 设计 §10).
//
// A RUNNING row at startup means the same thing every time: this Host handed a
// command to the execution host and then stopped existing before it heard back.
// The command may have completed, may have half-completed, may never have
// started. Nothing in the row says which, and nothing in the repository says it
// either for the operations that matter most.
//
// So the rule is deliberately unhelpful, and that is the design:
//
//   - **Nothing is retried.** Not automatically, not "if it looks safe". A
//     re-run push that the first attempt had already delivered advances the
//     remote ref twice; a re-run commit makes two commits. The one thing worse
//     than not knowing is acting as though you did.
//   - **Anything that could have touched a remote is `UNKNOWN_OUTCOME`.** Fetch,
//     pull, push, sync and tag pushes. No local reading settles them, and this
//     Host will not pretend otherwise.
//   - **A local write is checked against the repository, once.** A commit whose
//     `expected.head_oid` is no longer HEAD did move the branch, so it
//     succeeded; one whose HEAD is unchanged did not, so it failed. That is a
//     reading of the repository, not a guess about the process.
//   - **Everything else is `UNKNOWN_OUTCOME`.** A rebase interrupted halfway
//     leaves a repository in a state a person has to look at.
//
// `UNKNOWN_OUTCOME` is a state a person resolves. It is never shown as a
// failure, because a failure is something you retry.

// Reconcile settles every operation this Host left running.
//
// It runs once at startup, before the queue accepts anything new: an entry
// still marked RUNNING while a new one is dispatched would let two writes into
// one checkout, which is the one thing the queue exists to prevent.
func (s *Service) Reconcile(ctx context.Context) (int, error) {
	if s == nil {
		return 0, nil
	}
	owned, err := s.Owned(ctx)
	if err != nil || !owned {
		// While the Runtime owns the domain there is nothing of this Host's in
		// flight, and rewriting rows it does not own would be a second writer.
		return 0, err
	}
	workspaces, err := s.store.WorkspacesOfKind(ctx, OperationKind)
	if err != nil {
		return 0, err
	}
	settled := 0
	for _, workspaceID := range workspaces {
		operations, err := s.operations(ctx, workspaceID)
		if err != nil {
			return settled, err
		}
		for _, operation := range operations {
			if terminal(operation.GetState()) {
				continue
			}
			next, err := s.reconcileOne(ctx, workspaceID, operation)
			if err != nil {
				return settled, err
			}
			if next {
				settled++
			}
		}
	}
	return settled, nil
}

func (s *Service) reconcileOne(ctx context.Context, workspaceID string, operation *pb.GitOperation) (bool, error) {
	next := proto.Clone(operation).(*pb.GitOperation)
	next.FinishedAtUnixMs = s.now()
	switch {
	case operation.GetState() == pb.GitOperationState_GIT_OPERATION_STATE_QUEUED:
		// Queued and never started. Nothing ran, so nothing is unknown: this is
		// the one case where the Host may say what happened, and what happened
		// is nothing.
		next.State = pb.GitOperationState_GIT_OPERATION_STATE_CANCELLED
		next.MessageCode = "git.operation.abandoned_before_start"
	case networkKind(operation.GetKind()):
		next.State = pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME
		next.MessageCode = "git.operation.remote_unknown"
	default:
		next.State, next.MessageCode = s.settleLocal(ctx, workspaceID, operation)
	}
	_, err := s.record(ctx, workspaceID, next, operation.GetRevision(), "reconcile")
	return err == nil, err
}

// settleLocal reads the repository once and decides only what the reading
// actually settles.
//
// A commit is the case this can answer: the operation named the HEAD it was
// decided against, so a HEAD that is no longer that one is the commit having
// landed. Anything else — a rebase, a reset, a stash — leaves a repository
// whose state a person has to look at, and an automatic verdict on it would be
// a guess wearing a check's clothes.
func (s *Service) settleLocal(ctx context.Context, workspaceID string, operation *pb.GitOperation) (pb.GitOperationState, string) {
	if operation.GetKind() != pb.GitActionKind_GIT_ACTION_KIND_COMMIT || s.executor == nil {
		return pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME, "git.operation.interrupted"
	}
	expected := operation.GetExpected().GetHeadOid()
	if expected == "" {
		// Nothing was named to compare against, so there is nothing to read.
		return pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME, "git.operation.interrupted"
	}
	root, err := s.workspaceRoot(ctx, workspaceID)
	if err != nil {
		return pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME, "git.operation.interrupted"
	}
	state, err := s.executor.ObserveRepository(ctx, operation.GetScope(), root)
	if err != nil || state == nil || state.GetHeadOid() == "" {
		// An execution host that cannot be read leaves the outcome exactly as
		// unknown as it was.
		return pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME, "git.operation.interrupted"
	}
	if state.GetHeadOid() != expected {
		return pb.GitOperationState_GIT_OPERATION_STATE_SUCCEEDED, "git.operation.committed"
	}
	return pb.GitOperationState_GIT_OPERATION_STATE_FAILED, "git.operation.not_committed"
}
