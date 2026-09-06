package githubapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
)

// Endpoint wrappers. Each one validates the reference before building a path,
// so an owner or repository name can never widen a request beyond the
// repository the caller named.

func (c *Client) repoPath(ref *pb.GithubRepositoryRef, suffix string) (string, error) {
	if ref == nil || !ValidName(ref.Owner) || !ValidName(ref.Name) {
		return "", fail(CodeInvalid, 0, "REPOSITORY_INVALID")
	}
	// A reference for a different service would send this repository's name,
	// and this token, to the wrong authority.
	if ref.ApiBase != "" && ref.ApiBase != c.APIBase() {
		return "", fail(CodeInvalid, 0, "API_BASE_MISMATCH")
	}
	return "/repos/" + ref.Owner + "/" + ref.Name + suffix, nil
}

func decode[T any](response Response) (T, error) {
	var value T
	if err := json.Unmarshal(response.Body, &value); err != nil {
		return value, fail(CodeInvalid, response.Status, "RESPONSE_MALFORMED")
	}
	return value, nil
}

func perPage(limit int) string {
	if limit <= 0 || limit > MaxPerPage {
		limit = MaxPerPage
	}
	return strconv.Itoa(limit)
}

// Repository reads the repository itself, which is also where the merge
// strategies and the viewer's permission come from.
func (c *Client) Repository(ctx context.Context, ref *pb.GithubRepositoryRef, atMS int64) (*pb.GithubRepository, Response, error) {
	path, err := c.repoPath(ref, "")
	if err != nil {
		return nil, Response{}, err
	}
	response, err := c.Get(ctx, path, nil)
	if err != nil {
		return nil, response, err
	}
	value, err := decode[wireRepository](response)
	if err != nil {
		return nil, response, err
	}
	return &pb.GithubRepository{
		Ref:                 ref,
		Id:                  value.ID,
		DefaultBranch:       value.DefaultBranch,
		Private:             value.Private,
		Fork:                value.Fork,
		HasIssues:           value.HasIssues,
		AllowedMergeMethods: mergeMethods(value),
		Permission:          permission(value),
		ObservedAtUnixMs:    atMS,
	}, response, nil
}

func issueQuery(filter *pb.GithubIssueFilter, page, limit int) url.Values {
	query := url.Values{"per_page": {perPage(limit)}, "sort": {"updated"}, "direction": {"desc"}}
	if page > 1 {
		query.Set("page", strconv.Itoa(page))
	}
	state := "all"
	if filter != nil {
		switch filter.State {
		case pb.GithubIssueState_GITHUB_ISSUE_STATE_OPEN:
			state = "open"
		case pb.GithubIssueState_GITHUB_ISSUE_STATE_CLOSED:
			state = "closed"
		}
		if len(filter.Labels) > 0 {
			query.Set("labels", strings.Join(filter.Labels, ","))
		}
		if filter.Assignee != "" {
			query.Set("assignee", filter.Assignee)
		}
		if filter.Author != "" {
			query.Set("creator", filter.Author)
		}
		if filter.MilestoneNumber > 0 {
			query.Set("milestone", strconv.FormatInt(filter.MilestoneNumber, 10))
		}
	}
	query.Set("state", state)
	return query
}

// Issues lists one page. The Issues endpoint also returns pull requests, so
// anything carrying a pull_request member is dropped here rather than shown in
// an Issues list where closing it would mean something else.
func (c *Client) Issues(ctx context.Context, ref *pb.GithubRepositoryRef, filter *pb.GithubIssueFilter, page, limit int, atMS int64) ([]*pb.GithubIssue, Response, error) {
	path, err := c.repoPath(ref, "/issues")
	if err != nil {
		return nil, Response{}, err
	}
	response, err := c.Get(ctx, path, issueQuery(filter, page, limit))
	if err != nil {
		return nil, response, err
	}
	values, err := decode[[]wireIssue](response)
	if err != nil {
		return nil, response, err
	}
	issues := make([]*pb.GithubIssue, 0, len(values))
	needle := strings.ToLower(strings.TrimSpace(filterQuery(filter)))
	for _, value := range values {
		if len(value.PullRequest) > 0 && string(value.PullRequest) != "null" {
			continue
		}
		// The free-text filter is applied locally: the search API is a separate
		// quota with its own rate limit, and mixing the two would make paging
		// and the observed-at instant mean different things per page.
		if needle != "" && !strings.Contains(strings.ToLower(value.Title), needle) && !strings.Contains(strings.ToLower(value.Body), needle) {
			continue
		}
		issues = append(issues, value.toProto(ref, atMS))
	}
	return issues, response, nil
}

func filterQuery(filter *pb.GithubIssueFilter) string {
	if filter == nil {
		return ""
	}
	return filter.Query
}

func (c *Client) Issue(ctx context.Context, ref *pb.GithubRepositoryRef, number int64, atMS int64) (*pb.GithubIssue, string, Response, error) {
	path, err := c.issuePath(ref, number, "")
	if err != nil {
		return nil, "", Response{}, err
	}
	response, err := c.Get(ctx, path, nil)
	if err != nil {
		return nil, "", response, err
	}
	value, err := decode[wireIssue](response)
	if err != nil {
		return nil, "", response, err
	}
	if len(value.PullRequest) > 0 && string(value.PullRequest) != "null" {
		return nil, "", response, fail(CodeNotFound, response.Status, "NOT_AN_ISSUE")
	}
	return value.toProto(ref, atMS), value.NodeID, response, nil
}

func (c *Client) issuePath(ref *pb.GithubRepositoryRef, number int64, suffix string) (string, error) {
	if number <= 0 || number > 1<<31 {
		return "", fail(CodeInvalid, 0, "NUMBER_INVALID")
	}
	return c.repoPath(ref, "/issues/"+strconv.FormatInt(number, 10)+suffix)
}

func (c *Client) pullPath(ref *pb.GithubRepositoryRef, number int64, suffix string) (string, error) {
	if number <= 0 || number > 1<<31 {
		return "", fail(CodeInvalid, 0, "NUMBER_INVALID")
	}
	return c.repoPath(ref, "/pulls/"+strconv.FormatInt(number, 10)+suffix)
}

func (c *Client) IssueComments(ctx context.Context, ref *pb.GithubRepositoryRef, number int64, limit int) ([]*pb.GithubComment, error) {
	path, err := c.issuePath(ref, number, "/comments")
	if err != nil {
		return nil, err
	}
	response, err := c.Get(ctx, path, url.Values{"per_page": {perPage(limit)}})
	if err != nil {
		return nil, err
	}
	values, err := decode[[]wireComment](response)
	if err != nil {
		return nil, err
	}
	comments := make([]*pb.GithubComment, 0, len(values))
	for _, value := range values {
		comments = append(comments, value.toProto())
	}
	return comments, nil
}

func (c *Client) CreateIssue(ctx context.Context, ref *pb.GithubRepositoryRef, body map[string]any, atMS int64) (*pb.GithubIssue, error) {
	path, err := c.repoPath(ref, "/issues")
	if err != nil {
		return nil, err
	}
	response, err := c.Write(ctx, http.MethodPost, path, body)
	if err != nil {
		return nil, err
	}
	value, err := decode[wireIssue](response)
	if err != nil {
		return nil, err
	}
	return value.toProto(ref, atMS), nil
}

// PatchIssue writes exactly the members the caller assembled. The caller has
// already re-read the Issue, so this never merges anything of its own into the
// request.
func (c *Client) PatchIssue(ctx context.Context, ref *pb.GithubRepositoryRef, number int64, body map[string]any, atMS int64) (*pb.GithubIssue, error) {
	path, err := c.issuePath(ref, number, "")
	if err != nil {
		return nil, err
	}
	response, err := c.Write(ctx, http.MethodPatch, path, body)
	if err != nil {
		return nil, err
	}
	value, err := decode[wireIssue](response)
	if err != nil {
		return nil, err
	}
	return value.toProto(ref, atMS), nil
}

func (c *Client) CreateIssueComment(ctx context.Context, ref *pb.GithubRepositoryRef, number int64, text string) (*pb.GithubComment, error) {
	path, err := c.issuePath(ref, number, "/comments")
	if err != nil {
		return nil, err
	}
	response, err := c.Write(ctx, http.MethodPost, path, map[string]any{"body": text})
	if err != nil {
		return nil, err
	}
	value, err := decode[wireComment](response)
	if err != nil {
		return nil, err
	}
	return value.toProto(), nil
}

func pullQuery(filter *pb.GithubPullFilter, page, limit int) url.Values {
	query := url.Values{"per_page": {perPage(limit)}, "sort": {"updated"}, "direction": {"desc"}}
	if page > 1 {
		query.Set("page", strconv.Itoa(page))
	}
	state := "all"
	if filter != nil {
		switch filter.State {
		case pb.GithubPullState_GITHUB_PULL_STATE_OPEN:
			state = "open"
		case pb.GithubPullState_GITHUB_PULL_STATE_CLOSED, pb.GithubPullState_GITHUB_PULL_STATE_MERGED:
			state = "closed"
		}
		if filter.BaseRef != "" {
			query.Set("base", filter.BaseRef)
		}
	}
	query.Set("state", state)
	return query
}

// Pulls lists one page. Author, review-requested, draft and merged filters are
// applied locally because the list endpoint does not offer them, and because
// the search API would page under a different quota.
func (c *Client) Pulls(ctx context.Context, ref *pb.GithubRepositoryRef, filter *pb.GithubPullFilter, page, limit int, allowed []pb.GithubMergeMethod, atMS int64) ([]*pb.GithubPullRequest, Response, error) {
	path, err := c.repoPath(ref, "/pulls")
	if err != nil {
		return nil, Response{}, err
	}
	response, err := c.Get(ctx, path, pullQuery(filter, page, limit))
	if err != nil {
		return nil, response, err
	}
	values, err := decode[[]wirePull](response)
	if err != nil {
		return nil, response, err
	}
	pulls := make([]*pb.GithubPullRequest, 0, len(values))
	for _, value := range values {
		pull := value.toProto(ref, allowed, atMS)
		if filter != nil {
			if filter.State == pb.GithubPullState_GITHUB_PULL_STATE_MERGED && pull.State != pb.GithubPullState_GITHUB_PULL_STATE_MERGED {
				continue
			}
			if filter.State == pb.GithubPullState_GITHUB_PULL_STATE_CLOSED && pull.State != pb.GithubPullState_GITHUB_PULL_STATE_CLOSED {
				continue
			}
			if filter.Author != "" && (pull.Author == nil || !strings.EqualFold(pull.Author.Login, filter.Author)) {
				continue
			}
			if filter.DraftOnly && !pull.Draft {
				continue
			}
			if filter.ReviewRequested != "" && !requested(pull, filter.ReviewRequested) {
				continue
			}
		}
		pulls = append(pulls, pull)
	}
	return pulls, response, nil
}

func requested(pull *pb.GithubPullRequest, login string) bool {
	for _, reviewer := range pull.RequestedReviewers {
		if strings.EqualFold(reviewer.Login, login) {
			return true
		}
	}
	return false
}

func (c *Client) Pull(ctx context.Context, ref *pb.GithubRepositoryRef, number int64, allowed []pb.GithubMergeMethod, atMS int64) (*pb.GithubPullRequest, Response, error) {
	path, err := c.pullPath(ref, number, "")
	if err != nil {
		return nil, Response{}, err
	}
	response, err := c.Get(ctx, path, nil)
	if err != nil {
		return nil, response, err
	}
	value, err := decode[wirePull](response)
	if err != nil {
		return nil, response, err
	}
	return value.toProto(ref, allowed, atMS), response, nil
}

func (c *Client) PullFiles(ctx context.Context, ref *pb.GithubRepositoryRef, number int64, limit int) ([]*pb.GithubPullFile, error) {
	path, err := c.pullPath(ref, number, "/files")
	if err != nil {
		return nil, err
	}
	response, err := c.Get(ctx, path, url.Values{"per_page": {perPage(limit)}})
	if err != nil {
		return nil, err
	}
	values, err := decode[[]wireFile](response)
	if err != nil {
		return nil, err
	}
	files := make([]*pb.GithubPullFile, 0, len(values))
	for _, value := range values {
		files = append(files, value.toProto())
	}
	return files, nil
}

func (c *Client) PullReviews(ctx context.Context, ref *pb.GithubRepositoryRef, number int64, limit int) ([]*pb.GithubReview, error) {
	path, err := c.pullPath(ref, number, "/reviews")
	if err != nil {
		return nil, err
	}
	response, err := c.Get(ctx, path, url.Values{"per_page": {perPage(limit)}})
	if err != nil {
		return nil, err
	}
	values, err := decode[[]wireReview](response)
	if err != nil {
		return nil, err
	}
	reviews := make([]*pb.GithubReview, 0, len(values))
	for _, value := range values {
		reviews = append(reviews, value.toProto())
	}
	return reviews, nil
}

func (c *Client) PullReviewComments(ctx context.Context, ref *pb.GithubRepositoryRef, number int64, limit int) ([]*pb.GithubReviewComment, error) {
	path, err := c.pullPath(ref, number, "/comments")
	if err != nil {
		return nil, err
	}
	response, err := c.Get(ctx, path, url.Values{"per_page": {perPage(limit)}})
	if err != nil {
		return nil, err
	}
	values, err := decode[[]wireReviewComment](response)
	if err != nil {
		return nil, err
	}
	comments := make([]*pb.GithubReviewComment, 0, len(values))
	for _, value := range values {
		comments = append(comments, value.toProto())
	}
	return comments, nil
}

func (c *Client) CreatePull(ctx context.Context, ref *pb.GithubRepositoryRef, body map[string]any, allowed []pb.GithubMergeMethod, atMS int64) (*pb.GithubPullRequest, error) {
	path, err := c.repoPath(ref, "/pulls")
	if err != nil {
		return nil, err
	}
	response, err := c.Write(ctx, http.MethodPost, path, body)
	if err != nil {
		return nil, err
	}
	value, err := decode[wirePull](response)
	if err != nil {
		return nil, err
	}
	return value.toProto(ref, allowed, atMS), nil
}

func (c *Client) CreateReview(ctx context.Context, ref *pb.GithubRepositoryRef, number int64, body map[string]any) (*pb.GithubReview, error) {
	path, err := c.pullPath(ref, number, "/reviews")
	if err != nil {
		return nil, err
	}
	response, err := c.Write(ctx, http.MethodPost, path, body)
	if err != nil {
		return nil, err
	}
	value, err := decode[wireReview](response)
	if err != nil {
		return nil, err
	}
	return value.toProto(), nil
}

// Ref reads one ref's object. Creating a pull request for a branch that was
// never pushed would fail on the remote with an opaque message, so the Host
// checks first and says which branch is missing.
func (c *Client) Ref(ctx context.Context, ref *pb.GithubRepositoryRef, name string) (string, error) {
	if name == "" || len(name) > 255 || strings.Contains(name, "..") || strings.HasPrefix(name, "/") {
		return "", fail(CodeInvalid, 0, "REF_INVALID")
	}
	path, err := c.repoPath(ref, "/git/ref/heads/"+url.PathEscape(name))
	if err != nil {
		return "", err
	}
	response, err := c.Get(ctx, path, nil)
	if err != nil {
		return "", err
	}
	value, err := decode[struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}](response)
	if err != nil {
		return "", err
	}
	return value.Object.SHA, nil
}

// validSHA accepts a full object name only. A short SHA would let a merge
// request name something other than exactly the head the reader saw.
func validSHA(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, r := range value {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

// Checks reads both surfaces GitHub exposes for one commit: check runs and the
// older commit statuses. A repository can use either, so reporting only one
// would show an empty, falsely reassuring result.
func (c *Client) Checks(ctx context.Context, ref *pb.GithubRepositoryRef, sha string, atMS int64) (*pb.GithubCheckSummary, error) {
	if !validSHA(sha) {
		return nil, fail(CodeInvalid, 0, "SHA_INVALID")
	}
	runsPath, err := c.repoPath(ref, "/commits/"+sha+"/check-runs")
	if err != nil {
		return nil, err
	}
	response, err := c.Get(ctx, runsPath, url.Values{"per_page": {perPage(0)}})
	if err != nil {
		return nil, err
	}
	decoded, err := decode[struct {
		CheckRuns []wireCheckRun `json:"check_runs"`
	}](response)
	if err != nil {
		return nil, err
	}
	summary := &pb.GithubCheckSummary{HeadSha: sha, ObservedAtUnixMs: atMS}
	for _, run := range decoded.CheckRuns {
		summary.Runs = append(summary.Runs, run.toProto())
	}
	statusPath, err := c.repoPath(ref, "/commits/"+sha+"/status")
	if err != nil {
		return nil, err
	}
	statusResponse, err := c.Get(ctx, statusPath, url.Values{"per_page": {perPage(0)}})
	if err != nil {
		// Commit statuses are optional; a repository that only uses check runs
		// still has a complete answer without them.
		if CodeOf(err) != CodeNotFound {
			return nil, err
		}
	} else {
		combined, err := decode[struct {
			Statuses []wireStatus `json:"statuses"`
		}](statusResponse)
		if err != nil {
			return nil, err
		}
		for _, status := range combined.Statuses {
			summary.Runs = append(summary.Runs, &pb.GithubCheckRun{
				Name:              status.Context,
				Conclusion:        commitStatusConclusion(status.State),
				DetailsUrl:        status.TargetURL,
				StartedAtUnixMs:   unixMS(status.CreatedAt),
				CompletedAtUnixMs: unixMS(status.UpdatedAt),
			})
		}
	}
	summary.Rollup = rollup(summary.Runs)
	return summary, nil
}

// Merge is a write and is never retried. A refusal is reported with the remote
// status so the caller can say whether the head moved or protection blocked it.
func (c *Client) Merge(ctx context.Context, ref *pb.GithubRepositoryRef, number int64, sha, method, title, message string) (string, error) {
	if !validSHA(sha) {
		return "", fail(CodeInvalid, 0, "SHA_INVALID")
	}
	path, err := c.pullPath(ref, number, "/merge")
	if err != nil {
		return "", err
	}
	body := map[string]any{"sha": sha, "merge_method": method}
	if title != "" {
		body["commit_title"] = title
	}
	if message != "" {
		body["commit_message"] = message
	}
	response, err := c.Write(ctx, http.MethodPut, path, body)
	if err != nil {
		return "", err
	}
	value, err := decode[struct {
		SHA    string `json:"sha"`
		Merged bool   `json:"merged"`
	}](response)
	if err != nil {
		return "", err
	}
	// A 200 that says merged:false is a refusal, not a success. It is reported
	// as one so no caller can read the absent error as "merged".
	if !value.Merged || !validSHA(value.SHA) {
		return "", fail(CodeConflict, response.Status, "NOT_MERGED")
	}
	return value.SHA, nil
}

// Viewer identifies the account a credential belongs to, and the scopes the
// remote says the token carries. It is the only way to answer "is this
// credential usable" without guessing.
func (c *Client) Viewer(ctx context.Context) (string, []string, error) {
	response, err := c.Get(ctx, "/user", nil)
	if err != nil {
		return "", nil, err
	}
	value, err := decode[struct {
		Login string `json:"login"`
	}](response)
	if err != nil {
		return "", nil, err
	}
	return value.Login, response.OAuthScopes, nil
}

// RerunWorkflowRun restarts one Actions workflow run. `failedOnly` restarts
// just the jobs that did not pass, which is what a reader who fixed one job
// wants; the whole run is the fallback the API always accepts.
//
// It is a write, so it is never retried: a duplicated restart would burn a
// second set of runner minutes and produce a second, competing result.
func (c *Client) RerunWorkflowRun(ctx context.Context, ref *pb.GithubRepositoryRef, runID int64, failedOnly bool) error {
	if runID <= 0 {
		return fail(CodeInvalid, 0, "WORKFLOW_RUN_INVALID")
	}
	suffix := "/rerun"
	if failedOnly {
		suffix = "/rerun-failed-jobs"
	}
	path, err := c.repoPath(ref, "/actions/runs/"+strconv.FormatInt(runID, 10)+suffix)
	if err != nil {
		return err
	}
	_, err = c.Write(ctx, http.MethodPost, path, map[string]any{})
	return err
}

// DeleteRef removes one branch ref. The caller has already re-read the ref and
// compared it with what the reader saw; this only performs the delete.
func (c *Client) DeleteRef(ctx context.Context, ref *pb.GithubRepositoryRef, name string) error {
	if name == "" || len(name) > 255 || strings.Contains(name, "..") || strings.HasPrefix(name, "/") {
		return fail(CodeInvalid, 0, "REF_INVALID")
	}
	path, err := c.repoPath(ref, "/git/refs/heads/"+url.PathEscape(name))
	if err != nil {
		return err
	}
	_, err = c.Write(ctx, http.MethodDelete, path, nil)
	return err
}
