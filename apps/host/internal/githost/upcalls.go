package githost

import (
	"context"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// Upward reports from the execution host (§2.9 上行帧 180, Git 设计 §10).
//
// The first phase of this domain learned nothing between "the frame was sent"
// and "the frame came back", so a `git fetch` against a slow remote and one
// that had not started looked identical, and a clone was invisible until it
// ended. These frames are the execution host saying what it is doing, and the
// Host turning that into the entries a client already follows: an operation's
// `progress` (event 220) and a clone job's (event 222).
//
// Three rules keep a report from becoming a decision:
//
//  1. **Only a running entry is advanced.** A progress frame for an operation
//     that has already settled is dropped. Progress arrives asynchronously, so
//     a frame written before the outcome can be delivered after it, and
//     applying it would move a finished push back to RUNNING.
//  2. **An outcome is never taken from here.** `RunGitOperation`'s response is
//     what settles an entry, because that is the answer to the frame this Host
//     sent; an upcall is a report about it. The `OPERATION_FINISHED` kind is
//     therefore used only to stop showing progress, never to write a state.
//     Clones are the exception and say so below.
//  3. **A dropped report costs a stale bar, never a wrong record.** Every value
//     these frames carry can also be read by asking, so a report that never
//     arrives leaves the Host one poll behind rather than wrong.

// ApplyUpcall records one git report. It is called by the Worker channel's
// pump, so it must be quick and must not block on anything but the store.
//
// A frame this build cannot use is not an error: the Worker would replay it
// forever, and there is nothing to replay it *for*.
func (s *Service) ApplyUpcall(ctx context.Context, frame *pb.WorkerGitUpcall) error {
	if s == nil || frame == nil {
		return nil
	}
	workspace := frame.GetWorkspaceId()
	if !validID(workspace) {
		return nil
	}
	switch frame.GetKind() {
	case pb.WorkerGitUpcallKind_WORKER_GIT_UPCALL_KIND_OPERATION_PROGRESS:
		return s.applyOperationProgress(ctx, workspace, frame)
	case pb.WorkerGitUpcallKind_WORKER_GIT_UPCALL_KIND_CLONE_PROGRESS,
		pb.WorkerGitUpcallKind_WORKER_GIT_UPCALL_KIND_CLONE_FINISHED:
		return s.applyCloneReport(ctx, workspace, frame)
	case pb.WorkerGitUpcallKind_WORKER_GIT_UPCALL_KIND_REPOSITORY_CHANGED:
		return s.applyRepositoryChanged(ctx, workspace, frame)
	default:
		// OPERATION_FINISHED, CONFLICT_DETECTED and WORKTREE_CHANGED are
		// observations this Host already learns from the frame it sent or from
		// the observation it makes after a write. Accepting them without acting
		// is what lets the Worker retire them from its outbox.
		return nil
	}
}

// applyOperationProgress moves one running entry's percentage.
func (s *Service) applyOperationProgress(ctx context.Context, workspace string, frame *pb.WorkerGitUpcall) error {
	operationID := frame.GetOperationId()
	if !validID(operationID) {
		return nil
	}
	operation, err := s.operation(ctx, workspace, operationID)
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrInvalid) {
		return nil
	}
	if err != nil {
		return err
	}
	// Rule 1: a settled entry is never reopened, and progress never goes
	// backwards — a fetch reports several phases, each restarting at zero, and
	// a bar that jumped back would read as a retry that did not happen.
	progress := frame.GetProgress()
	if operation.GetState() != pb.GitOperationState_GIT_OPERATION_STATE_RUNNING ||
		progress > 100 || progress <= operation.GetProgress() {
		return nil
	}
	next := proto.Clone(operation).(*pb.GitOperation)
	next.Progress = progress
	_, err = s.record(ctx, workspace, next, operation.GetRevision(), "progress")
	// A CAS miss means the entry moved while this frame was in flight, which is
	// the case rule 1 exists for. It is not a delivery failure.
	if errors.Is(err, storage.ErrConflict) || errors.Is(err, storage.ErrIdempotencyConflict) {
		return nil
	}
	return err
}

// applyCloneReport moves one clone job.
//
// Clones are the one place a terminal state does come from a report. A clone
// has no response frame to settle it: the frame that started it returned as
// soon as `git` was running, and the job then lives on the execution host until
// somebody asks. Taking the end from here is what lets a person watch a clone
// finish instead of discovering it on the next poll — and `GetClone` still
// re-reads the job, so a lost frame costs a slower answer, never a wrong one.
func (s *Service) applyCloneReport(ctx context.Context, workspace string, frame *pb.WorkerGitUpcall) error {
	jobID := frame.GetOperationId()
	if !validID(jobID) {
		return nil
	}
	job, err := s.cloneJob(ctx, workspace, jobID)
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrInvalid) {
		return nil
	}
	if err != nil {
		return err
	}
	if job.GetState() != pb.GitCloneState_GIT_CLONE_STATE_RUNNING {
		return nil
	}
	next := proto.Clone(job).(*pb.GitCloneJob)
	if progress := frame.GetProgress(); progress <= 100 && progress > job.GetProgress() {
		next.Progress = progress
	}
	if frame.GetKind() == pb.WorkerGitUpcallKind_WORKER_GIT_UPCALL_KIND_CLONE_FINISHED {
		switch frame.GetState() {
		case pb.GitOperationState_GIT_OPERATION_STATE_SUCCEEDED:
			next.State = pb.GitCloneState_GIT_CLONE_STATE_SUCCEEDED
		case pb.GitOperationState_GIT_OPERATION_STATE_CANCELLED:
			next.State = pb.GitCloneState_GIT_CLONE_STATE_CANCELLED
		case pb.GitOperationState_GIT_OPERATION_STATE_FAILED:
			next.State = pb.GitCloneState_GIT_CLONE_STATE_FAILED
		default:
			// A terminal report that names no terminal state says nothing this
			// Host can record; the next `GetClone` reads the job instead.
			return nil
		}
		next.MessageCode = frame.GetReasonCode()
	}
	if next.GetState() == job.GetState() && next.GetProgress() == job.GetProgress() {
		return nil
	}
	next.UpdatedAtUnixMs = s.now()
	_, _, err = s.putClone(ctx, "githost/"+workspace+"/clone/"+jobID+"/report/"+cloneReportSeed(next), workspace, next, job.GetRevision())
	if errors.Is(err, storage.ErrConflict) || errors.Is(err, storage.ErrIdempotencyConflict) {
		return nil
	}
	return err
}

// cloneReportSeed makes one report's idempotency key. It is the state and the
// percentage, so a replayed frame lands on the record it already produced
// rather than on a second one.
func cloneReportSeed(job *pb.GitCloneJob) string {
	return job.GetState().String() + "/" + itoa(job.GetProgress())
}

func itoa(value uint32) string {
	if value == 0 {
		return "0"
	}
	digits := [4]byte{}
	index := len(digits)
	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[index:])
}

// applyRepositoryChanged refreshes the cached snapshot from the frame that
// announced the change, rather than by a follow-up read that could observe a
// third state.
func (s *Service) applyRepositoryChanged(ctx context.Context, workspace string, frame *pb.WorkerGitUpcall) error {
	state := frame.GetRepository()
	if state == nil || state.GetObservedAtUnixMs() <= 0 || state.GetScope() == nil {
		return nil
	}
	if state.GetScope().GetWorkspaceId() != workspace {
		return nil
	}
	_, err := s.storeState(ctx, workspace, proto.Clone(state).(*pb.RepositoryState))
	if errors.Is(err, storage.ErrConflict) || errors.Is(err, storage.ErrIdempotencyConflict) {
		return nil
	}
	return err
}
