package server

import (
	"errors"
	"net/http"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/sessionhost"
	"armadra.local/host/internal/storage"
)

const SessionPrefix = "/rpc/armadra.v1.SessionService/"

// Whether a session should exist, and what it was frozen to launch
// (Go Host 业务所有权迁移 §2.6).
//
// The surface is workspace-scoped and permission-scoped end to end, and it is
// governed by the same `terminal:read` / `terminal:write` grants that govern
// the Runtime terminal routes this Host proxies. That is what makes the
// permission table comparable across the switch: the same device with the same
// grants gets the same allow/deny answer before and after the domain moves.
//
// The terminal byte stream is deliberately absent. Attaching is execution, it
// stays on the execution host, and it keeps going through the same WebSocket
// whichever side owns this record.
func sessionMethod(path string) bool {
	if !strings.HasPrefix(path, SessionPrefix) {
		return false
	}
	switch strings.TrimPrefix(path, SessionPrefix) {
	case "Create", "Start", "Get", "List", "Terminate", "Recycle", "Close", "SuggestTitle", "GetContextUsage":
		return true
	}
	return false
}

// errSessionUnsupported is returned after the caller has been authenticated on
// a Host that assembles no session service. Authenticating first keeps the
// answer the same shape as every other surface: the device learns the surface
// is unavailable here, never that its workspace has no sessions.
var errSessionUnsupported = errors.New("this Host has no session service")

func sessionFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errSessionUnsupported):
		writeError(w, http.StatusNotImplemented, "UNSUPPORTED", "This Host has no session service")
	case errors.Is(err, sessionhost.ErrOwnershipMoved):
		// One stable code both services use, so a client can act on it without
		// having to tell "the Host will not write" from "the Runtime will not".
		writeError(w, http.StatusConflict, "CONFLICT", "ownership_moved")
	case errors.Is(err, auth.ErrUnauthenticated):
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "Device session is invalid or expired")
	case errors.Is(err, auth.ErrPermission), errors.Is(err, sessionhost.ErrAuthorization):
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "Session permission or CSRF check failed")
	case errors.Is(err, sessionhost.ErrNotFound), errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No such session")
	case errors.Is(err, sessionhost.ErrStaleGeneration):
		// The caller decided against a pane that has been replaced. It is a
		// conflict rather than an error: reloading the session and deciding
		// again is exactly the right response.
		writeError(w, http.StatusConflict, "CONFLICT", "That generation has been replaced; reload the session")
	case errors.Is(err, sessionhost.ErrNoWorker):
		// Nothing was started and nothing was stopped. A client draws this as
		// "the machine is not reachable", never as a failed session.
		writeError(w, http.StatusServiceUnavailable, "UNAVAILABLE", "No Worker is reachable for this execution host")
	case errors.Is(err, sessionhost.ErrInvalid), errors.Is(err, auth.ErrInvalid), errors.Is(err, storage.ErrInvalid):
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid session request")
	case errors.Is(err, storage.ErrIdempotencyConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "This operation id was already used for a different request")
	case errors.Is(err, storage.ErrConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "The session changed; reload its current revision")
	case errors.Is(err, storage.ErrCounterExhausted):
		writeError(w, http.StatusInsufficientStorage, "RESOURCE_EXHAUSTED", "Session revision space is exhausted")
	default:
		writeError(w, http.StatusInternalServerError, "INTERNAL", "Session operation failed")
	}
}

// sessionCaller derives the caller from the authenticated session. The scope in
// the request selects the workspace being asked about; a host or execution host
// that is not this Host is refused rather than reinterpreted as local.
func sessionCaller(r *http.Request, host Identity, service *auth.Service, sessions *sessionhost.Service, meta *pb.CommandMeta, permission string, mutating bool) (sessionhost.Caller, error) {
	scope := meta.GetScope()
	if scope == nil || scope.WorkspaceId == "" {
		return sessionhost.Caller{}, auth.ErrInvalid
	}
	if scope.HostId != "" && scope.HostId != host.HostID {
		return sessionhost.Caller{}, auth.ErrPermission
	}
	if scope.ExecutionHostId != "" && scope.ExecutionHostId != host.HostID {
		return sessionhost.Caller{}, auth.ErrPermission
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
		return sessionhost.Caller{}, err
	}
	if sessions == nil {
		return sessionhost.Caller{}, errSessionUnsupported
	}
	return sessionhost.Caller{PrincipalID: principal.PrincipalID, DeviceID: principal.DeviceID, DeviceEpoch: principal.DeviceEpoch, WorkspaceID: scope.WorkspaceId, Scopes: principal.Scopes}, nil
}

func sessionRequest(w http.ResponseWriter, r *http.Request, host Identity, service *auth.Service, sessions *sessionhost.Service) {
	origin := r.Header.Get("Origin")
	if origin == "" || len(r.Header.Values("Origin")) != 1 || len(r.Header.Values("X-Armadra-CSRF")) > 1 {
		authFailure(w, auth.ErrPermission)
		return
	}
	switch strings.TrimPrefix(r.URL.Path, SessionPrefix) {
	case "Create":
		input := new(pb.CreateSessionRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := sessionCaller(r, host, service, sessions, input.Meta, sessionhost.ScopeWrite, true)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		result, err := sessions.CreateSession(r.Context(), caller, input)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "Start":
		input := new(pb.StartSessionRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := sessionCaller(r, host, service, sessions, input.Meta, sessionhost.ScopeWrite, true)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		result, err := sessions.StartSession(r.Context(), caller, input)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "Get":
		input := new(pb.GetSessionRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := sessionCaller(r, host, service, sessions, input.Meta, sessionhost.ScopeRead, false)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		result, err := sessions.GetSession(r.Context(), caller, input)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "List":
		input := new(pb.ListSessionsRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := sessionCaller(r, host, service, sessions, input.Meta, sessionhost.ScopeRead, false)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		result, err := sessions.ListSessions(r.Context(), caller, input)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "Terminate":
		input := new(pb.TerminateSessionRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := sessionCaller(r, host, service, sessions, input.Meta, sessionhost.ScopeWrite, true)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		result, err := sessions.TerminateSession(r.Context(), caller, input)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "Recycle":
		input := new(pb.RecycleSessionRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := sessionCaller(r, host, service, sessions, input.Meta, sessionhost.ScopeWrite, true)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		result, err := sessions.RecycleSession(r.Context(), caller, input)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "Close":
		input := new(pb.CloseSessionRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := sessionCaller(r, host, service, sessions, input.Meta, sessionhost.ScopeWrite, true)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		result, err := sessions.CloseSession(r.Context(), caller, input)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "SuggestTitle":
		input := new(pb.SuggestSessionTitleRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := sessionCaller(r, host, service, sessions, input.Meta, sessionhost.ScopeRead, false)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		result, err := sessions.SuggestTitle(r.Context(), caller, input)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "GetContextUsage":
		input := new(pb.GetSessionContextUsageRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := sessionCaller(r, host, service, sessions, input.Meta, sessionhost.ScopeRead, false)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		result, err := sessions.ContextUsage(r.Context(), caller, input)
		if err != nil {
			sessionFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	}
}
