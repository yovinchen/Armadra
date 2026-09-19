package server

import (
	"net/http"
	"net/netip"
	"net/url"
	"strings"
)

// loopbackHTTPOrigin reports whether a canonical origin is plain HTTP on a
// loopback host. The desktop shell serves its own bundle from a kernel
// assigned port, so the origin cannot be a fixed constant; what makes it a
// shell origin is that nothing off this machine can be behind it
// (docs/design/electron-migration.md §2.1).
func loopbackHTTPOrigin(origin string) bool {
	canonical, err := ParseOrigin(origin)
	if err != nil || canonical != origin {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "http" {
		return false
	}
	host := parsed.Hostname()
	if host == "localhost" {
		return true
	}
	address, err := netip.ParseAddr(host)
	return err == nil && address.IsLoopback()
}

// NativeOrigin reports whether a canonical origin is one a desktop shell
// presents: the loopback HTTP origin its static server binds. It is a
// spelling check, not an authorization: the shell still has to be listed with
// --allow-origin, and a request still has to be a native session request,
// before anything is answered to it. A browser page can hold a loopback HTTP
// origin, but it still cannot mint the ticket a session starts from — only
// the same-user control channel does that.
func NativeOrigin(origin string) bool {
	return loopbackHTTPOrigin(origin)
}

// nativeSession reports whether a request may use the native session
// transport: the Host serves plain loopback HTTP (no public HTTPS origin and
// no TLS on this connection), it has an identity service, and the request's
// exact Origin is a native origin the operator explicitly allowed. Reaching
// this gate is not a session: every credential the transport carries comes
// from a ticket only the same-user control channel mints, so a browser page
// that does hold the shell's loopback origin, and a local process that forges
// any of them, are both left with nothing to present.
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
