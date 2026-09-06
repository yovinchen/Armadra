package githubhost

import (
	"context"
	"errors"
	"strconv"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/githubapi"
	"armadra.local/host/internal/storage"
)

// What happens *after* a pull request has been read or merged (design §8
// 「检查」and「清理」): restarting checks, and deleting the source branch.
//
// Both re-read the remote first and refuse when it moved. Neither one is
// bundled into another action: a merge does not delete a branch, and deleting a
// branch does not touch the local checkout or any running session.

// maxRerunTargets bounds one rerun request. A pull request whose head has more
// distinct workflow runs than this is not restarted wholesale from one click;
// the reader picks the run they mean.
const maxRerunTargets = 20

// rerunTargets picks the workflow runs a rerun would actually send.
//
// Only a run the summary itself marked `rerunnable` is eligible — that flag is
// set from the producing app, not guessed from the name — and only a run that
// did not succeed, because restarting a green check spends runner minutes to
// learn nothing. A named check narrows it to that one run.
func rerunTargets(checks *pb.GithubCheckSummary, name string) []int64 {
	seen := map[int64]bool{}
	targets := []int64{}
	for _, run := range checks.GetRuns() {
		if !run.GetRerunnable() || run.GetWorkflowRunId() <= 0 {
			continue
		}
		if name != "" && run.GetName() != name {
			continue
		}
		switch run.GetConclusion() {
		case pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_SUCCESS,
			pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_PENDING:
			// A run still in flight has nothing to restart, and a green one
			// would only be re-run to change a result that is already known.
			continue
		}
		if seen[run.GetWorkflowRunId()] {
			continue
		}
		seen[run.GetWorkflowRunId()] = true
		targets = append(targets, run.GetWorkflowRunId())
		if len(targets) == maxRerunTargets {
			break
		}
	}
	return targets
}

// RerunChecks restarts the workflow runs behind a pull request's failed checks.
//
// The head is re-read and compared with the one the reader saw: a rerun aimed
// at a commit that has since been replaced would report on work nobody asked
// about. Each run is reported on its own, so a partly accepted restart is
// visible rather than averaged into one verdict, and a run whose result was
// never read stays PENDING — never retried, because a second restart is a
// second, competing pipeline.
func (s *Service) RerunChecks(ctx context.Context, caller Caller, request *pb.RerunGithubChecksRequest) (*pb.RerunGithubChecksResponse, error) {
	if err := s.authorize(caller, ScopeWrite); err != nil {
		return nil, err
	}
	client, err := s.client(ctx)
	if err != nil {
		return nil, err
	}
	ref, err := s.repository(ctx, request.GetRepository())
	if err != nil {
		return nil, err
	}
	if len(request.GetCheckName()) > 256 {
		return nil, ErrInvalid
	}
	now := s.now().UnixMilli()
	pull, response, err := client.Pull(ctx, ref, request.GetNumber(), nil, now)
	if err != nil {
		return nil, s.translate(err)
	}
	if pull.HeadSha == "" {
		return nil, storage.ErrNotFound
	}
	if expected := request.GetExpectedHeadSha(); expected != "" && expected != pull.HeadSha {
		return &pb.RerunGithubChecksResponse{ReasonCode: "HEAD_MOVED", RateLimit: rate(response.Rate)}, nil
	}
	checks, err := client.Checks(ctx, ref, pull.HeadSha, now)
	if err != nil {
		return nil, s.translate(err)
	}
	targets := rerunTargets(checks, request.GetCheckName())
	if len(targets) == 0 {
		// Not every check can be restarted, and saying so beats a button that
		// silently does nothing.
		return &pb.RerunGithubChecksResponse{ReasonCode: "NOT_RERUNNABLE", Checks: checks, RateLimit: rate(response.Rate)}, nil
	}
	result := &pb.RerunGithubChecksResponse{RateLimit: rate(response.Rate)}
	for _, runID := range targets {
		id := strconv.FormatInt(runID, 10)
		outcome := &pb.GithubWriteOutcome{ActionId: "rerun:" + id, Target: "workflow_run", RequestedValue: id}
		switch err = client.RerunWorkflowRun(ctx, ref, runID, request.GetFailedOnly()); {
		case err == nil:
			outcome.State = pb.GithubWriteState_GITHUB_WRITE_STATE_APPLIED
		default:
			translated := s.translate(err)
			switch {
			case errors.Is(translated, ErrUnknownOutcome):
				outcome.State = pb.GithubWriteState_GITHUB_WRITE_STATE_PENDING
				outcome.ReasonCode = "UNKNOWN_OUTCOME"
			case errors.Is(translated, ErrPermission):
				outcome.State = pb.GithubWriteState_GITHUB_WRITE_STATE_FAILED
				outcome.ReasonCode = "PERMISSION_DENIED"
			case errors.Is(translated, storage.ErrNotFound):
				outcome.State = pb.GithubWriteState_GITHUB_WRITE_STATE_FAILED
				outcome.ReasonCode = "NOT_FOUND"
			case errors.Is(translated, storage.ErrConflict):
				// A conflict here is a run the remote will not restart in its
				// current state — most often one that is queued again already.
				outcome.State = pb.GithubWriteState_GITHUB_WRITE_STATE_SKIPPED
				outcome.ReasonCode = "CONFLICT"
			default:
				outcome.State = pb.GithubWriteState_GITHUB_WRITE_STATE_FAILED
				outcome.ReasonCode = "REFUSED"
			}
		}
		result.Outcomes = append(result.Outcomes, outcome)
	}
	// Re-read for the same head, so the panel is never left showing the
	// conclusions the restart was meant to replace.
	if latest, readErr := client.Checks(ctx, ref, pull.HeadSha, s.now().UnixMilli()); readErr == nil {
		result.Checks = latest
	} else {
		result.Checks = checks
	}
	return result, nil
}

// DeleteBranch removes one branch on the remote.
//
// `expected_sha` is required and re-read: a branch that advanced between the
// panel's read and this call would take unreviewed commits with it, and the
// only honest answer there is to refuse and let the reader look again. Nothing
// local is touched — the checkout, its worktree and any running session are a
// separate, separately confirmed action.
func (s *Service) DeleteBranch(ctx context.Context, caller Caller, request *pb.DeleteGithubBranchRequest) (*pb.DeleteGithubBranchResponse, error) {
	if err := s.authorize(caller, ScopeWrite); err != nil {
		return nil, err
	}
	client, err := s.client(ctx)
	if err != nil {
		return nil, err
	}
	ref, err := s.repository(ctx, request.GetRepository())
	if err != nil {
		return nil, err
	}
	branch := request.GetBranch()
	if !validRef(branch) || request.GetExpectedSha() == "" {
		return nil, ErrInvalid
	}
	current, err := client.Ref(ctx, ref, branch)
	if err != nil {
		if githubapi.CodeOf(err) == githubapi.CodeNotFound {
			// Already gone. That is the state the caller wanted, but it was not
			// this call that produced it, so it is reported as a refusal with a
			// reason rather than as a deletion.
			return &pb.DeleteGithubBranchResponse{ReasonCode: "NOT_FOUND"}, nil
		}
		return nil, s.translate(err)
	}
	if current != request.GetExpectedSha() {
		return &pb.DeleteGithubBranchResponse{ReasonCode: "REF_MOVED"}, nil
	}
	if err = client.DeleteRef(ctx, ref, branch); err != nil {
		translated := s.translate(err)
		switch {
		case errors.Is(translated, ErrUnknownOutcome):
			// The delete may have been applied; re-reading is the only honest
			// answer, and a repeat is never sent automatically.
			if _, readErr := client.Ref(ctx, ref, branch); readErr != nil && githubapi.CodeOf(readErr) == githubapi.CodeNotFound {
				return &pb.DeleteGithubBranchResponse{Deleted: true}, nil
			}
			return &pb.DeleteGithubBranchResponse{ReasonCode: "UNKNOWN_OUTCOME"}, nil
		case errors.Is(translated, ErrPermission):
			// Branch protection and a missing push permission look the same
			// from here, and both mean "the remote will not let this happen".
			return &pb.DeleteGithubBranchResponse{ReasonCode: "PROTECTED"}, nil
		case errors.Is(translated, storage.ErrNotFound):
			return &pb.DeleteGithubBranchResponse{ReasonCode: "NOT_FOUND"}, nil
		case errors.Is(translated, storage.ErrConflict):
			return &pb.DeleteGithubBranchResponse{ReasonCode: "REF_MOVED"}, nil
		}
		return nil, translated
	}
	return &pb.DeleteGithubBranchResponse{Deleted: true}, nil
}
