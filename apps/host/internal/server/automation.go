package server

import (
	"errors"
	"net/http"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/automation"
	"armadra.local/host/internal/automationhost"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
)

const AutomationPrefix = "/rpc/armadra.v1.AutomationService/"

func automationMethod(path string) bool {
	if !strings.HasPrefix(path, AutomationPrefix) {
		return false
	}
	switch strings.TrimPrefix(path, AutomationPrefix) {
	case "DefineCommandSession", "ListCommandSessions", "Define", "Activate", "Pause", "RunNow", "ListPlans", "ListRuns":
		return true
	}
	return false
}

func automationFailure(w http.ResponseWriter, err error) {
	switch {
	case automationhost.Unsupported(err):
		writeError(w, http.StatusNotImplemented, "UNSUPPORTED", "This Host has no execution Worker for automation")
	case errors.Is(err, auth.ErrUnauthenticated):
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "Device session is invalid or expired")
	case errors.Is(err, auth.ErrPermission), errors.Is(err, automation.ErrAuthorization):
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "Automation permission or CSRF check failed")
	case errors.Is(err, auth.ErrInvalid), errors.Is(err, automation.ErrInvalid), errors.Is(err, storage.ErrInvalid):
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid automation request")
	case errors.Is(err, storage.ErrConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "Automation state changed; reload its current revision")
	case errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Automation plan, run or command session was not found")
	default:
		writeError(w, http.StatusInternalServerError, "INTERNAL", "Automation operation failed")
	}
}

// automationCaller derives the caller from the authenticated session alone.
// The request's scope selects which workspace is being asked for; it never
// supplies identity, and a host or execution host that is not this Host is
// refused rather than quietly reinterpreted as local.
func automationCaller(r *http.Request, host Identity, service *auth.Service, meta *pb.CommandMeta, permission string, mutating bool) (automationhost.Caller, error) {
	scope := meta.GetScope()
	if scope == nil || scope.WorkspaceId == "" {
		return automationhost.Caller{}, auth.ErrInvalid
	}
	if scope.HostId != "" && scope.HostId != host.HostID {
		return automationhost.Caller{}, auth.ErrPermission
	}
	if scope.ExecutionHostId != "" && scope.ExecutionHostId != host.HostID {
		return automationhost.Caller{}, auth.ErrPermission
	}
	request := auth.AccessRequest{
		HostID:         host.HostID,
		Origin:         r.Header.Get("Origin"),
		AccessToken:    credential(r, host.HostID, "access"),
		CSRFToken:      r.Header.Get("X-Armadra-CSRF"),
		RequireCSRF:    mutating,
		RequiredScopes: []auth.Scope{{Permission: permission, WorkspaceID: scope.WorkspaceId, ExecutionHostID: host.HostID}},
	}
	principal, err := service.Authenticate(r.Context(), request)
	if err != nil {
		return automationhost.Caller{}, err
	}
	return automationhost.Caller{PrincipalID: principal.PrincipalID, DeviceID: principal.DeviceID, DeviceEpoch: principal.DeviceEpoch, WorkspaceID: scope.WorkspaceId, Scopes: principal.Scopes}, nil
}

// automationRequest serves the scheduling surface. A Host started without an
// execution Worker answers UNSUPPORTED here; it never returns empty listings
// or an accepted plan that nothing will ever run.
func automationRequest(w http.ResponseWriter, r *http.Request, host Identity, service *auth.Service, plans *automationhost.Service) {
	origin := r.Header.Get("Origin")
	if origin == "" || len(r.Header.Values("Origin")) != 1 || len(r.Header.Values("X-Armadra-CSRF")) > 1 {
		authFailure(w, auth.ErrPermission)
		return
	}
	// A Host with no Worker still authenticates first: the caller learns that
	// automation is unsupported here, never that a plan was accepted.
	switch strings.TrimPrefix(r.URL.Path, AutomationPrefix) {
	case "DefineCommandSession":
		input := new(pb.DefineCommandSessionRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := automationCaller(r, host, service, input.Meta, automationhost.ScopeManage, true)
		if err != nil {
			automationFailure(w, err)
			return
		}
		session, err := plans.DefineCommandSession(r.Context(), caller, input.SessionId, input.RootPath, input.Launch)
		if err != nil {
			automationFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, session)
	case "ListCommandSessions":
		input := new(pb.ListCommandSessionsRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := automationCaller(r, host, service, input.Meta, automationhost.ScopeRead, false)
		if err != nil {
			automationFailure(w, err)
			return
		}
		result, err := plans.ListCommandSessions(r.Context(), caller, input.AfterId, int(input.Limit))
		if err != nil {
			automationFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "Define":
		input := new(pb.DefineAutomationRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := automationCaller(r, host, service, input.Meta, automationhost.ScopeManage, true)
		if err != nil {
			automationFailure(w, err)
			return
		}
		snapshot, err := plans.Define(r.Context(), caller, input.PlanId, input.Config, input.Payload, input.ExpectedRevision)
		if err != nil {
			automationFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, snapshot)
	case "Activate":
		input := new(pb.ActivateAutomationRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := automationCaller(r, host, service, input.Meta, automationhost.ScopeManage, true)
		if err != nil {
			automationFailure(w, err)
			return
		}
		snapshot, err := plans.Activate(r.Context(), caller, input.PlanId, input.ExpectedRevision, input.ConfigVersion, input.ConfigSha256)
		if err != nil {
			automationFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, snapshot)
	case "Pause":
		input := new(pb.PauseAutomationRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := automationCaller(r, host, service, input.Meta, automationhost.ScopeManage, true)
		if err != nil {
			automationFailure(w, err)
			return
		}
		snapshot, err := plans.Pause(r.Context(), caller, input.PlanId, input.ExpectedRevision)
		if err != nil {
			automationFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, snapshot)
	case "RunNow":
		input := new(pb.RunAutomationNowRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := automationCaller(r, host, service, input.Meta, automationhost.ScopeManage, true)
		if err != nil {
			automationFailure(w, err)
			return
		}
		run, err := plans.RunNow(r.Context(), caller, input.PlanId, input.ExpectedRevision)
		if err != nil {
			automationFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, run)
	case "ListPlans":
		input := new(pb.ListAutomationPlansRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := automationCaller(r, host, service, input.Meta, automationhost.ScopeRead, false)
		if err != nil {
			automationFailure(w, err)
			return
		}
		result, err := plans.ListPlans(r.Context(), caller, input.AfterId, int(input.Limit))
		if err != nil {
			automationFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "ListRuns":
		input := new(pb.ListAutomationRunsRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := automationCaller(r, host, service, input.Meta, automationhost.ScopeRead, false)
		if err != nil {
			automationFailure(w, err)
			return
		}
		result, err := plans.ListRuns(r.Context(), caller, input.PlanId, input.AfterId, int(input.Limit))
		if err != nil {
			automationFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	}
}
