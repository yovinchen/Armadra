package server

import (
	"errors"
	"net/http"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/githost"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
)

const GitPrefix = "/rpc/armadra.v1.GitService/"

// The git domain's HTTPS surface (Go Host 业务所有权迁移 §2.8).
//
// Writes are one method. `Enqueue` is where every stage, commit, branch, push
// and worktree change arrives, classified by `kind`, and the panel's thirty
// former routes are assembled into it by the gateway. That is not a
// simplification for its own sake: the queue is what makes two writes to one
// checkout sequential, and thirty entry points would be thirty places to
// forget it.
//
// Reads are forwarded. `Read` carries a closed method enum and the Runtime's
// own JSON body, and what comes back keeps the status the Runtime's own route
// would have returned. Nothing is cached except `RepositoryState`, which
// carries the time it was observed so it can never be mistaken for the
// repository itself.
//
// The grants are the ones `scopes.go` already applies to the Runtime's git
// routes: `git:read` to look, `git:write` plus `terminal:write` to make the
// machine run something. Keeping them identical is what makes the permission
// table comparable across the switch (§6.3 权限对照).
func gitMethod(path string) bool {
	if !strings.HasPrefix(path, GitPrefix) {
		return false
	}
	switch strings.TrimPrefix(path, GitPrefix) {
	case "Enqueue", "GetOperation", "ListOperations", "CancelOperation",
		"RepositoryState", "Read", "GenerateMessage",
		"Clone", "GetClone", "CancelClone":
		return true
	}
	return false
}

// errGitUnsupported is returned after the caller has been authenticated on a
// Host that assembles no git service. Authenticating first keeps the answer the
// same shape as every other surface: the device learns the surface is
// unavailable here, never that its repository has no history.
var errGitUnsupported = errors.New("this Host has no git service")

func gitFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errGitUnsupported), errors.Is(err, githost.ErrUnsupported):
		writeError(w, http.StatusNotImplemented, "UNSUPPORTED", "This Host has no git execution channel")
	case errors.Is(err, githost.ErrOwnershipMoved):
		// One stable code both services use, so a client can act on it without
		// having to tell "the Host will not write" from "the Runtime will not".
		writeError(w, http.StatusConflict, "CONFLICT", "ownership_moved")
	case errors.Is(err, auth.ErrUnauthenticated):
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "Device session is invalid or expired")
	case errors.Is(err, auth.ErrPermission), errors.Is(err, githost.ErrAuthorization):
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "Git permission or CSRF check failed")
	case errors.Is(err, githost.ErrNotFound), errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "That git record is unknown here")
	case errors.Is(err, githost.ErrInvalid), errors.Is(err, auth.ErrInvalid), errors.Is(err, storage.ErrInvalid):
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid git request")
	case errors.Is(err, githost.ErrBusy):
		writeError(w, http.StatusConflict, "CONFLICT", "Too many git operations are already in flight")
	case errors.Is(err, githost.ErrTerminal):
		writeError(w, http.StatusConflict, "CONFLICT", "That git operation has already finished")
	case errors.Is(err, storage.ErrIdempotencyConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "This operation id was already used for a different request")
	case errors.Is(err, storage.ErrConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "The record changed; reload its current revision")
	case errors.Is(err, storage.ErrCounterExhausted):
		writeError(w, http.StatusInsufficientStorage, "RESOURCE_EXHAUSTED", "Git revision space is exhausted")
	default:
		writeError(w, http.StatusInternalServerError, "INTERNAL", "Git operation failed")
	}
}

// gitCaller derives the caller from the authenticated session. The workspace
// comes from the session's own scope; the repository inside it comes from the
// request, and is checked against the workspace by the service.
//
// The scope is only checked for authentication here. The finer question — does
// this device hold git:write, and terminal:write on top of it — is the
// service's, so the answer is decided in one place rather than split between
// the transport and the domain.
func gitCaller(r *http.Request, host Identity, service *auth.Service, git *githost.Service, meta *pb.CommandMeta, permission string, mutating bool) (githost.Caller, error) {
	scope := meta.GetScope()
	if scope == nil || scope.WorkspaceId == "" {
		return githost.Caller{}, auth.ErrInvalid
	}
	if scope.HostId != "" && scope.HostId != host.HostID {
		return githost.Caller{}, auth.ErrPermission
	}
	if scope.ExecutionHostId != "" && scope.ExecutionHostId != host.HostID {
		return githost.Caller{}, auth.ErrPermission
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
		return githost.Caller{}, err
	}
	if git == nil {
		return githost.Caller{}, errGitUnsupported
	}
	return githost.Caller{PrincipalID: principal.PrincipalID, DeviceID: principal.DeviceID, DeviceEpoch: principal.DeviceEpoch, WorkspaceID: scope.WorkspaceId, Scopes: principal.Scopes}, nil
}

func gitRequest(w http.ResponseWriter, r *http.Request, host Identity, service *auth.Service, git *githost.Service) {
	origin := r.Header.Get("Origin")
	if origin == "" || len(r.Header.Values("Origin")) != 1 || len(r.Header.Values("X-Armadra-CSRF")) > 1 {
		authFailure(w, auth.ErrPermission)
		return
	}
	switch strings.TrimPrefix(r.URL.Path, GitPrefix) {
	case "Enqueue":
		input := new(pb.EnqueueGitOperationRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := gitCaller(r, host, service, git, input.Meta, githost.ScopeWrite, true)
		if err != nil {
			gitFailure(w, err)
			return
		}
		result, err := git.Enqueue(r.Context(), caller, input)
		if err != nil {
			gitFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "GetOperation":
		input := new(pb.GetGitOperationRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := gitCaller(r, host, service, git, input.Meta, githost.ScopeRead, false)
		if err != nil {
			gitFailure(w, err)
			return
		}
		result, err := git.GetOperation(r.Context(), caller, input)
		if err != nil {
			gitFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "ListOperations":
		input := new(pb.ListGitOperationsRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := gitCaller(r, host, service, git, input.Meta, githost.ScopeRead, false)
		if err != nil {
			gitFailure(w, err)
			return
		}
		result, err := git.ListOperations(r.Context(), caller, input)
		if err != nil {
			gitFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "CancelOperation":
		input := new(pb.CancelGitOperationRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := gitCaller(r, host, service, git, input.Meta, githost.ScopeWrite, true)
		if err != nil {
			gitFailure(w, err)
			return
		}
		result, err := git.CancelOperation(r.Context(), caller, input)
		if err != nil {
			gitFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "RepositoryState":
		input := new(pb.GetRepositoryStateRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		// Re-observing runs `git status` on the machine, which changes nothing;
		// it is a read, and it is a mutation only in the sense that the Host
		// stores what it saw. The CSRF requirement follows the grant, not the
		// side effect on the cache.
		caller, err := gitCaller(r, host, service, git, input.Meta, githost.ScopeRead, false)
		if err != nil {
			gitFailure(w, err)
			return
		}
		result, err := git.RepositoryState(r.Context(), caller, input)
		if err != nil {
			gitFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "Read":
		input := new(pb.ReadGitRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := gitCaller(r, host, service, git, input.Meta, githost.ScopeRead, false)
		if err != nil {
			gitFailure(w, err)
			return
		}
		result, err := git.Read(r.Context(), caller, input)
		if err != nil {
			gitFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "GenerateMessage":
		input := new(pb.GenerateGitMessageRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := gitCaller(r, host, service, git, input.Meta, githost.ScopeWrite, true)
		if err != nil {
			gitFailure(w, err)
			return
		}
		result, err := git.GenerateMessage(r.Context(), caller, input)
		if err != nil {
			gitFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "Clone":
		input := new(pb.StartGitCloneRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := gitCaller(r, host, service, git, input.Meta, githost.ScopeWrite, true)
		if err != nil {
			gitFailure(w, err)
			return
		}
		result, err := git.Clone(r.Context(), caller, input)
		if err != nil {
			gitFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "GetClone":
		input := new(pb.GetGitCloneRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := gitCaller(r, host, service, git, input.Meta, githost.ScopeRead, false)
		if err != nil {
			gitFailure(w, err)
			return
		}
		result, err := git.GetClone(r.Context(), caller, input)
		if err != nil {
			gitFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "CancelClone":
		input := new(pb.CancelGitCloneRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := gitCaller(r, host, service, git, input.Meta, githost.ScopeWrite, true)
		if err != nil {
			gitFailure(w, err)
			return
		}
		result, err := git.CancelClone(r.Context(), caller, input)
		if err != nil {
			gitFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	}
}
