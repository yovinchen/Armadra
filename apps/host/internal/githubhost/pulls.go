package githubhost

import (
	"context"
	"errors"
	"strconv"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/githubapi"
	"armadra.local/host/internal/storage"
)

// Pull requests (design §8). The merge path is the reason most of this file
// exists: a merge carries the exact head the reader saw, and the Host re-reads
// the pull request and its checks before sending anything.

// mergeMethods reads the strategies the repository actually allows. A method
// the repository has disabled is never offered, so the panel cannot present a
// button that is guaranteed to be refused.
func (s *Service) mergeMethods(ctx context.Context, client *githubapi.Client, ref *pb.GithubRepositoryRef) []pb.GithubMergeMethod {
	repository, _, err := client.Repository(ctx, ref, s.now().UnixMilli())
	if err != nil {
		return nil
	}
	return repository.AllowedMergeMethods
}

func (s *Service) ListPulls(ctx context.Context, caller Caller, request *pb.ListGithubPullsRequest) (*pb.ListGithubPullsResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
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
	page, err := decodeCursor(request.GetAfterCursor())
	if err != nil {
		return nil, err
	}
	now := s.now().UnixMilli()
	allowed := s.mergeMethods(ctx, client, ref)
	pulls, response, err := client.Pulls(ctx, ref, request.GetFilter(), page, pageLimit(request.GetLimit()), allowed, now)
	if err != nil {
		return nil, s.translate(err)
	}
	return &pb.ListGithubPullsResponse{
		Pulls:            pulls,
		NextCursor:       encodeCursor(response.NextPage),
		HasMore:          response.NextPage >= 2,
		RateLimit:        rate(response.Rate),
		FromCache:        response.FromCache,
		ObservedAtUnixMs: now,
		PollIntervalMs:   PollIntervalMS,
	}, nil
}

// GetPull reads one pull request with its file summary, reviews, comments and
// the checks for its current head. The checks are always read for the head this
// response reports, so a summary can never describe a different commit.
func (s *Service) GetPull(ctx context.Context, caller Caller, request *pb.GetGithubPullRequest) (*pb.GetGithubPullResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
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
	now := s.now().UnixMilli()
	allowed := s.mergeMethods(ctx, client, ref)
	pull, response, err := client.Pull(ctx, ref, request.GetNumber(), allowed, now)
	if err != nil {
		return nil, s.translate(err)
	}
	files, err := client.PullFiles(ctx, ref, pull.Number, maxFiles)
	if err != nil {
		return nil, s.translate(err)
	}
	reviews, err := client.PullReviews(ctx, ref, pull.Number, maxComments)
	if err != nil {
		return nil, s.translate(err)
	}
	reviewComments, err := client.PullReviewComments(ctx, ref, pull.Number, maxComments)
	if err != nil {
		return nil, s.translate(err)
	}
	comments, err := client.IssueComments(ctx, ref, pull.Number, maxComments)
	if err != nil {
		return nil, s.translate(err)
	}
	result := &pb.GetGithubPullResponse{
		Pull:           pull,
		Files:          files,
		Reviews:        reviews,
		ReviewComments: reviewComments,
		Comments:       comments,
		RateLimit:      rate(response.Rate),
		PollIntervalMs: PollIntervalMS,
	}
	if pull.HeadSha != "" {
		checks, err := client.Checks(ctx, ref, pull.HeadSha, now)
		if err != nil {
			return nil, s.translate(err)
		}
		result.Checks = checks
	}
	if result.References, err = s.referencesFor(ctx, caller.WorkspaceID, ref, pb.GithubReferenceKind_GITHUB_REFERENCE_KIND_PULL_REQUEST, pull.Number); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) GetChecks(ctx context.Context, caller Caller, request *pb.GetGithubChecksRequest) (*pb.GithubCheckSummary, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
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
	now := s.now().UnixMilli()
	pull, _, err := client.Pull(ctx, ref, request.GetNumber(), nil, now)
	if err != nil {
		return nil, s.translate(err)
	}
	if pull.HeadSha == "" {
		return nil, storage.ErrNotFound
	}
	checks, err := client.Checks(ctx, ref, pull.HeadSha, now)
	if err != nil {
		return nil, s.translate(err)
	}
	return checks, nil
}

// validRef accepts a branch name a request may name. It is deliberately
// stricter than git itself: nothing here needs a ref carrying a control
// character or a pattern character.
func validRef(value string) bool {
	if value == "" || len(value) > 255 || strings.HasPrefix(value, "-") || strings.Contains(value, "..") {
		return false
	}
	for _, r := range value {
		if r <= 0x20 || r == 0x7f || strings.ContainsRune("~^:?*[\\", r) {
			return false
		}
	}
	return true
}

// CreatePull checks that the head branch exists on the remote before asking for
// a pull request, so a branch that was never pushed produces a clear answer
// instead of an opaque remote refusal.
func (s *Service) CreatePull(ctx context.Context, caller Caller, request *pb.CreateGithubPullRequest) (*pb.GithubPullRequest, error) {
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
	base, head := request.GetBaseRef(), request.GetHeadRef()
	if !validRef(base) || !validRef(head) || base == head {
		return nil, ErrInvalid
	}
	if request.GetTitle() == "" || len(request.GetTitle()) > 256 || len(request.GetBody()) > 65536 {
		return nil, ErrInvalid
	}
	remoteHead, err := client.Ref(ctx, ref, head)
	if err != nil {
		if githubapi.CodeOf(err) == githubapi.CodeNotFound {
			return nil, storage.ErrNotFound
		}
		return nil, s.translate(err)
	}
	// The caller passes the head it believes is pushed; a branch that moved
	// since then would open a pull request for the wrong commits.
	if expected := request.GetExpectedHeadSha(); expected != "" && expected != remoteHead {
		return nil, storage.ErrConflict
	}
	body := map[string]any{"title": request.GetTitle(), "base": base, "head": head}
	text := request.GetBody()
	if number := request.GetLinkedIssueNumber(); number > 0 {
		// The link is written as text the remote itself understands, and also
		// recorded locally as a reference below.
		if text != "" {
			text += "\n\n"
		}
		text += "Closes #" + strconv.FormatInt(number, 10)
	}
	if text != "" {
		body["body"] = text
	}
	if request.GetDraft() {
		body["draft"] = true
	}
	allowed := s.mergeMethods(ctx, client, ref)
	pull, err := client.CreatePull(ctx, ref, body, allowed, s.now().UnixMilli())
	if err != nil {
		return nil, s.translate(err)
	}
	return pull, nil
}

// SubmitReview posts one review anchored to the commit the reviewer read.
// Inline comments carry that commit, so an outdated draft is recognisable
// rather than silently attached to a line it no longer describes.
func (s *Service) SubmitReview(ctx context.Context, caller Caller, request *pb.SubmitGithubReviewRequest) (*pb.GithubReview, error) {
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
	event := ""
	switch request.GetState() {
	case pb.GithubReviewState_GITHUB_REVIEW_STATE_APPROVED:
		event = "APPROVE"
	case pb.GithubReviewState_GITHUB_REVIEW_STATE_CHANGES_REQUESTED:
		event = "REQUEST_CHANGES"
	case pb.GithubReviewState_GITHUB_REVIEW_STATE_COMMENTED:
		event = "COMMENT"
	default:
		return nil, ErrInvalid
	}
	if event == "REQUEST_CHANGES" && strings.TrimSpace(request.GetBody()) == "" {
		return nil, ErrInvalid
	}
	if len(request.GetBody()) > 65536 || len(request.GetComments()) > 200 {
		return nil, ErrInvalid
	}
	body := map[string]any{"event": event}
	if request.GetCommitSha() != "" {
		body["commit_id"] = request.GetCommitSha()
	}
	if request.GetBody() != "" {
		body["body"] = request.GetBody()
	}
	comments := []map[string]any{}
	for _, draft := range request.GetComments() {
		if draft.GetPath() == "" || len(draft.GetPath()) > 4096 || draft.GetLine() <= 0 || strings.TrimSpace(draft.GetBody()) == "" {
			return nil, ErrInvalid
		}
		side := draft.GetSide()
		if side != "LEFT" && side != "RIGHT" {
			return nil, ErrInvalid
		}
		comments = append(comments, map[string]any{"path": draft.GetPath(), "line": draft.GetLine(), "side": side, "body": draft.GetBody()})
	}
	if len(comments) > 0 {
		body["comments"] = comments
	}
	review, err := client.CreateReview(ctx, ref, request.GetNumber(), body)
	if err != nil {
		return nil, s.translate(err)
	}
	return review, nil
}

// MergePull refuses unless the remote still holds exactly the head, and exactly
// the check rollup, that the caller said it displayed. A locally green screen
// is not a promise the remote will still accept the merge, so everything is
// re-read here rather than trusted.
func (s *Service) MergePull(ctx context.Context, caller Caller, request *pb.MergeGithubPullRequest) (*pb.MergeGithubPullResponse, error) {
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
	method, err := mergeMethodName(request.GetMethod())
	if err != nil {
		return nil, err
	}
	if request.GetExpectedHeadSha() == "" {
		return nil, ErrInvalid
	}
	now := s.now().UnixMilli()
	allowed := s.mergeMethods(ctx, client, ref)
	pull, _, err := client.Pull(ctx, ref, request.GetNumber(), allowed, now)
	if err != nil {
		return nil, s.translate(err)
	}
	refuse := func(reason string, checks *pb.GithubCheckSummary) *pb.MergeGithubPullResponse {
		return &pb.MergeGithubPullResponse{Merged: false, ReasonCode: reason, Pull: pull, Checks: checks}
	}
	if pull.HeadSha != request.GetExpectedHeadSha() {
		return refuse("HEAD_MOVED", nil), nil
	}
	if len(allowed) > 0 && !allows(allowed, request.GetMethod()) {
		return refuse("METHOD_NOT_ALLOWED", nil), nil
	}
	var checks *pb.GithubCheckSummary
	if request.GetExpectedCheckRollup() != pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_UNSPECIFIED {
		if checks, err = client.Checks(ctx, ref, pull.HeadSha, now); err != nil {
			return nil, s.translate(err)
		}
		if checks.Rollup != request.GetExpectedCheckRollup() {
			return refuse("CHECKS_CHANGED", checks), nil
		}
	}
	switch pull.Mergeable {
	case pb.GithubMergeableState_GITHUB_MERGEABLE_STATE_CONFLICTING:
		return refuse("NOT_MERGEABLE", checks), nil
	case pb.GithubMergeableState_GITHUB_MERGEABLE_STATE_BLOCKED:
		// Protection rules and merge queues are the remote's decision; the Host
		// reports what it was told rather than trying anyway.
		return refuse("BLOCKED", checks), nil
	}
	sha, err := client.Merge(ctx, ref, pull.Number, pull.HeadSha, method, request.GetCommitTitle(), request.GetCommitMessage())
	if err != nil {
		translated := s.translate(err)
		switch {
		case errors.Is(translated, ErrUnknownOutcome):
			// The merge may have been accepted. Re-reading is the only honest
			// answer; retrying would risk a second merge commit.
			if latest, _, readErr := client.Pull(ctx, ref, pull.Number, allowed, s.now().UnixMilli()); readErr == nil {
				pull = latest
				if latest.State == pb.GithubPullState_GITHUB_PULL_STATE_MERGED {
					return &pb.MergeGithubPullResponse{Merged: true, MergeSha: latest.HeadSha, Pull: latest, Checks: checks}, nil
				}
			}
			return refuse("UNKNOWN_OUTCOME", checks), nil
		case errors.Is(translated, storage.ErrConflict), errors.Is(translated, ErrInvalid):
			// The remote refused. Which refusal it was is decided by evidence:
			// a head that still matches means the merge itself was rejected,
			// not that the branch moved underneath the reader.
			if latest, _, readErr := client.Pull(ctx, ref, pull.Number, allowed, s.now().UnixMilli()); readErr == nil {
				pull = latest
				if latest.HeadSha != request.GetExpectedHeadSha() {
					return refuse("HEAD_MOVED", checks), nil
				}
			}
			return refuse("NOT_MERGEABLE", checks), nil
		case errors.Is(translated, ErrPermission):
			return refuse("BLOCKED", checks), nil
		}
		return nil, translated
	}
	latest, _, readErr := client.Pull(ctx, ref, pull.Number, allowed, s.now().UnixMilli())
	if readErr == nil {
		pull = latest
	}
	return &pb.MergeGithubPullResponse{Merged: true, MergeSha: sha, Pull: pull, Checks: checks}, nil
}

func allows(methods []pb.GithubMergeMethod, method pb.GithubMergeMethod) bool {
	for _, candidate := range methods {
		if candidate == method {
			return true
		}
	}
	return false
}

func mergeMethodName(method pb.GithubMergeMethod) (string, error) {
	switch method {
	case pb.GithubMergeMethod_GITHUB_MERGE_METHOD_MERGE:
		return "merge", nil
	case pb.GithubMergeMethod_GITHUB_MERGE_METHOD_SQUASH:
		return "squash", nil
	case pb.GithubMergeMethod_GITHUB_MERGE_METHOD_REBASE:
		return "rebase", nil
	}
	return "", ErrInvalid
}
