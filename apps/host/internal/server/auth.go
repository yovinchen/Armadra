package server

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

const AuthPrefix = "/rpc/armadra.v1.IdentityService/"

func authMethod(path string) bool {
	switch strings.TrimPrefix(path, AuthPrefix) {
	case "Pair", "Current", "Refresh", "RenewCsrf", "Logout", "ListDevices", "RevokeDevice":
		return strings.HasPrefix(path, AuthPrefix)
	}
	return false
}

// Cookie authentication is enabled only on the configured HTTPS authority.
// Loopback HTTP cannot isolate cookies from other users' local TCP ports.
func cookieName(host string, secure bool, purpose string) string {
	prefix := "armadra_"
	if secure {
		prefix = "__Host-armadra_"
	}
	return prefix + host + "_" + purpose
}
func credential(r *http.Request, host, purpose string) string {
	// The desktop shell's native transport cannot rely on cookies under a
	// custom scheme, so it presents the same secrets as a bearer token
	// (docs/design/host-native-session.md §3). The handler gate only lets a
	// plain-HTTP request this far when it is a native session request.
	if nativeRequest(r) {
		return bearerCredential(r)
	}
	name := cookieName(host, r.TLS != nil, purpose)
	value := ""
	count := 0
	for _, cookie := range r.Cookies() {
		if cookie.Name == name {
			value = cookie.Value
			count++
		}
	}
	if count != 1 {
		return ""
	}
	return value
}
func sessionCookies(w http.ResponseWriter, r *http.Request, host string, credentials auth.SessionCredentials) {
	// A native session gets its secrets in the response body instead; setting
	// cookies as well would leave a second copy the page never asked for.
	if nativeRequest(r) {
		return
	}
	for _, item := range []struct {
		purpose, value string
		expiry         int64
	}{{"access", credentials.AccessToken, credentials.AccessExpiresAtMS}, {"refresh", credentials.RefreshToken, credentials.ExpiresAtMS}} {
		http.SetCookie(w, &http.Cookie{Name: cookieName(host, r.TLS != nil, item.purpose), Value: item.value, Path: "/", Expires: time.UnixMilli(item.expiry), HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode})
	}
}
func clearSessionCookies(w http.ResponseWriter, r *http.Request, host string) {
	if nativeRequest(r) {
		return
	}
	for _, purpose := range []string{"access", "refresh"} {
		http.SetCookie(w, &http.Cookie{Name: cookieName(host, r.TLS != nil, purpose), Path: "/", MaxAge: -1, Expires: time.Unix(1, 0), HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode})
	}
}
func authFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, auth.ErrUnauthenticated):
		writeError(w, 401, "UNAUTHENTICATED", "Device session is invalid or expired")
	case errors.Is(err, auth.ErrPermission):
		writeError(w, 403, "PERMISSION_DENIED", "Device permission or CSRF check failed")
	case errors.Is(err, auth.ErrInvalid):
		writeError(w, 400, "INVALID_ARGUMENT", "Invalid identity request")
	case errors.Is(err, storage.ErrConflict):
		writeError(w, 409, "CONFLICT", "Identity changed; reload its current state")
	case errors.Is(err, storage.ErrNotFound):
		writeError(w, 404, "NOT_FOUND", "Device was not found")
	default:
		writeError(w, 500, "INTERNAL", "Identity operation failed")
	}
}
func decodeAuth(w http.ResponseWriter, r *http.Request, message proto.Message) bool {
	if r.Header.Get("Content-Encoding") != "" && r.Header.Get("Content-Encoding") != "identity" {
		writeError(w, 415, "UNSUPPORTED", "Content encoding is not supported")
		return false
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery || len(r.Header.Values("Content-Type")) != 1 {
		authFailure(w, auth.ErrInvalid)
		return false
	}
	media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != MediaType || len(params) != 0 {
		writeError(w, 415, "INVALID_ARGUMENT", "A Protobuf request is required")
		return false
	}
	bytes, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxFrameBytes))
	if err != nil {
		writeError(w, 413, "RESOURCE_EXHAUSTED", "Identity request exceeds its limit")
		return false
	}
	// Identity request messages are flat scalars. Reject groups before the Go
	// decoder's unknown-group path, which has a separate recursion allowance.
	wire := bytes
	for len(wire) > 0 {
		number, kind, n := protowire.ConsumeTag(wire)
		if n < 0 || !number.IsValid() || kind == protowire.StartGroupType || kind == protowire.EndGroupType {
			authFailure(w, auth.ErrInvalid)
			return false
		}
		wire = wire[n:]
		n = protowire.ConsumeFieldValue(number, kind, wire)
		if n < 0 {
			authFailure(w, auth.ErrInvalid)
			return false
		}
		wire = wire[n:]
	}
	if err = (proto.UnmarshalOptions{RecursionLimit: 16}).Unmarshal(bytes, message); err != nil {
		authFailure(w, auth.ErrInvalid)
		return false
	}
	return true
}
func grants(scopes []auth.Scope) []*pb.AuthorizationGrant {
	result := make([]*pb.AuthorizationGrant, 0, len(scopes))
	for _, scope := range scopes {
		result = append(result, &pb.AuthorizationGrant{Permission: scope.Permission, WorkspaceId: scope.WorkspaceID, ExecutionHostId: scope.ExecutionHostID})
	}
	return result
}
func principalResponse(principal auth.Principal, csrf string, expiry int64) *pb.AuthenticatedSession {
	return &pb.AuthenticatedSession{HostId: principal.HostID, Device: &pb.DeviceIdentity{DeviceId: principal.DeviceID, PrincipalId: principal.PrincipalID, DisplayName: principal.DeviceName, Role: string(principal.Role), CreatedAtUnixMs: principal.DeviceCreatedAtMS, Revision: principal.DeviceEpoch}, Scopes: grants(principal.Scopes), CsrfToken: csrf, ExpiresAtUnixMs: expiry}
}

// credentialResponse is the Pair / Refresh answer: the session plus, on the
// native transport only, the bearer secrets the cookies would otherwise carry.
func credentialResponse(r *http.Request, credentials auth.SessionCredentials) *pb.AuthenticatedSession {
	session := principalResponse(credentials.Principal, credentials.CSRFToken, credentials.AccessExpiresAtMS)
	if nativeRequest(r) {
		session.Native = &pb.NativeSessionCredentials{AccessToken: credentials.AccessToken, RefreshToken: credentials.RefreshToken}
	}
	return session
}

func identityRequest(w http.ResponseWriter, r *http.Request, host Identity, service *auth.Service) {
	// All operations, including recovery, require the already validated exact
	// Origin. Non-simple POST prevents forms and anonymous navigation from pairing.
	origin := r.Header.Get("Origin")
	if origin == "" || len(r.Header.Values("Origin")) != 1 || len(r.Header.Values("X-Armadra-CSRF")) > 1 {
		authFailure(w, auth.ErrPermission)
		return
	}
	actor := auth.AccessRequest{HostID: host.HostID, Origin: origin, AccessToken: credential(r, host.HostID, "access"), CSRFToken: r.Header.Get("X-Armadra-CSRF")}
	switch strings.TrimPrefix(r.URL.Path, AuthPrefix) {
	case "Pair":
		input := new(pb.PairDeviceRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		result, err := service.ConsumeBootstrap(r.Context(), auth.ConsumeRequest{Ticket: input.Ticket, HostID: input.ExpectedHostId, InstanceID: input.ExpectedInstanceId, Origin: origin})
		if err != nil {
			authFailure(w, err)
			return
		}
		sessionCookies(w, r, host.HostID, result)
		writeProto(w, 200, credentialResponse(r, result))
	case "Current":
		if !decodeAuth(w, r, new(pb.CurrentSessionRequest)) {
			return
		}
		principal, err := service.Authenticate(r.Context(), actor)
		if err != nil {
			authFailure(w, err)
			return
		}
		writeProto(w, 200, principalResponse(principal, "", principal.AccessExpiresAtMS))
	case "Refresh":
		if !decodeAuth(w, r, new(pb.RefreshSessionRequest)) {
			return
		}
		result, err := service.Refresh(r.Context(), auth.RefreshRequest{HostID: host.HostID, Origin: origin, RefreshToken: credential(r, host.HostID, "refresh"), CSRFToken: actor.CSRFToken})
		if err != nil {
			authFailure(w, err)
			return
		}
		sessionCookies(w, r, host.HostID, result)
		writeProto(w, 200, credentialResponse(r, result))
	case "RenewCsrf":
		if !decodeAuth(w, r, new(pb.RenewCsrfRequest)) {
			return
		}
		csrf, err := service.RenewCSRF(r.Context(), auth.CSRFRequest{HostID: host.HostID, Origin: origin, RefreshToken: credential(r, host.HostID, "refresh")})
		if err != nil {
			authFailure(w, err)
			return
		}
		writeProto(w, 200, &pb.RenewCsrfResponse{CsrfToken: csrf})
	case "Logout":
		if !decodeAuth(w, r, new(pb.LogoutSessionRequest)) {
			return
		}
		if err := service.LogoutRefresh(r.Context(), auth.RefreshRequest{HostID: host.HostID, Origin: origin, RefreshToken: credential(r, host.HostID, "refresh"), CSRFToken: actor.CSRFToken}); err != nil {
			authFailure(w, err)
			return
		}
		clearSessionCookies(w, r, host.HostID)
		writeProto(w, 200, &pb.SessionClosedResponse{Closed: true})
	case "ListDevices":
		input := new(pb.ListDevicesRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		limit := int(input.Limit)
		if limit == 0 {
			limit = 50
		}
		page, err := service.ListDevices(r.Context(), actor, input.AfterId, limit)
		if err != nil {
			authFailure(w, err)
			return
		}
		result := &pb.ListDevicesResponse{NextId: page.NextID, HasMore: page.HasMore}
		for _, device := range page.Devices {
			result.Devices = append(result.Devices, &pb.DeviceIdentity{DeviceId: device.ID, PrincipalId: device.PrincipalID, DisplayName: device.Name, Role: string(device.Role), CreatedAtUnixMs: device.CreatedAtMS, RevokedAtUnixMs: device.RevokedAtMS, Revision: device.Epoch})
		}
		writeProto(w, 200, result)
	case "RevokeDevice":
		input := new(pb.RevokeDeviceRequest)
		if !decodeAuth(w, r, input) {
			return
		}
		actor.RequireCSRF = true
		if err := service.RevokeDevice(r.Context(), actor, input.DeviceId, input.ExpectedRevision); err != nil {
			authFailure(w, err)
			return
		}
		writeProto(w, 200, &pb.RevokeDeviceResponse{DeviceId: input.DeviceId, Revoked: true})
	}
}

func identityPreflight(w http.ResponseWriter, r *http.Request, origin string, native bool) {
	if origin == "" || len(r.Header.Values("Access-Control-Request-Method")) != 1 || r.Header.Get("Access-Control-Request-Method") != "POST" {
		authFailure(w, auth.ErrPermission)
		return
	}
	for _, line := range r.Header.Values("Access-Control-Request-Headers") {
		for _, header := range strings.Split(line, ",") {
			switch strings.ToLower(strings.TrimSpace(header)) {
			case "content-type", "accept", "x-armadra-csrf":
			case "authorization":
				// Only the native transport sends a bearer; a browser page
				// asking to send one is refused exactly as before.
				if !native {
					authFailure(w, auth.ErrPermission)
					return
				}
			default:
				authFailure(w, auth.ErrPermission)
				return
			}
		}
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", "POST")
	if native {
		// No cookies travel on this transport, so no credentialed CORS either.
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Accept, X-Armadra-CSRF, Authorization")
	} else {
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Accept, X-Armadra-CSRF")
	}
	w.Header().Add("Vary", "Access-Control-Request-Method")
	w.Header().Add("Vary", "Access-Control-Request-Headers")
	w.WriteHeader(204)
}
