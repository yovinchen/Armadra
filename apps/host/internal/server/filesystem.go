package server

import (
	"errors"
	"net/http"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/fshost"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
)

const FilesystemPrefix = "/rpc/armadra.v1.FilesystemService/"

// Where a workspace's files are and who may touch them
// (Go Host 业务所有权迁移 §2.5).
//
// The surface is workspace-scoped and permission-scoped end to end, and it is
// governed by the same `files:read` / `files:write` grants that govern the
// Runtime file routes this Host proxies. That is what makes the permission
// table comparable across a switch: the same device with the same grants gets
// the same allow/deny answer before and after the domain moves.
//
// Reading and writing files are deliberately absent. They are execution, they
// stay on the execution host, and they keep going through the proxy whichever
// side owns this record.
func filesystemMethod(path string) bool {
	if !strings.HasPrefix(path, FilesystemPrefix) {
		return false
	}
	switch strings.TrimPrefix(path, FilesystemPrefix) {
	case "GetRoot", "ListRoots", "RegisterRoot", "UpdateRoot", "UnregisterRoot":
		return true
	}
	return false
}

// errFilesystemUnsupported is returned after the caller has been authenticated
// on a Host that assembles no filesystem service. Authenticating first keeps
// the answer the same shape as every other surface: the device learns the
// surface is unavailable here, never that its workspace has no root.
var errFilesystemUnsupported = errors.New("this Host has no filesystem service")

func filesystemFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errFilesystemUnsupported):
		writeError(w, http.StatusNotImplemented, "UNSUPPORTED", "This Host has no filesystem service")
	case errors.Is(err, fshost.ErrOwnershipMoved):
		// One stable code both services use, so a client can act on it without
		// having to tell "the Host will not write" from "the Runtime will not".
		writeError(w, http.StatusConflict, "CONFLICT", "ownership_moved")
	case errors.Is(err, auth.ErrUnauthenticated):
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "Device session is invalid or expired")
	case errors.Is(err, auth.ErrPermission), errors.Is(err, fshost.ErrAuthorization):
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "Filesystem permission or CSRF check failed")
	case errors.Is(err, fshost.ErrNotRegistered), errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "This workspace has no registered root")
	case errors.Is(err, fshost.ErrInvalid), errors.Is(err, auth.ErrInvalid), errors.Is(err, storage.ErrInvalid):
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid filesystem request")
	case errors.Is(err, storage.ErrIdempotencyConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "This operation id was already used for a different request")
	case errors.Is(err, storage.ErrConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "The root changed; reload its current revision")
	case errors.Is(err, storage.ErrCounterExhausted):
		writeError(w, http.StatusInsufficientStorage, "RESOURCE_EXHAUSTED", "Root revision space is exhausted")
	default:
		writeError(w, http.StatusInternalServerError, "INTERNAL", "Filesystem operation failed")
	}
}

// filesystemCaller derives the caller from the authenticated session. The scope
// in the request selects the workspace being asked about; a host or execution
// host that is not this Host is refused rather than reinterpreted as local.
func filesystemCaller(r *http.Request, host Identity, service *auth.Service, roots *fshost.Service, meta *pb.CommandMeta, permission string, mutating bool) (fshost.Caller, error) {
	scope := meta.GetScope()
	if scope == nil || scope.WorkspaceId == "" {
		return fshost.Caller{}, auth.ErrInvalid
	}
	if scope.HostId != "" && scope.HostId != host.HostID {
		return fshost.Caller{}, auth.ErrPermission
	}
	if scope.ExecutionHostId != "" && scope.ExecutionHostId != host.HostID {
		return fshost.Caller{}, auth.ErrPermission
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
		return fshost.Caller{}, err
	}
	if roots == nil {
		return fshost.Caller{}, errFilesystemUnsupported
	}
	return fshost.Caller{PrincipalID: principal.PrincipalID, DeviceID: principal.DeviceID, DeviceEpoch: principal.DeviceEpoch, WorkspaceID: scope.WorkspaceId, Scopes: principal.Scopes}, nil
}

func filesystemRequest(w http.ResponseWriter, r *http.Request, host Identity, service *auth.Service, roots *fshost.Service) {
	origin := r.Header.Get("Origin")
	if origin == "" || len(r.Header.Values("Origin")) != 1 || len(r.Header.Values("X-Armadra-CSRF")) > 1 {
		authFailure(w, auth.ErrPermission)
		return
	}
	switch strings.TrimPrefix(r.URL.Path, FilesystemPrefix) {
	case "GetRoot":
		input := new(pb.GetWorkspaceRootRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := filesystemCaller(r, host, service, roots, input.Meta, fshost.ScopeRead, false)
		if err != nil {
			filesystemFailure(w, err)
			return
		}
		result, err := roots.GetRoot(r.Context(), caller, input.WorkspaceId)
		if err != nil {
			filesystemFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "ListRoots":
		input := new(pb.ListWorkspaceRootsRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := filesystemCaller(r, host, service, roots, input.Meta, fshost.ScopeRead, false)
		if err != nil {
			filesystemFailure(w, err)
			return
		}
		result, err := roots.ListRoots(r.Context(), caller, input.AfterWorkspaceId, input.Limit)
		if err != nil {
			filesystemFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "RegisterRoot":
		input := new(pb.RegisterWorkspaceRootRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := filesystemCaller(r, host, service, roots, input.Meta, fshost.ScopeWrite, true)
		if err != nil {
			filesystemFailure(w, err)
			return
		}
		result, err := roots.RegisterRoot(r.Context(), caller, input)
		if err != nil {
			filesystemFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "UpdateRoot":
		input := new(pb.UpdateWorkspaceRootRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := filesystemCaller(r, host, service, roots, input.Meta, fshost.ScopeWrite, true)
		if err != nil {
			filesystemFailure(w, err)
			return
		}
		result, err := roots.UpdateRoot(r.Context(), caller, input)
		if err != nil {
			filesystemFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "UnregisterRoot":
		input := new(pb.UnregisterWorkspaceRootRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := filesystemCaller(r, host, service, roots, input.Meta, fshost.ScopeWrite, true)
		if err != nil {
			filesystemFailure(w, err)
			return
		}
		result, err := roots.UnregisterRoot(r.Context(), caller, input)
		if err != nil {
			filesystemFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	}
}
