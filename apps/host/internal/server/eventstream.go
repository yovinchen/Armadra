package server

import (
	"net/http"

	"armadra.local/host/internal/eventstream"
	auth "armadra.local/host/internal/identity"
)

// EventStreamPath is the Host's business event stream (host business migration
// §2.3). It is a WebSocket, not an /rpc method, because it is the one surface
// the Host pushes on: a client subscribes once and is told what changed instead
// of asking every few seconds whether anything did.
const EventStreamPath = "/ws/armadra.v1.EventStream"

// eventStreamRequest authenticates a device and hands the connection to the hub.
//
// A browser cannot attach a header to a WebSocket handshake, so there is no
// CSRF token to check here. What stands in for one is the same pair the Runtime
// proxy relies on for its streams: the exact browser Origin, already verified
// by the caller, and the SameSite=Strict session cookie — which a cross-site
// page cannot cause to be sent.
//
// No scope is required to open the connection. The subscription frame names the
// workspaces and domains, and each of those is checked against this session's
// own grants before a single event is read; asking for a scope up front would
// only mean checking the wrong one twice.
func eventStreamRequest(w http.ResponseWriter, r *http.Request, host Identity, service *auth.Service, hub *eventstream.Hub, origin string) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeError(w, http.StatusMethodNotAllowed, "INVALID_ARGUMENT", "GET required")
		return
	}
	if !eventstream.IsUpgrade(r) {
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "A WebSocket upgrade is required")
		return
	}
	if len(r.Header.Values("X-Armadra-CSRF")) > 1 {
		authFailure(w, auth.ErrPermission)
		return
	}
	principal, err := service.Authenticate(r.Context(), auth.AccessRequest{
		HostID:      host.HostID,
		Origin:      origin,
		AccessToken: credential(r, host.HostID, "access"),
	})
	if err != nil {
		authFailure(w, err)
		return
	}
	hub.Serve(w, r, eventstream.Caller{
		PrincipalID: principal.PrincipalID,
		DeviceID:    principal.DeviceID,
		HostID:      host.HostID,
		Scopes:      principal.Scopes,
	})
}
