package githubhost

import (
	"context"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/githubapi"
	"armadra.local/host/internal/storage"
)

// ResolveRepository parses a git remote locally and only then asks the
// configured service about it. A remote belonging to a different host is
// reported as a mismatch and no request is made, which is what keeps an
// enterprise repository from being looked up on the public service.
func (s *Service) ResolveRepository(ctx context.Context, caller Caller, remoteURL string) (*pb.ResolveGithubRepositoryResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	client, err := s.client(ctx)
	if err != nil {
		return nil, err
	}
	parsed, err := githubapi.ParseRemote(remoteURL)
	if err != nil {
		return &pb.ResolveGithubRepositoryResponse{ReasonCode: "REMOTE_INVALID"}, nil
	}
	base := client.APIBase()
	if !githubapi.BelongsTo(base, parsed.WebHost) {
		// Deliberately no repository in the response: reporting one would mean
		// the Host had asked some service about it.
		return &pb.ResolveGithubRepositoryResponse{HostMismatch: true, ReasonCode: "REMOTE_HOST_NOT_CONFIGURED"}, nil
	}
	ref := &pb.GithubRepositoryRef{Owner: parsed.Owner, Name: parsed.Name, ApiBase: base, Host: githubapi.WebHostFor(base)}
	repository, response, err := client.Repository(ctx, ref, s.now().UnixMilli())
	if err != nil {
		return nil, s.translate(err)
	}
	return &pb.ResolveGithubRepositoryResponse{Repository: repository, RateLimit: rate(response.Rate)}, nil
}

// ListIssues returns one page of Issues, already annotated with the status
// group each falls into. Pull requests are filtered out by the transport, so
// this list never mixes the two.
func (s *Service) ListIssues(ctx context.Context, caller Caller, request *pb.ListGithubIssuesRequest) (*pb.ListGithubIssuesResponse, error) {
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
	limit := pageLimit(request.GetLimit())
	now := s.now().UnixMilli()
	issues, response, err := client.Issues(ctx, ref, request.GetFilter(), page, limit, now)
	if err != nil {
		return nil, s.translate(err)
	}
	mapping, err := s.storedMapping(ctx, caller.WorkspaceID, ref)
	if err != nil {
		return nil, err
	}
	applyLabelGroups(mapping, issues)
	if err = s.applyProjectGroups(ctx, client, mapping, issues); err != nil {
		return nil, err
	}
	return &pb.ListGithubIssuesResponse{
		Issues:           issues,
		NextCursor:       encodeCursor(response.NextPage),
		HasMore:          response.NextPage >= 2,
		RateLimit:        rate(response.Rate),
		FromCache:        response.FromCache,
		ObservedAtUnixMs: now,
		PollIntervalMs:   PollIntervalMS,
	}, nil
}

// GetIssue reads one Issue with its comments and the local references pointing
// at it.
func (s *Service) GetIssue(ctx context.Context, caller Caller, request *pb.GetGithubIssueRequest) (*pb.GetGithubIssueResponse, error) {
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
	issue, _, response, err := client.Issue(ctx, ref, request.GetNumber(), now)
	if err != nil {
		return nil, s.translate(err)
	}
	mapping, err := s.storedMapping(ctx, caller.WorkspaceID, ref)
	if err != nil {
		return nil, err
	}
	single := []*pb.GithubIssue{issue}
	applyLabelGroups(mapping, single)
	if err = s.applyProjectGroups(ctx, client, mapping, single); err != nil {
		return nil, err
	}
	comments, err := client.IssueComments(ctx, ref, issue.Number, maxComments)
	if err != nil {
		return nil, s.translate(err)
	}
	references, err := s.referencesFor(ctx, caller.WorkspaceID, ref, pb.GithubReferenceKind_GITHUB_REFERENCE_KIND_ISSUE, issue.Number)
	if err != nil {
		return nil, err
	}
	return &pb.GetGithubIssueResponse{Issue: issue, Comments: comments, References: references, RateLimit: rate(response.Rate), PollIntervalMs: PollIntervalMS}, nil
}

func (s *Service) CreateIssue(ctx context.Context, caller Caller, request *pb.CreateGithubIssueRequest) (*pb.GithubIssue, error) {
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
	if request.GetTitle() == "" || len(request.GetTitle()) > 256 || len(request.GetBody()) > 65536 {
		return nil, ErrInvalid
	}
	body := map[string]any{"title": request.GetTitle()}
	if request.GetBody() != "" {
		body["body"] = request.GetBody()
	}
	if len(request.GetLabels()) > 0 {
		body["labels"] = request.GetLabels()
	}
	if len(request.GetAssignees()) > 0 {
		body["assignees"] = request.GetAssignees()
	}
	if request.GetMilestoneNumber() > 0 {
		body["milestone"] = request.GetMilestoneNumber()
	}
	issue, err := client.CreateIssue(ctx, ref, body, s.now().UnixMilli())
	if err != nil {
		return nil, s.translate(err)
	}
	return issue, nil
}

// reread fetches the Issue and refuses when the remote moved since the caller
// last displayed it. GitHub offers no atomic version lock, so this is a
// read-before-write check, not a guarantee — which is why the caller is told
// exactly what it is.
func (s *Service) reread(ctx context.Context, client *githubapi.Client, ref *pb.GithubRepositoryRef, number, expectedUpdatedAtMS int64) (*pb.GithubIssue, string, error) {
	if expectedUpdatedAtMS <= 0 {
		return nil, "", ErrInvalid
	}
	issue, node, _, err := client.Issue(ctx, ref, number, s.now().UnixMilli())
	if err != nil {
		return nil, "", s.translate(err)
	}
	if issue.UpdatedAtUnixMs != expectedUpdatedAtMS {
		return issue, node, storage.ErrConflict
	}
	return issue, node, nil
}

// UpdateIssue writes only the fields the patch actually carries. Labels and
// assignees are replaced only when the request says so, so an edit never drops
// what another tool added.
func (s *Service) UpdateIssue(ctx context.Context, caller Caller, request *pb.UpdateGithubIssueRequest) (*pb.GithubIssue, error) {
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
	patch := request.GetPatch()
	if patch == nil {
		return nil, ErrInvalid
	}
	if _, _, err = s.reread(ctx, client, ref, request.GetNumber(), request.GetExpectedUpdatedAtUnixMs()); err != nil {
		return nil, err
	}
	body := map[string]any{}
	if patch.Title != nil {
		if *patch.Title == "" || len(*patch.Title) > 256 {
			return nil, ErrInvalid
		}
		body["title"] = *patch.Title
	}
	if patch.Body != nil {
		if len(*patch.Body) > 65536 {
			return nil, ErrInvalid
		}
		body["body"] = *patch.Body
	}
	if patch.ReplaceLabels {
		body["labels"] = append([]string{}, patch.Labels...)
	}
	if patch.ReplaceAssignees {
		body["assignees"] = append([]string{}, patch.Assignees...)
	}
	if patch.MilestoneNumber != nil {
		if *patch.MilestoneNumber <= 0 {
			body["milestone"] = nil
		} else {
			body["milestone"] = *patch.MilestoneNumber
		}
	}
	if len(body) == 0 {
		return nil, ErrInvalid
	}
	issue, err := client.PatchIssue(ctx, ref, request.GetNumber(), body, s.now().UnixMilli())
	if err != nil {
		return nil, s.translate(err)
	}
	mapping, err := s.storedMapping(ctx, caller.WorkspaceID, ref)
	if err != nil {
		return nil, err
	}
	applyLabelGroups(mapping, []*pb.GithubIssue{issue})
	return issue, nil
}

// SetIssueState closes or reopens. It is deliberately separate from a group
// move: only an explicitly configured coupling makes those happen together.
func (s *Service) SetIssueState(ctx context.Context, caller Caller, request *pb.SetGithubIssueStateRequest) (*pb.GithubIssue, error) {
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
	state, err := stateName(request.GetState())
	if err != nil {
		return nil, err
	}
	if _, _, err = s.reread(ctx, client, ref, request.GetNumber(), request.GetExpectedUpdatedAtUnixMs()); err != nil {
		return nil, err
	}
	body := map[string]any{"state": state}
	if reason := stateReasonName(request.GetReason()); reason != "" {
		body["state_reason"] = reason
	}
	issue, err := client.PatchIssue(ctx, ref, request.GetNumber(), body, s.now().UnixMilli())
	if err != nil {
		return nil, s.translate(err)
	}
	mapping, err := s.storedMapping(ctx, caller.WorkspaceID, ref)
	if err != nil {
		return nil, err
	}
	applyLabelGroups(mapping, []*pb.GithubIssue{issue})
	return issue, nil
}

func stateName(state pb.GithubIssueState) (string, error) {
	switch state {
	case pb.GithubIssueState_GITHUB_ISSUE_STATE_OPEN:
		return "open", nil
	case pb.GithubIssueState_GITHUB_ISSUE_STATE_CLOSED:
		return "closed", nil
	}
	return "", ErrInvalid
}

func stateReasonName(reason pb.GithubIssueStateReason) string {
	switch reason {
	case pb.GithubIssueStateReason_GITHUB_ISSUE_STATE_REASON_COMPLETED:
		return "completed"
	case pb.GithubIssueStateReason_GITHUB_ISSUE_STATE_REASON_NOT_PLANNED:
		return "not_planned"
	case pb.GithubIssueStateReason_GITHUB_ISSUE_STATE_REASON_REOPENED:
		return "reopened"
	case pb.GithubIssueStateReason_GITHUB_ISSUE_STATE_REASON_DUPLICATE:
		return "duplicate"
	}
	return ""
}

func (s *Service) CommentIssue(ctx context.Context, caller Caller, request *pb.CommentGithubIssueRequest) (*pb.GithubComment, error) {
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
	if request.GetBody() == "" || len(request.GetBody()) > 65536 {
		return nil, ErrInvalid
	}
	comment, err := client.CreateIssueComment(ctx, ref, request.GetNumber(), request.GetBody())
	if err != nil {
		return nil, s.translate(err)
	}
	return comment, nil
}

// MoveIssue moves one Issue between configured groups.
//
// Each write is reported on its own, so a combination that only partly applied
// is visible and repairable. A label move only touches labels this mapping
// manages; every other label is left exactly as it was. Closing the Issue
// happens only when the target group was explicitly configured to couple to a
// state.
func (s *Service) MoveIssue(ctx context.Context, caller Caller, request *pb.MoveGithubIssueRequest) (*pb.MoveGithubIssueResponse, error) {
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
	mapping, err := s.storedMapping(ctx, caller.WorkspaceID, ref)
	if err != nil {
		return nil, err
	}
	if mapping.Source == pb.GithubStatusSource_GITHUB_STATUS_SOURCE_NONE {
		return nil, ErrInvalid
	}
	// The mapping the user was looking at decides what the move means, so a
	// mapping edited underneath the panel stops the move rather than
	// reinterpreting it.
	if request.GetExpectedMappingRevision() != mapping.Revision {
		return nil, storage.ErrConflict
	}
	target := group(mapping, request.GetToGroupId())
	if target == nil {
		return nil, ErrInvalid
	}
	issue, node, err := s.reread(ctx, client, ref, request.GetNumber(), request.GetExpectedUpdatedAtUnixMs())
	if err != nil {
		if errors.Is(err, storage.ErrConflict) && issue != nil {
			return &pb.MoveGithubIssueResponse{Issue: issue, Outcomes: []*pb.GithubWriteOutcome{{
				ActionId: "reread", Target: "issue", State: pb.GithubWriteState_GITHUB_WRITE_STATE_CONFLICTED, ReasonCode: "REMOTE_CHANGED",
			}}}, nil
		}
		return nil, err
	}
	single := []*pb.GithubIssue{issue}
	applyLabelGroups(mapping, single)
	if err = s.applyProjectGroups(ctx, client, mapping, single); err != nil {
		return nil, err
	}
	if from := request.GetFromGroupId(); from != "" && from != issue.StatusGroupId {
		return &pb.MoveGithubIssueResponse{Issue: issue, Outcomes: []*pb.GithubWriteOutcome{{
			ActionId: "from-group", Target: "status_group", State: pb.GithubWriteState_GITHUB_WRITE_STATE_CONFLICTED,
			ReasonCode: "GROUP_CHANGED", PreviousValue: issue.StatusGroupId, RequestedValue: request.GetToGroupId(),
		}}}, nil
	}
	outcomes := []*pb.GithubWriteOutcome{}
	if mapping.Source == pb.GithubStatusSource_GITHUB_STATUS_SOURCE_LABEL {
		outcomes = append(outcomes, s.moveLabels(ctx, client, ref, mapping, issue, target))
	} else {
		outcomes = append(outcomes, s.moveProjectField(ctx, client, mapping, issue, node, target)...)
	}
	if target.CouplesIssueState != pb.GithubIssueState_GITHUB_ISSUE_STATE_UNSPECIFIED && target.CouplesIssueState != issue.State {
		outcomes = append(outcomes, s.moveState(ctx, client, ref, issue, target))
	}
	// The Issue is re-read so the answer describes what the remote now holds,
	// not what was requested.
	updated, _, _, err := client.Issue(ctx, ref, issue.Number, s.now().UnixMilli())
	if err != nil {
		// The writes above already happened; refusing here would hide them.
		return &pb.MoveGithubIssueResponse{Issue: issue, Outcomes: outcomes, RateLimit: rate(client.LastRateLimit())}, nil
	}
	final := []*pb.GithubIssue{updated}
	applyLabelGroups(mapping, final)
	if err = s.applyProjectGroups(ctx, client, mapping, final); err != nil {
		return &pb.MoveGithubIssueResponse{Issue: updated, Outcomes: outcomes, RateLimit: rate(client.LastRateLimit())}, nil
	}
	return &pb.MoveGithubIssueResponse{Issue: updated, Outcomes: outcomes, RateLimit: rate(client.LastRateLimit())}, nil
}

func (s *Service) moveLabels(ctx context.Context, client *githubapi.Client, ref *pb.GithubRepositoryRef, mapping *pb.GithubStatusMapping, issue *pb.GithubIssue, target *pb.GithubStatusGroup) *pb.GithubWriteOutcome {
	managed := map[string]bool{}
	for _, entry := range mapping.Groups {
		managed[entry.Label] = true
	}
	labels := []string{}
	for _, label := range issue.Labels {
		if !managed[label.Name] {
			labels = append(labels, label.Name)
		}
	}
	labels = append(labels, target.Label)
	outcome := &pb.GithubWriteOutcome{ActionId: "labels", Target: "labels", PreviousValue: issue.StatusGroupId, RequestedValue: target.Id}
	if _, err := client.PatchIssue(ctx, ref, issue.Number, map[string]any{"labels": labels}, s.now().UnixMilli()); err != nil {
		outcome.State, outcome.ReasonCode = writeFailure(s.translate(err))
		return outcome
	}
	outcome.State = pb.GithubWriteState_GITHUB_WRITE_STATE_APPLIED
	return outcome
}

// moveProjectField reports the membership and the field write separately: a
// project item that was created but whose field write failed is a different
// state from one that was never added.
func (s *Service) moveProjectField(ctx context.Context, client *githubapi.Client, mapping *pb.GithubStatusMapping, issue *pb.GithubIssue, node string, target *pb.GithubStatusGroup) []*pb.GithubWriteOutcome {
	membership := &pb.GithubWriteOutcome{ActionId: "project-item", Target: "project_item", RequestedValue: mapping.ProjectId}
	if node == "" {
		membership.State, membership.ReasonCode = pb.GithubWriteState_GITHUB_WRITE_STATE_FAILED, "ISSUE_NODE_UNKNOWN"
		return []*pb.GithubWriteOutcome{membership}
	}
	item, err := client.ProjectItem(ctx, node, mapping.ProjectId, mapping.ProjectFieldId)
	if err != nil {
		membership.State, membership.ReasonCode = writeFailure(s.translate(err))
		return []*pb.GithubWriteOutcome{membership}
	}
	if item.ItemID == "" {
		id, err := client.AddProjectItem(ctx, mapping.ProjectId, node)
		if err != nil {
			membership.State, membership.ReasonCode = writeFailure(s.translate(err))
			return []*pb.GithubWriteOutcome{membership}
		}
		item.ItemID = id
		membership.State = pb.GithubWriteState_GITHUB_WRITE_STATE_APPLIED
	} else {
		membership.State, membership.ReasonCode = pb.GithubWriteState_GITHUB_WRITE_STATE_SKIPPED, "ALREADY_ON_PROJECT"
	}
	field := &pb.GithubWriteOutcome{ActionId: "project-field", Target: "project_field", PreviousValue: item.OptionID, RequestedValue: target.ProjectOptionId}
	if err = client.SetProjectField(ctx, mapping.ProjectId, item.ItemID, mapping.ProjectFieldId, target.ProjectOptionId); err != nil {
		field.State, field.ReasonCode = writeFailure(s.translate(err))
	} else {
		field.State = pb.GithubWriteState_GITHUB_WRITE_STATE_APPLIED
	}
	return []*pb.GithubWriteOutcome{membership, field}
}

func (s *Service) moveState(ctx context.Context, client *githubapi.Client, ref *pb.GithubRepositoryRef, issue *pb.GithubIssue, target *pb.GithubStatusGroup) *pb.GithubWriteOutcome {
	state, err := stateName(target.CouplesIssueState)
	outcome := &pb.GithubWriteOutcome{ActionId: "issue-state", Target: "issue_state", PreviousValue: stateLabel(issue.State), RequestedValue: state}
	if err != nil {
		outcome.State, outcome.ReasonCode = pb.GithubWriteState_GITHUB_WRITE_STATE_FAILED, "STATE_INVALID"
		return outcome
	}
	if _, err = client.PatchIssue(ctx, ref, issue.Number, map[string]any{"state": state}, s.now().UnixMilli()); err != nil {
		outcome.State, outcome.ReasonCode = writeFailure(s.translate(err))
		return outcome
	}
	outcome.State = pb.GithubWriteState_GITHUB_WRITE_STATE_APPLIED
	return outcome
}

func stateLabel(state pb.GithubIssueState) string {
	if name, err := stateName(state); err == nil {
		return name
	}
	return ""
}

// writeFailure keeps an unread outcome pending rather than calling it failed.
// "Pending" is what makes a caller reload instead of retrying.
func writeFailure(err error) (pb.GithubWriteState, string) {
	switch {
	case errors.Is(err, ErrUnknownOutcome):
		return pb.GithubWriteState_GITHUB_WRITE_STATE_PENDING, "UNKNOWN_OUTCOME"
	case errors.Is(err, storage.ErrConflict):
		return pb.GithubWriteState_GITHUB_WRITE_STATE_CONFLICTED, "REMOTE_CHANGED"
	case errors.Is(err, ErrRateLimited):
		return pb.GithubWriteState_GITHUB_WRITE_STATE_FAILED, "RATE_LIMITED"
	case errors.Is(err, ErrPermission):
		return pb.GithubWriteState_GITHUB_WRITE_STATE_FAILED, "FORBIDDEN"
	case errors.Is(err, storage.ErrNotFound):
		return pb.GithubWriteState_GITHUB_WRITE_STATE_FAILED, "NOT_FOUND"
	}
	return pb.GithubWriteState_GITHUB_WRITE_STATE_FAILED, "WRITE_FAILED"
}
