package githubapi

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
)

// Wire shapes are declared with only the fields the Host actually uses. Every
// other field the remote sends is dropped rather than forwarded, so a new
// upstream field can never reach a client without being reviewed here.

type wireUser struct {
	Login string `json:"login"`
	ID    int64  `json:"id"`
}

type wireLabel struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

type wireMilestone struct {
	Number int64  `json:"number"`
	Title  string `json:"title"`
}

type wireIssue struct {
	ID          int64           `json:"id"`
	NodeID      string          `json:"node_id"`
	Number      int64           `json:"number"`
	Title       string          `json:"title"`
	Body        string          `json:"body"`
	State       string          `json:"state"`
	StateReason string          `json:"state_reason"`
	User        *wireUser       `json:"user"`
	Assignees   []wireUser      `json:"assignees"`
	Labels      []wireLabel     `json:"labels"`
	Milestone   *wireMilestone  `json:"milestone"`
	Comments    int64           `json:"comments"`
	CreatedAt   string          `json:"created_at"`
	UpdatedAt   string          `json:"updated_at"`
	ClosedAt    string          `json:"closed_at"`
	HTMLURL     string          `json:"html_url"`
	PullRequest json.RawMessage `json:"pull_request"`
}

type wireComment struct {
	ID        int64     `json:"id"`
	User      *wireUser `json:"user"`
	Body      string    `json:"body"`
	CreatedAt string    `json:"created_at"`
	UpdatedAt string    `json:"updated_at"`
	HTMLURL   string    `json:"html_url"`
}

type wireRepository struct {
	ID            int64  `json:"id"`
	FullName      string `json:"full_name"`
	Name          string `json:"name"`
	DefaultBranch string `json:"default_branch"`
	Private       bool   `json:"private"`
	Fork          bool   `json:"fork"`
	HasIssues     bool   `json:"has_issues"`
	AllowMerge    *bool  `json:"allow_merge_commit"`
	AllowSquash   *bool  `json:"allow_squash_merge"`
	AllowRebase   *bool  `json:"allow_rebase_merge"`
	Owner         *struct {
		Login string `json:"login"`
	} `json:"owner"`
	Permissions *struct {
		Admin    bool `json:"admin"`
		Maintain bool `json:"maintain"`
		Push     bool `json:"push"`
		Triage   bool `json:"triage"`
		Pull     bool `json:"pull"`
	} `json:"permissions"`
}

type wireRef struct {
	Ref  string `json:"ref"`
	SHA  string `json:"sha"`
	Repo *struct {
		FullName string `json:"full_name"`
		Fork     bool   `json:"fork"`
	} `json:"repo"`
}

type wirePull struct {
	ID                 int64       `json:"id"`
	NodeID             string      `json:"node_id"`
	Number             int64       `json:"number"`
	Title              string      `json:"title"`
	Body               string      `json:"body"`
	State              string      `json:"state"`
	Draft              bool        `json:"draft"`
	Merged             bool        `json:"merged"`
	User               *wireUser   `json:"user"`
	Base               *wireRef    `json:"base"`
	Head               *wireRef    `json:"head"`
	Mergeable          *bool       `json:"mergeable"`
	MergeableState     string      `json:"mergeable_state"`
	Additions          int64       `json:"additions"`
	Deletions          int64       `json:"deletions"`
	ChangedFiles       int64       `json:"changed_files"`
	Commits            int64       `json:"commits"`
	RequestedReviewers []wireUser  `json:"requested_reviewers"`
	Labels             []wireLabel `json:"labels"`
	CreatedAt          string      `json:"created_at"`
	UpdatedAt          string      `json:"updated_at"`
	MergedAt           string      `json:"merged_at"`
	ClosedAt           string      `json:"closed_at"`
	HTMLURL            string      `json:"html_url"`
}

type wireFile struct {
	Filename         string `json:"filename"`
	PreviousFilename string `json:"previous_filename"`
	Status           string `json:"status"`
	Additions        int64  `json:"additions"`
	Deletions        int64  `json:"deletions"`
	Patch            string `json:"patch"`
}

type wireReview struct {
	ID          int64     `json:"id"`
	User        *wireUser `json:"user"`
	State       string    `json:"state"`
	Body        string    `json:"body"`
	CommitID    string    `json:"commit_id"`
	SubmittedAt string    `json:"submitted_at"`
}

type wireReviewComment struct {
	ID           int64     `json:"id"`
	User         *wireUser `json:"user"`
	Body         string    `json:"body"`
	Path         string    `json:"path"`
	CommitID     string    `json:"commit_id"`
	OriginalLine int64     `json:"original_line"`
	Line         *int64    `json:"line"`
	Side         string    `json:"side"`
	Position     *int64    `json:"position"`
	CreatedAt    string    `json:"created_at"`
}

type wireCheckRun struct {
	Name        string `json:"name"`
	Status      string `json:"status"`
	Conclusion  string `json:"conclusion"`
	DetailsURL  string `json:"details_url"`
	StartedAt   string `json:"started_at"`
	CompletedAt string `json:"completed_at"`
	App         *struct {
		Name string `json:"name"`
		Slug string `json:"slug"`
	} `json:"app"`
}

type wireStatus struct {
	Context     string `json:"context"`
	State       string `json:"state"`
	TargetURL   string `json:"target_url"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
	Description string `json:"description"`
}

// unixMS converts an RFC 3339 instant. An absent or unparsable value is zero,
// which every consumer treats as "not reported" rather than as the epoch.
func unixMS(value string) int64 {
	if value == "" {
		return 0
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return 0
	}
	return parsed.UnixMilli()
}

func user(value *wireUser) *pb.GithubUser {
	if value == nil {
		return nil
	}
	return &pb.GithubUser{Login: value.Login, Id: value.ID}
}

func users(values []wireUser) []*pb.GithubUser {
	result := make([]*pb.GithubUser, 0, len(values))
	for index := range values {
		result = append(result, user(&values[index]))
	}
	return result
}

func labels(values []wireLabel) []*pb.GithubLabel {
	result := make([]*pb.GithubLabel, 0, len(values))
	for _, value := range values {
		result = append(result, &pb.GithubLabel{Name: value.Name, Color: value.Color})
	}
	return result
}

func issueState(value string) pb.GithubIssueState {
	switch value {
	case "open":
		return pb.GithubIssueState_GITHUB_ISSUE_STATE_OPEN
	case "closed":
		return pb.GithubIssueState_GITHUB_ISSUE_STATE_CLOSED
	}
	return pb.GithubIssueState_GITHUB_ISSUE_STATE_UNSPECIFIED
}

func issueStateReason(value string) pb.GithubIssueStateReason {
	switch value {
	case "completed":
		return pb.GithubIssueStateReason_GITHUB_ISSUE_STATE_REASON_COMPLETED
	case "not_planned":
		return pb.GithubIssueStateReason_GITHUB_ISSUE_STATE_REASON_NOT_PLANNED
	case "reopened":
		return pb.GithubIssueStateReason_GITHUB_ISSUE_STATE_REASON_REOPENED
	case "duplicate":
		return pb.GithubIssueStateReason_GITHUB_ISSUE_STATE_REASON_DUPLICATE
	}
	return pb.GithubIssueStateReason_GITHUB_ISSUE_STATE_REASON_UNSPECIFIED
}

func (v wireIssue) toProto(ref *pb.GithubRepositoryRef, observedAtMS int64) *pb.GithubIssue {
	issue := &pb.GithubIssue{
		Repository:       ref,
		Number:           v.Number,
		Id:               v.ID,
		Title:            v.Title,
		Body:             v.Body,
		State:            issueState(v.State),
		StateReason:      issueStateReason(v.StateReason),
		Author:           user(v.User),
		Assignees:        users(v.Assignees),
		Labels:           labels(v.Labels),
		CommentCount:     v.Comments,
		CreatedAtUnixMs:  unixMS(v.CreatedAt),
		UpdatedAtUnixMs:  unixMS(v.UpdatedAt),
		ClosedAtUnixMs:   unixMS(v.ClosedAt),
		HtmlUrl:          v.HTMLURL,
		ObservedAtUnixMs: observedAtMS,
	}
	if v.Milestone != nil {
		issue.Milestone = &pb.GithubMilestone{Number: v.Milestone.Number, Title: v.Milestone.Title}
	}
	return issue
}

func (v wireComment) toProto() *pb.GithubComment {
	return &pb.GithubComment{
		Id:              v.ID,
		Author:          user(v.User),
		Body:            v.Body,
		CreatedAtUnixMs: unixMS(v.CreatedAt),
		UpdatedAtUnixMs: unixMS(v.UpdatedAt),
		HtmlUrl:         v.HTMLURL,
	}
}

func mergeMethods(v wireRepository) []pb.GithubMergeMethod {
	methods := []pb.GithubMergeMethod{}
	// A nil flag means the endpoint did not report it. Offering a method the
	// repository may not allow would put a button in front of a guaranteed 405.
	if v.AllowMerge != nil && *v.AllowMerge {
		methods = append(methods, pb.GithubMergeMethod_GITHUB_MERGE_METHOD_MERGE)
	}
	if v.AllowSquash != nil && *v.AllowSquash {
		methods = append(methods, pb.GithubMergeMethod_GITHUB_MERGE_METHOD_SQUASH)
	}
	if v.AllowRebase != nil && *v.AllowRebase {
		methods = append(methods, pb.GithubMergeMethod_GITHUB_MERGE_METHOD_REBASE)
	}
	return methods
}

func permission(v wireRepository) string {
	if v.Permissions == nil {
		return ""
	}
	switch {
	case v.Permissions.Admin:
		return "admin"
	case v.Permissions.Maintain:
		return "maintain"
	case v.Permissions.Push:
		return "write"
	case v.Permissions.Triage:
		return "triage"
	case v.Permissions.Pull:
		return "read"
	}
	return ""
}

func pullState(v wirePull) pb.GithubPullState {
	if v.Merged || v.MergedAt != "" {
		return pb.GithubPullState_GITHUB_PULL_STATE_MERGED
	}
	switch v.State {
	case "open":
		return pb.GithubPullState_GITHUB_PULL_STATE_OPEN
	case "closed":
		return pb.GithubPullState_GITHUB_PULL_STATE_CLOSED
	}
	return pb.GithubPullState_GITHUB_PULL_STATE_UNSPECIFIED
}

// mergeable turns two independent remote fields into one honest answer. A
// missing `mergeable` means the remote is still computing it, which is never
// the same as "ready".
func mergeable(v wirePull) pb.GithubMergeableState {
	switch v.MergeableState {
	case "dirty":
		return pb.GithubMergeableState_GITHUB_MERGEABLE_STATE_CONFLICTING
	case "blocked", "behind", "draft":
		return pb.GithubMergeableState_GITHUB_MERGEABLE_STATE_BLOCKED
	}
	if v.Mergeable == nil {
		return pb.GithubMergeableState_GITHUB_MERGEABLE_STATE_UNKNOWN
	}
	if *v.Mergeable {
		return pb.GithubMergeableState_GITHUB_MERGEABLE_STATE_MERGEABLE
	}
	return pb.GithubMergeableState_GITHUB_MERGEABLE_STATE_CONFLICTING
}

func (v wirePull) toProto(ref *pb.GithubRepositoryRef, allowed []pb.GithubMergeMethod, observedAtMS int64) *pb.GithubPullRequest {
	pull := &pb.GithubPullRequest{
		Repository:          ref,
		Number:              v.Number,
		Id:                  v.ID,
		Title:               v.Title,
		Body:                v.Body,
		State:               pullState(v),
		Draft:               v.Draft,
		Author:              user(v.User),
		Mergeable:           mergeable(v),
		AllowedMergeMethods: allowed,
		Additions:           v.Additions,
		Deletions:           v.Deletions,
		ChangedFiles:        v.ChangedFiles,
		Commits:             v.Commits,
		RequestedReviewers:  users(v.RequestedReviewers),
		Labels:              labels(v.Labels),
		CreatedAtUnixMs:     unixMS(v.CreatedAt),
		UpdatedAtUnixMs:     unixMS(v.UpdatedAt),
		MergedAtUnixMs:      unixMS(v.MergedAt),
		ClosedAtUnixMs:      unixMS(v.ClosedAt),
		HtmlUrl:             v.HTMLURL,
		ObservedAtUnixMs:    observedAtMS,
	}
	if v.Base != nil {
		pull.BaseRef = v.Base.Ref
	}
	if v.Head != nil {
		pull.HeadRef = v.Head.Ref
		pull.HeadSha = v.Head.SHA
		if v.Head.Repo != nil {
			pull.HeadRepoFullName = v.Head.Repo.FullName
			if ref != nil {
				pull.FromFork = !strings.EqualFold(v.Head.Repo.FullName, ref.Owner+"/"+ref.Name)
			}
		}
	}
	return pull
}

func (v wireFile) toProto() *pb.GithubPullFile {
	return &pb.GithubPullFile{
		Path:         v.Filename,
		PreviousPath: v.PreviousFilename,
		Status:       v.Status,
		Additions:    v.Additions,
		Deletions:    v.Deletions,
		// The remote omits a patch for a binary file; that absence, with a
		// nonzero change, is the only signal it gives.
		Binary: v.Patch == "" && v.Status != "unchanged" && v.Status != "renamed",
	}
}

func reviewState(value string) pb.GithubReviewState {
	switch strings.ToUpper(value) {
	case "APPROVED":
		return pb.GithubReviewState_GITHUB_REVIEW_STATE_APPROVED
	case "CHANGES_REQUESTED":
		return pb.GithubReviewState_GITHUB_REVIEW_STATE_CHANGES_REQUESTED
	case "COMMENTED":
		return pb.GithubReviewState_GITHUB_REVIEW_STATE_COMMENTED
	case "DISMISSED":
		return pb.GithubReviewState_GITHUB_REVIEW_STATE_DISMISSED
	case "PENDING":
		return pb.GithubReviewState_GITHUB_REVIEW_STATE_PENDING
	}
	return pb.GithubReviewState_GITHUB_REVIEW_STATE_UNSPECIFIED
}

func (v wireReview) toProto() *pb.GithubReview {
	return &pb.GithubReview{
		Id:                v.ID,
		Author:            user(v.User),
		State:             reviewState(v.State),
		Body:              v.Body,
		CommitSha:         v.CommitID,
		SubmittedAtUnixMs: unixMS(v.SubmittedAt),
	}
}

func (v wireReviewComment) toProto() *pb.GithubReviewComment {
	comment := &pb.GithubReviewComment{
		Id:              v.ID,
		Author:          user(v.User),
		Body:            v.Body,
		Path:            v.Path,
		CommitSha:       v.CommitID,
		Side:            v.Side,
		CreatedAtUnixMs: unixMS(v.CreatedAt),
	}
	if v.Side == "" {
		comment.Side = "RIGHT"
	}
	// A comment whose current line the remote no longer reports has drifted off
	// the diff. Keeping the original line and marking it outdated is the only
	// honest option; silently drawing it on a current line would be wrong.
	if v.Line != nil {
		comment.Line = *v.Line
	} else {
		comment.Line = v.OriginalLine
		comment.Outdated = true
	}
	if v.Position == nil {
		comment.Outdated = true
	}
	return comment
}

var actionsRunPattern = regexp.MustCompile(`/actions/runs/(\d{1,19})`)

func checkConclusion(status, conclusion string) pb.GithubCheckConclusion {
	if status != "completed" && status != "" {
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_PENDING
	}
	switch conclusion {
	case "success":
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_SUCCESS
	case "failure":
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_FAILURE
	case "neutral":
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_NEUTRAL
	case "cancelled":
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_CANCELLED
	case "skipped":
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_SKIPPED
	case "timed_out":
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_TIMED_OUT
	case "action_required":
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_ACTION_REQUIRED
	case "stale":
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_STALE
	case "":
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_PENDING
	}
	return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_UNSPECIFIED
}

func (v wireCheckRun) toProto() *pb.GithubCheckRun {
	run := &pb.GithubCheckRun{
		Name:              v.Name,
		Conclusion:        checkConclusion(v.Status, v.Conclusion),
		DetailsUrl:        v.DetailsURL,
		StartedAtUnixMs:   unixMS(v.StartedAt),
		CompletedAtUnixMs: unixMS(v.CompletedAt),
	}
	if v.App != nil {
		run.App = v.App.Name
		// Only a workflow run can actually be restarted. Every other producer
		// gets no rerun affordance, because there is no endpoint for it.
		if v.App.Slug == "github-actions" {
			if match := actionsRunPattern.FindStringSubmatch(v.DetailsURL); match != nil {
				if id, err := strconv.ParseInt(match[1], 10, 64); err == nil && id > 0 {
					run.WorkflowRunId = id
					run.Rerunnable = true
				}
			}
		}
	}
	return run
}

func commitStatusConclusion(state string) pb.GithubCheckConclusion {
	switch state {
	case "success":
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_SUCCESS
	case "failure", "error":
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_FAILURE
	case "pending":
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_PENDING
	}
	return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_UNSPECIFIED
}

// rollup summarises many runs into the single answer a merge decision needs.
// A failure outranks everything, and anything still running keeps the whole
// rollup pending: an incomplete run is not a passing one.
func rollup(runs []*pb.GithubCheckRun) pb.GithubCheckConclusion {
	if len(runs) == 0 {
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_UNSPECIFIED
	}
	failed, pending, success := false, false, false
	for _, run := range runs {
		switch run.Conclusion {
		case pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_FAILURE,
			pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_TIMED_OUT,
			pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_ACTION_REQUIRED:
			failed = true
		case pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_PENDING:
			pending = true
		case pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_SUCCESS:
			success = true
		}
	}
	switch {
	case failed:
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_FAILURE
	case pending:
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_PENDING
	case success:
		return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_SUCCESS
	}
	return pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_NEUTRAL
}
