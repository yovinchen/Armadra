package server

import (
	"errors"
	"net/http"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/settingshost"
	"armadra.local/host/internal/storage"
)

const SettingsPrefix = "/rpc/armadra.v1.SettingsService/"

// The settings surface is permission-scoped and host-wide.
//
// It follows the ownership surface rather than the canvas one: the settings
// document covers this machine, not a workspace, so the request's scope may
// name this Host but never narrows the requirement to a project. A device
// granted one workspace's settings cannot read the machine's document, and
// cannot learn its SSH registry either.
//
// Nothing here deletes the Runtime's own /api/settings and /api/ssh routes:
// while the Runtime owns the domain it is still the side that answers, and the
// front end keeps using it until the switch lands. Two readable surfaces are
// not two writers — which side may write is what OwnershipService reports, and
// Put refuses with ownership_moved until this Host is the settled owner.
func settingsMethod(path string) bool {
	if !strings.HasPrefix(path, SettingsPrefix) {
		return false
	}
	switch strings.TrimPrefix(path, SettingsPrefix) {
	case "Get", "Put":
		return true
	}
	return false
}

// errSettingsUnsupported is returned after the caller has been authenticated on
// a Host that assembles no settings service. Authenticating first keeps the
// answer the same shape as every other surface: the device learns the surface
// is unavailable here, never that its settings are empty.
var errSettingsUnsupported = errors.New("this Host has no settings service")

func settingsFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errSettingsUnsupported):
		writeError(w, http.StatusNotImplemented, "UNSUPPORTED", "This Host has no settings service")
	case errors.Is(err, settingshost.ErrOwnershipMoved):
		// One stable code both services use, so a client can act on it without
		// having to tell "the Host will not write" from "the Runtime will not".
		writeError(w, http.StatusConflict, "CONFLICT", "ownership_moved")
	case errors.Is(err, auth.ErrUnauthenticated):
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "Device session is invalid or expired")
	case errors.Is(err, auth.ErrPermission), errors.Is(err, settingshost.ErrAuthorization):
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "Settings permission or CSRF check failed")
	case errors.Is(err, settingshost.ErrTooManyChanges):
		writeError(w, http.StatusRequestEntityTooLarge, "RESOURCE_EXHAUSTED", "Settings request exceeds one transaction")
	case errors.Is(err, settingshost.ErrInvalid), errors.Is(err, auth.ErrInvalid), errors.Is(err, storage.ErrInvalid):
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid settings request")
	case errors.Is(err, storage.ErrIdempotencyConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "This operation id was already used for a different request")
	case errors.Is(err, storage.ErrConflict):
		writeError(w, http.StatusConflict, "CONFLICT", "Settings changed; reload their current revision")
	case errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No settings document is stored")
	case errors.Is(err, storage.ErrCounterExhausted):
		writeError(w, http.StatusInsufficientStorage, "RESOURCE_EXHAUSTED", "Settings revision space is exhausted")
	default:
		writeError(w, http.StatusInternalServerError, "INTERNAL", "Settings operation failed")
	}
}

// settingsCaller authenticates the device session host-wide. The scope in the
// message may name this Host, but it never supplies identity, and it never
// narrows the requirement to a workspace: this document is not workspace-scoped.
func settingsCaller(r *http.Request, host Identity, service *auth.Service, settings *settingshost.Service, meta *pb.CommandMeta, permission string, mutating bool) (settingshost.Caller, error) {
	if scope := meta.GetScope(); scope != nil {
		if scope.HostId != "" && scope.HostId != host.HostID {
			return settingshost.Caller{}, auth.ErrPermission
		}
		if scope.ExecutionHostId != "" && scope.ExecutionHostId != host.HostID {
			return settingshost.Caller{}, auth.ErrPermission
		}
	}
	principal, err := service.Authenticate(r.Context(), auth.AccessRequest{
		HostID:         host.HostID,
		Origin:         r.Header.Get("Origin"),
		AccessToken:    credential(r, host.HostID, "access"),
		CSRFToken:      r.Header.Get("X-Armadra-CSRF"),
		RequireCSRF:    mutating,
		RequiredScopes: []auth.Scope{{Permission: permission, ExecutionHostID: host.HostID}},
	})
	if err != nil {
		return settingshost.Caller{}, err
	}
	if settings == nil {
		return settingshost.Caller{}, errSettingsUnsupported
	}
	return settingshost.Caller{PrincipalID: principal.PrincipalID, DeviceID: principal.DeviceID, DeviceEpoch: principal.DeviceEpoch, Scopes: principal.Scopes}, nil
}

func settingsRequest(w http.ResponseWriter, r *http.Request, host Identity, service *auth.Service, settings *settingshost.Service) {
	origin := r.Header.Get("Origin")
	if origin == "" || len(r.Header.Values("Origin")) != 1 || len(r.Header.Values("X-Armadra-CSRF")) > 1 {
		authFailure(w, auth.ErrPermission)
		return
	}
	switch strings.TrimPrefix(r.URL.Path, SettingsPrefix) {
	case "Get":
		input := new(pb.GetSettingsRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := settingsCaller(r, host, service, settings, input.Meta, settingshost.ScopeRead, false)
		if err != nil {
			settingsFailure(w, err)
			return
		}
		result, err := settings.Get(r.Context(), caller, input.Scope, input.DeviceId)
		if err != nil {
			settingsFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	case "Put":
		input := new(pb.PutSettingsRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		caller, err := settingsCaller(r, host, service, settings, input.Meta, settingshost.ScopeWrite, true)
		if err != nil {
			settingsFailure(w, err)
			return
		}
		result, err := settings.Put(r.Context(), caller, input)
		if err != nil {
			settingsFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, result)
	}
}
