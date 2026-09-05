package server

import (
	"errors"
	"net/http"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/updates"
)

const UpdatesPrefix = "/rpc/armadra.v1.UpdateService/"

// ScopeUpdatesRead is a host-wide read: a release check is not about one
// workspace, so a grant constrained to a workspace does not authorize it.
const ScopeUpdatesRead = "updates:read"

func updatesMethod(path string) bool {
	if !strings.HasPrefix(path, UpdatesPrefix) {
		return false
	}
	switch strings.TrimPrefix(path, UpdatesPrefix) {
	case "CheckForUpdate", "DownloadUpdate", "ApplyUpdate":
		return true
	}
	return false
}

func updatesFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, auth.ErrUnauthenticated):
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "Device session is invalid or expired")
	case errors.Is(err, auth.ErrPermission):
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "Update permission or CSRF check failed")
	case errors.Is(err, auth.ErrInvalid), errors.Is(err, updates.ErrInvalid):
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid update request")
	default:
		writeError(w, http.StatusInternalServerError, "INTERNAL", "Update operation failed")
	}
}

// updatesCaller authenticates the device session behind an update request. The
// message's own scope may name this Host, but it never supplies identity: a
// scope naming another Host is refused rather than reinterpreted as local.
func updatesCaller(r *http.Request, host Identity, service *auth.Service, meta *pb.CommandMeta, mutating bool) error {
	if scope := meta.GetScope(); scope != nil {
		if scope.HostId != "" && scope.HostId != host.HostID {
			return auth.ErrPermission
		}
		if scope.ExecutionHostId != "" && scope.ExecutionHostId != host.HostID {
			return auth.ErrPermission
		}
	}
	_, err := service.Authenticate(r.Context(), auth.AccessRequest{
		HostID:         host.HostID,
		Origin:         r.Header.Get("Origin"),
		AccessToken:    credential(r, host.HostID, "access"),
		CSRFToken:      r.Header.Get("X-Armadra-CSRF"),
		RequireCSRF:    mutating,
		RequiredScopes: []auth.Scope{{Permission: ScopeUpdatesRead}},
	})
	return err
}

// updatesRequest serves the update contract (platform design §3 S03).
//
// A Host started without a release source still authenticates first and then
// answers UNSUPPORTED in the response's own state — never an HTTP error a
// client could mistake for "this build is too old to know the method", and
// never an "up to date" nothing actually checked. `service` is nil on such a
// Host; the updates package answers on the nil receiver deliberately.
func updatesRequest(w http.ResponseWriter, r *http.Request, host Identity, identities *auth.Service, service *updates.Service) {
	origin := r.Header.Get("Origin")
	if origin == "" || len(r.Header.Values("Origin")) != 1 || len(r.Header.Values("X-Armadra-CSRF")) > 1 {
		authFailure(w, auth.ErrPermission)
		return
	}
	switch strings.TrimPrefix(r.URL.Path, UpdatesPrefix) {
	case "CheckForUpdate":
		input := new(pb.CheckForUpdateRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		if err := updatesCaller(r, host, identities, input.Meta, false); err != nil {
			updatesFailure(w, err)
			return
		}
		response, err := service.Check(r.Context(), input)
		if err != nil {
			updatesFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, response)
	case "DownloadUpdate":
		input := new(pb.DownloadUpdateRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		// Transferring bytes would change this machine, so it is treated as a
		// mutation and needs the rotating CSRF token even though it is refused.
		if err := updatesCaller(r, host, identities, input.Meta, true); err != nil {
			updatesFailure(w, err)
			return
		}
		response, err := service.Download(r.Context(), input)
		if err != nil {
			updatesFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, response)
	case "ApplyUpdate":
		input := new(pb.ApplyUpdateRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		if err := updatesCaller(r, host, identities, input.Meta, true); err != nil {
			updatesFailure(w, err)
			return
		}
		response, err := service.Apply(r.Context(), input)
		if err != nil {
			updatesFailure(w, err)
			return
		}
		writeProto(w, http.StatusOK, response)
	}
}
