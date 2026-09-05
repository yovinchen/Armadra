package server

import (
	"errors"
	"net/http"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/githubcred"
	"armadra.local/host/internal/githubhost"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const GithubPrefix = "/rpc/armadra.v1.GithubService/"

func githubMethod(path string) bool {
	if !strings.HasPrefix(path, GithubPrefix) {
		return false
	}
	switch strings.TrimPrefix(path, GithubPrefix) {
	case "GetCredential", "ConfigureCredential", "RevokeCredential",
		"ResolveRepository",
		"ListIssues", "GetIssue", "CreateIssue", "UpdateIssue", "SetIssueState", "CommentIssue",
		"GetStatusMapping", "PutStatusMapping", "MoveIssue",
		"ListPulls", "GetPull", "CreatePull", "SubmitReview", "GetChecks", "MergePull",
		"LinkReference", "UnlinkReference", "ListReferences":
		return true
	}
	return false
}

func githubFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, githubhost.ErrUnsupported), errors.Is(err, githubcred.ErrUnsupported), errors.Is(err, githubcred.ErrUnavailable):
		writeError(w, http.StatusNotImplemented, "UNSUPPORTED", "This Host has no usable GitHub credential")
	case errors.Is(err, auth.ErrUnauthenticated):
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "Device session is invalid or expired")
	case errors.Is(err, auth.ErrPermission), errors.Is(err, githubhost.ErrPermission):
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "GitHub permission or CSRF check failed")
	case errors.Is(err, auth.ErrInvalid), errors.Is(err, githubhost.ErrInvalid), errors.Is(err, githubcred.ErrInvalid), errors.Is(err, storage.ErrInvalid):
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid GitHub request")
	case errors.Is(err, githubhost.ErrRateLimited):
		writeError(w, http.StatusTooManyRequests, "RESOURCE_EXHAUSTED", "GitHub rate limit reached; retry after it resets")
	case errors.Is(err, githubhost.ErrUnknownOutcome):
		// The write may have been applied. The caller must reload, never retry.
		writeError(w, http.StatusGatewayTimeout, "UNKNOWN_OUTCOME", "The GitHub write result was not read; reload before retrying")
	case errors.Is(err, storage.ErrConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "The remote or the stored revision changed; reload it")
	case errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "The repository, Issue, pull request or reference was not found")
	default:
		writeError(w, http.StatusInternalServerError, "INTERNAL", "GitHub operation failed")
	}
}

// githubCaller derives the caller from the authenticated session alone. The
// request's scope selects the workspace; it never supplies identity, and a host
// that is not this Host is refused rather than reinterpreted as local.
func githubCaller(r *http.Request, host Identity, service *auth.Service, meta *pb.CommandMeta, permission string, mutating bool) (githubhost.Caller, error) {
	scope := meta.GetScope()
	if scope == nil || scope.WorkspaceId == "" {
		return githubhost.Caller{}, auth.ErrInvalid
	}
	if scope.HostId != "" && scope.HostId != host.HostID {
		return githubhost.Caller{}, auth.ErrPermission
	}
	if scope.ExecutionHostId != "" && scope.ExecutionHostId != host.HostID {
		return githubhost.Caller{}, auth.ErrPermission
	}
	principal, err := service.Authenticate(r.Context(), auth.AccessRequest{
		HostID:         host.HostID,
		Origin:         r.Header.Get("Origin"),
		AccessToken:    credential(r, host.HostID, "access"),
		CSRFToken:      r.Header.Get("X-Armadra-CSRF"),
		RequireCSRF:    mutating,
		RequiredScopes: []auth.Scope{{Permission: permission, WorkspaceID: scope.WorkspaceId, ExecutionHostID: host.HostID}},
	})
	if err != nil {
		return githubhost.Caller{}, err
	}
	return githubhost.Caller{PrincipalID: principal.PrincipalID, DeviceID: principal.DeviceID, DeviceEpoch: principal.DeviceEpoch, WorkspaceID: scope.WorkspaceId, Scopes: principal.Scopes}, nil
}

// writeGithub refuses to send a frame a conforming client cannot read. A
// response over the frame budget is an error the caller can act on, not a body
// that gets truncated into something it will misparse.
func writeGithub(w http.ResponseWriter, message proto.Message) {
	wire, err := proto.Marshal(message)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", "Response encoding failed")
		return
	}
	if len(wire) > MaxFrameBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "RESOURCE_EXHAUSTED", "The GitHub result exceeds the frame budget; narrow the request")
		return
	}
	w.Header().Set("Content-Type", MediaType)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(wire)
}

// listBodies are omitted from list responses. A hundred Issue bodies would not
// fit one frame, and a truncated body is worse than an absent one: the detail
// request returns the whole thing.
func withoutIssueBodies(response *pb.ListGithubIssuesResponse) *pb.ListGithubIssuesResponse {
	for _, issue := range response.GetIssues() {
		issue.Body = ""
	}
	return response
}

func withoutPullBodies(response *pb.ListGithubPullsResponse) *pb.ListGithubPullsResponse {
	for _, pull := range response.GetPulls() {
		pull.Body = ""
	}
	return response
}

// githubRequest serves the GitHub surface. A Host with no credential
// authenticates first and then answers UNSUPPORTED; it never returns an empty
// Issue list that reads as "no Issues".
func githubRequest(w http.ResponseWriter, r *http.Request, host Identity, service *auth.Service, github *githubhost.Service) {
	origin := r.Header.Get("Origin")
	if origin == "" || len(r.Header.Values("Origin")) != 1 || len(r.Header.Values("X-Armadra-CSRF")) > 1 {
		authFailure(w, auth.ErrPermission)
		return
	}
	read, write := githubhost.ScopeRead, githubhost.ScopeWrite
	switch strings.TrimPrefix(r.URL.Path, GithubPrefix) {
	case "GetCredential":
		input := new(pb.GetGithubCredentialRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, read, false)
		if !ok {
			return
		}
		status, err := github.GetCredential(r.Context(), caller)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, status)
	case "ConfigureCredential":
		input := new(pb.ConfigureGithubCredentialRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, write, true)
		if !ok {
			return
		}
		status, err := github.ConfigureCredential(r.Context(), caller, input)
		// The pasted token is dropped from this process's copy of the request as
		// soon as the call returns, whatever the outcome.
		input.Token = ""
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, status)
	case "RevokeCredential":
		input := new(pb.RevokeGithubCredentialRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, write, true)
		if !ok {
			return
		}
		status, err := github.RevokeCredential(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, status)
	case "ResolveRepository":
		input := new(pb.ResolveGithubRepositoryRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, read, false)
		if !ok {
			return
		}
		result, err := github.ResolveRepository(r.Context(), caller, input.RemoteUrl)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, result)
	case "ListIssues":
		input := new(pb.ListGithubIssuesRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, read, false)
		if !ok {
			return
		}
		result, err := github.ListIssues(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, withoutIssueBodies(result))
	case "GetIssue":
		input := new(pb.GetGithubIssueRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, read, false)
		if !ok {
			return
		}
		result, err := github.GetIssue(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, result)
	case "CreateIssue":
		input := new(pb.CreateGithubIssueRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, write, true)
		if !ok {
			return
		}
		issue, err := github.CreateIssue(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, issue)
	case "UpdateIssue":
		input := new(pb.UpdateGithubIssueRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, write, true)
		if !ok {
			return
		}
		issue, err := github.UpdateIssue(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, issue)
	case "SetIssueState":
		input := new(pb.SetGithubIssueStateRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, write, true)
		if !ok {
			return
		}
		issue, err := github.SetIssueState(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, issue)
	case "CommentIssue":
		input := new(pb.CommentGithubIssueRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, write, true)
		if !ok {
			return
		}
		comment, err := github.CommentIssue(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, comment)
	case "GetStatusMapping":
		input := new(pb.GetGithubStatusMappingRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, read, false)
		if !ok {
			return
		}
		mapping, err := github.GetStatusMapping(r.Context(), caller, input.Repository)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, mapping)
	case "PutStatusMapping":
		input := new(pb.PutGithubStatusMappingRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, write, true)
		if !ok {
			return
		}
		mapping, err := github.PutStatusMapping(r.Context(), caller, input.Mapping, input.ExpectedRevision)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, mapping)
	case "MoveIssue":
		input := new(pb.MoveGithubIssueRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, write, true)
		if !ok {
			return
		}
		result, err := github.MoveIssue(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, result)
	case "ListPulls":
		input := new(pb.ListGithubPullsRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, read, false)
		if !ok {
			return
		}
		result, err := github.ListPulls(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, withoutPullBodies(result))
	case "GetPull":
		input := new(pb.GetGithubPullRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, read, false)
		if !ok {
			return
		}
		result, err := github.GetPull(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, result)
	case "CreatePull":
		input := new(pb.CreateGithubPullRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, write, true)
		if !ok {
			return
		}
		pull, err := github.CreatePull(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, pull)
	case "SubmitReview":
		input := new(pb.SubmitGithubReviewRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, write, true)
		if !ok {
			return
		}
		review, err := github.SubmitReview(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, review)
	case "GetChecks":
		input := new(pb.GetGithubChecksRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, read, false)
		if !ok {
			return
		}
		checks, err := github.GetChecks(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, checks)
	case "MergePull":
		input := new(pb.MergeGithubPullRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, write, true)
		if !ok {
			return
		}
		result, err := github.MergePull(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, result)
	case "LinkReference":
		input := new(pb.LinkGithubReferenceRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, write, true)
		if !ok {
			return
		}
		reference, err := github.LinkReference(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, reference)
	case "UnlinkReference":
		input := new(pb.UnlinkGithubReferenceRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, write, true)
		if !ok {
			return
		}
		result, err := github.UnlinkReference(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, result)
	case "ListReferences":
		input := new(pb.ListGithubReferencesRequest)
		caller, ok := githubAuth(w, r, host, service, input, func() *pb.CommandMeta { return input.Meta }, read, false)
		if !ok {
			return
		}
		result, err := github.ListReferences(r.Context(), caller, input)
		if err != nil {
			githubFailure(w, err)
			return
		}
		writeGithub(w, result)
	}
}

// githubAuth decodes one request and authenticates it. Decoding first is
// deliberate: the scope that selects the workspace lives inside the message,
// and the session — not the message — supplies the identity checked against it.
func githubAuth(w http.ResponseWriter, r *http.Request, host Identity, service *auth.Service, message proto.Message, meta func() *pb.CommandMeta, permission string, mutating bool) (githubhost.Caller, bool) {
	if !decodeAuth(w, r, message) {
		return githubhost.Caller{}, false
	}
	caller, err := githubCaller(r, host, service, meta(), permission, mutating)
	if err != nil {
		githubFailure(w, err)
		return githubhost.Caller{}, false
	}
	return caller, true
}
