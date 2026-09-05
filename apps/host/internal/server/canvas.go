package server

import (
	"errors"
	"net/http"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/canvashost"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
)

const CanvasPrefix = "/rpc/armadra.v1.CanvasService/"

// The canvas surface is workspace-scoped and permission-scoped end to end.
// Reads need canvas:read, mutations need canvas:write and the CSRF header, and
// every request's workspace comes from the caller's own grants rather than
// from anything the request claims about itself.
//
// Switching write ownership is deliberately absent: it is an operator action
// taken in a maintenance window through the local CLI, not something a browser
// session can ask for. GetOwnership is here because a client has to know which
// service currently owns its canvas before it saves anything.
func canvasMethod(path string) bool {
	if !strings.HasPrefix(path, CanvasPrefix) {
		return false
	}
	switch strings.TrimPrefix(path, CanvasPrefix) {
	case "ListWorkspaces", "PutWorkspace", "DeleteWorkspace",
		"ListCanvases", "GetDocument", "SaveDocument", "DeleteCanvas",
		"SubscribeEvents", "GetSnapshot", "GetOwnership":
		return true
	}
	return false
}

// errCanvasUnsupported is returned after the caller has been authenticated on
// a Host that assembles no canvas service. Authenticating first keeps the
// answer the same shape as every other surface: the device learns the surface
// is unavailable here, never that its workspace is empty.
var errCanvasUnsupported = errors.New("this Host has no canvas service")

func canvasFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errCanvasUnsupported):
		writeError(w, http.StatusNotImplemented, "UNSUPPORTED", "This Host has no canvas service")
	case errors.Is(err, canvashost.ErrOwnershipMoved):
		// One stable code both services use, so a client can act on it without
		// having to tell "the Host will not write" from "the Runtime will not".
		writeError(w, http.StatusConflict, "CONFLICT", "ownership_moved")
	case errors.Is(err, auth.ErrUnauthenticated):
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "Device session is invalid or expired")
	case errors.Is(err, auth.ErrPermission), errors.Is(err, canvashost.ErrAuthorization):
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "Canvas permission or CSRF check failed")
	case errors.Is(err, canvashost.ErrInvalid), errors.Is(err, auth.ErrInvalid), errors.Is(err, storage.ErrInvalid):
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid canvas request")
	case errors.Is(err, storage.ErrIdempotencyConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "This operation id was already used for a different request")
	case errors.Is(err, storage.ErrConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "Canvas changed; reload its current revision")
	case errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Workspace or canvas was not found")
	case errors.Is(err, storage.ErrCounterExhausted):
		writeError(w, http.StatusInsufficientStorage, "RESOURCE_EXHAUSTED", "Canvas revision space is exhausted")
	default:
		writeError(w, http.StatusInternalServerError, "INTERNAL", "Canvas operation failed")
	}
}

// canvasCaller derives the caller from the authenticated session. The scope in
// the request selects the workspace being asked about; a host or execution host
// that is not this Host is refused rather than reinterpreted as local.
func canvasCaller(r *http.Request, host Identity, service *auth.Service, canvases *canvashost.Service, meta *pb.CommandMeta, permission string, mutating bool) (canvashost.Caller, error) {
	scope := meta.GetScope()
	if scope == nil || scope.WorkspaceId == "" {
		return canvashost.Caller{}, auth.ErrInvalid
	}
	if scope.HostId != "" && scope.HostId != host.HostID {
		return canvashost.Caller{}, auth.ErrPermission
	}
	if scope.ExecutionHostId != "" && scope.ExecutionHostId != host.HostID {
		return canvashost.Caller{}, auth.ErrPermission
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
		return canvashost.Caller{}, err
	}
	if canvases == nil {
		return canvashost.Caller{}, errCanvasUnsupported
	}
	return canvashost.Caller{PrincipalID: principal.PrincipalID, DeviceID: principal.DeviceID, DeviceEpoch: principal.DeviceEpoch, WorkspaceID: scope.WorkspaceId, Scopes: principal.Scopes}, nil
}

func canvasRequest(w http.ResponseWriter, r *http.Request, host Identity, service *auth.Service, canvases *canvashost.Service) {
	origin := r.Header.Get("Origin")
	if origin == "" || len(r.Header.Values("Origin")) != 1 || len(r.Header.Values("X-Armadra-CSRF")) > 1 {
		authFailure(w, auth.ErrPermission)
		return
	}
	switch strings.TrimPrefix(r.URL.Path, CanvasPrefix) {
	case "ListWorkspaces":
		input := new(pb.ListCanvasWorkspacesRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := canvasCaller(r, host, service, canvases, input.Meta, canvashost.ScopeRead, false)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		result, err := canvases.ListWorkspaces(r.Context(), caller, input.AfterId, input.Limit)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "PutWorkspace":
		input := new(pb.PutCanvasWorkspaceRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := canvasCaller(r, host, service, canvases, input.Meta, canvashost.ScopeWrite, true)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		result, err := canvases.PutWorkspace(r.Context(), caller, input.OperationId, input.Workspace, input.ExpectedRevision)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "DeleteWorkspace":
		input := new(pb.DeleteCanvasWorkspaceRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := canvasCaller(r, host, service, canvases, input.Meta, canvashost.ScopeWrite, true)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		result, err := canvases.DeleteWorkspace(r.Context(), caller, input.OperationId, input.WorkspaceId, input.ExpectedRevision)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "ListCanvases":
		input := new(pb.ListCanvasesRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := canvasCaller(r, host, service, canvases, input.Meta, canvashost.ScopeRead, false)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		result, err := canvases.ListCanvases(r.Context(), caller, input.AfterId, input.Limit)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "GetDocument":
		input := new(pb.GetCanvasDocumentRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := canvasCaller(r, host, service, canvases, input.Meta, canvashost.ScopeRead, false)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		result, err := canvases.GetDocument(r.Context(), caller, input.CanvasId)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "SaveDocument":
		input := new(pb.SaveCanvasDocumentRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := canvasCaller(r, host, service, canvases, input.Meta, canvashost.ScopeWrite, true)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		result, err := canvases.SaveDocument(r.Context(), caller, input)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "DeleteCanvas":
		input := new(pb.DeleteCanvasRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := canvasCaller(r, host, service, canvases, input.Meta, canvashost.ScopeWrite, true)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		result, err := canvases.DeleteCanvas(r.Context(), caller, input.OperationId, input.CanvasId, input.ExpectedRevision)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "SubscribeEvents":
		input := new(pb.SubscribeCanvasEventsRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := canvasCaller(r, host, service, canvases, input.Meta, canvashost.ScopeRead, false)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		result, err := canvases.SubscribeEvents(r.Context(), caller, input.AfterSequence, input.Limit)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "GetSnapshot":
		input := new(pb.GetCanvasSnapshotRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := canvasCaller(r, host, service, canvases, input.Meta, canvashost.ScopeRead, false)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		result, err := canvases.GetSnapshot(r.Context(), caller, input.AfterId, input.Limit)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "GetOwnership":
		input := new(pb.GetCanvasOwnershipRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := canvasCaller(r, host, service, canvases, input.Meta, canvashost.ScopeRead, false)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		result, err := canvases.GetOwnership(r.Context(), caller)
		if err != nil {
			canvasFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	}
}
