package server

import (
	"net/http"
	"strings"
)

// The origins a packaged desktop shell's WebView presents: Tauri's own scheme
// on macOS and Linux, and the two spellings WebView2 uses on Windows. They
// are the only origins the native session transport exists for
// (docs/design/host-native-session.md §2).
var nativeOrigins = map[string]bool{
	"tauri://localhost":       true,
	"http://tauri.localhost":  true,
	"https://tauri.localhost": true,
}

// NativeOrigin reports whether a canonical origin is one a desktop shell
// presents. It is a spelling check, not an authorization: the shell still has
// to be listed with --allow-origin, and a request still has to be a native
// session request, before anything is answered to it.
func NativeOrigin(origin string) bool {
	return nativeOrigins[origin]
}

// nativeSession reports whether a request may use the native session
// transport: the Host serves plain loopback HTTP (no public HTTPS origin and
// no TLS on this connection), it has an identity service, and the request's
// exact Origin is a native origin the operator explicitly allowed. A browser
// page cannot present one of these origins, and a local process that forges
// one still needs a ticket from the same-user control channel.
func nativeSession(r *http.Request, origin string, explicit bool, options Options) bool {
	return options.Identity != nil && options.PublicOrigin == "" && r.TLS == nil && explicit && NativeOrigin(origin)
}

// nativeRequest is the per-request form used by the credential reader: by the
// time a request reaches an authenticated method on plain HTTP, the handler
// gate has already established that it is a native session request.
func nativeRequest(r *http.Request) bool {
	return r.TLS == nil && NativeOrigin(r.Header.Get("Origin"))
}

// bearerCredential returns the single bearer token a native request carries,
// or "" when the header is absent, repeated, or not a bearer scheme. Which
// secret the token has to be — access or refresh — is decided by the method,
// exactly as the cookie purpose is; a token of the wrong kind fails its hash
// domain rather than being accepted as the other.
func bearerCredential(r *http.Request) string {
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return ""
	}
	scheme, token, found := strings.Cut(values[0], " ")
	if !found || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	token = strings.TrimSpace(token)
	if token == "" || strings.ContainsAny(token, " \t,") {
		return ""
	}
	return token
}
