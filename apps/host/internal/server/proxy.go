package server

import (
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"armadra.local/host/internal/fshost"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/runtimelink"
)

// RuntimePrefix is the only path space the Host forwards to the execution
// service. Everything outside it is answered by the Host itself or by the
// static front end, never by a proxy that guessed.
const RuntimePrefix = "/api/"

// MaxProxyBodyBytes bounds one forwarded request. Asset and file uploads are
// the large ones; anything above this is refused with a stable code instead of
// being streamed into the Runtime unbounded.
const MaxProxyBodyBytes = 64 << 20

// hopByHop headers are connection-scoped and must not be forwarded.
var hopByHop = []string{
	"Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
	"Proxy-Connection", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

// stripped headers are the ones this Host authenticates with. The Runtime has
// no authentication of its own, so a device's cookies, CSRF token and browser
// Origin stop here: a compromised or misconfigured Runtime must never be able
// to replay a device session, and the Runtime must never see a remote origin.
var stripped = []string{
	"Cookie", "Cookie2", "Authorization", "X-Armadra-Csrf", "Origin", "Referer",
	"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "Forwarded",
}

func isWebSocketUpgrade(r *http.Request) bool {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return false
	}
	for _, value := range r.Header.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
				return true
			}
		}
	}
	return false
}

// runtimeRequest authenticates a device, checks its grants against the exact
// route it asked for, and only then forwards to the local Runtime.
func runtimeRequest(w http.ResponseWriter, r *http.Request, host Identity, service *auth.Service, link *runtimelink.Resolver, roots *fshost.Service, origin string) {
	authorization, known := authorizeRuntimePath(r.Method, r.URL.Path)
	if !known {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Unknown endpoint")
		return
	}
	websocket := isWebSocketUpgrade(r)
	// A browser cannot attach a header to a WebSocket handshake, so a stream is
	// gated on the exact Origin (already checked by the caller) plus the
	// SameSite=Strict session cookie. Every other unsafe method still carries
	// the session's CSRF token.
	requireCSRF := !websocket && r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions
	if len(r.Header.Values("X-Armadra-CSRF")) > 1 {
		authFailure(w, auth.ErrPermission)
		return
	}
	principal, err := service.Authenticate(r.Context(), auth.AccessRequest{
		HostID:         host.HostID,
		Origin:         origin,
		AccessToken:    credential(r, host.HostID, "access"),
		CSRFToken:      r.Header.Get("X-Armadra-CSRF"),
		RequiredScopes: authorization.scopes,
		RequireCSRF:    requireCSRF,
	})
	if err != nil {
		authFailure(w, err)
		return
	}
	if err = narrowToRegisteredRoot(r, roots, authorization); err != nil {
		authFailure(w, err)
		return
	}
	_ = principal
	target, err := link.Resolve()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "DISCONNECTED", "The local Runtime is not reachable")
		return
	}
	if websocket {
		proxyStream(w, r, link, target)
		return
	}
	proxyRequest(w, r, link, target)
}

// narrowToRegisteredRoot is the second half of a file request's authorization
// once the Host owns the filesystem domain (Go Host 业务所有权迁移 §2.5).
//
// A device's grants say what that device may ask for. A workspace's registered
// root says what anyone may ask for in that workspace, and until the domain
// moved it was the Runtime's own `workspaces.permissions_json` that answered
// it. From the switch onwards this Host holds that record, so the Runtime's
// copy is a stale one and a forwarded request has to be checked here — a Host
// that kept deferring to the Runtime would be forwarding requests against
// permissions it had already revoked.
//
// It only narrows. A workspace the Host has no registration for, or a domain
// still owned by the Runtime, leaves the request exactly as the grant check
// left it, because widening on a missing record is how a permission system
// starts granting things by accident.
func narrowToRegisteredRoot(r *http.Request, roots *fshost.Service, authorization runtimeAuthorization) error {
	if roots == nil || !authorization.files || authorization.workspace == "" {
		return nil
	}
	owned, err := roots.Owned(r.Context())
	if err != nil || !owned {
		// A store that cannot be read is not a reason to let the request
		// through, but it is also not this function's decision to make: the
		// error is reported as a refusal by the caller.
		if err != nil {
			return auth.ErrPermission
		}
		return nil
	}
	root, err := roots.Root(r.Context(), authorization.workspace)
	if err != nil {
		// While the Host owns the domain, a workspace with no registration is
		// a workspace whose files nobody may reach through this Host. Falling
		// back to the Runtime's row would be reading the record the switch
		// just retired.
		return auth.ErrPermission
	}
	allowed := root.Read
	switch authorization.class {
	case writeAccess:
		allowed = root.Read && root.Write
	case executeAccess:
		allowed = root.Read && root.Write && root.Execute
	}
	if !allowed {
		return auth.ErrPermission
	}
	return nil
}

// forwardHeader is the header the Runtime actually receives.
func forwardHeader(r *http.Request, target runtimelink.Target) http.Header {
	header := r.Header.Clone()
	for _, name := range hopByHop {
		header.Del(name)
	}
	for _, name := range stripped {
		header.Del(name)
	}
	// The Runtime's CORS predicate only ever sees this Host's own loopback
	// origin, which is what it already trusts.
	header.Set("Origin", target.Origin())
	return header
}

func proxyRequest(w http.ResponseWriter, r *http.Request, link *runtimelink.Resolver, target runtimelink.Target) {
	body := http.MaxBytesReader(w, r.Body, MaxProxyBodyBytes)
	defer body.Close()
	outbound, err := http.NewRequestWithContext(r.Context(), r.Method, "http://"+target.Authority()+r.URL.RequestURI(), body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Cannot forward this request")
		return
	}
	outbound.Header = forwardHeader(r, target)
	outbound.Host = target.Authority()
	outbound.ContentLength = r.ContentLength
	response, err := link.Client(target).Do(outbound)
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			writeError(w, http.StatusRequestEntityTooLarge, "RESOURCE_EXHAUSTED", "Request exceeds the forwarding budget")
			return
		}
		link.Forget()
		writeError(w, http.StatusServiceUnavailable, "DISCONNECTED", "The local Runtime did not answer")
		return
	}
	defer response.Body.Close()
	destination := w.Header()
	for name, values := range response.Header {
		if slicesContainsFold(hopByHop, name) {
			continue
		}
		// The Host owns the browser-facing CORS and caching policy for this
		// origin; the Runtime's own loopback answers must not overwrite it.
		if strings.HasPrefix(strings.ToLower(name), "access-control-") || strings.EqualFold(name, "Cache-Control") {
			continue
		}
		destination[http.CanonicalHeaderKey(name)] = append([]string(nil), values...)
	}
	w.WriteHeader(response.StatusCode)
	flusher, _ := w.(http.Flusher)
	buffer := make([]byte, 32<<10)
	for {
		n, readErr := response.Body.Read(buffer)
		if n > 0 {
			if _, writeErr := w.Write(buffer[:n]); writeErr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			return
		}
	}
}

func slicesContainsFold(names []string, value string) bool {
	for _, name := range names {
		if strings.EqualFold(name, value) {
			return true
		}
	}
	return false
}

// proxyStream carries a WebSocket. The handshake is replayed upstream verbatim
// (minus the credentials this Host consumed), and once the Runtime accepts it
// the two connections are spliced. Deadlines the metadata server set are
// cleared: a terminal stays open for hours, not for one write timeout.
func proxyStream(w http.ResponseWriter, r *http.Request, link *runtimelink.Resolver, target runtimelink.Target) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		writeError(w, http.StatusInternalServerError, "INTERNAL", "This listener cannot carry a stream")
		return
	}
	upstream, err := runtimelink.Dial(r.Context(), target)
	if err != nil {
		link.Forget()
		writeError(w, http.StatusServiceUnavailable, "DISCONNECTED", "The local Runtime is not reachable")
		return
	}
	handshake := r.Clone(r.Context())
	handshake.Header = forwardHeader(r, target)
	handshake.Header.Set("Connection", "Upgrade")
	handshake.Header.Set("Upgrade", "websocket")
	handshake.Host = target.Authority()
	handshake.URL.Scheme = "http"
	handshake.URL.Host = target.Authority()
	handshake.RequestURI = ""
	handshake.Body = http.NoBody
	handshake.ContentLength = 0
	_ = upstream.SetDeadline(time.Now().Add(10 * time.Second))
	if err = handshake.Write(upstream); err != nil {
		upstream.Close()
		writeError(w, http.StatusServiceUnavailable, "DISCONNECTED", "The local Runtime refused the stream")
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		upstream.Close()
		return
	}
	defer client.Close()
	defer upstream.Close()
	_ = client.SetDeadline(time.Time{})
	_ = upstream.SetDeadline(time.Time{})
	// Anything the browser pipelined behind the handshake goes upstream first,
	// otherwise the first terminal keystroke of a fast client is lost.
	if buffered != nil && buffered.Reader.Buffered() > 0 {
		if _, err = io.CopyN(upstream, buffered, int64(buffered.Reader.Buffered())); err != nil {
			return
		}
	}
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(upstream, client)
		closeWrite(upstream)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(client, upstream)
		closeWrite(client)
		done <- struct{}{}
	}()
	<-done
}

func closeWrite(conn net.Conn) {
	type writeCloser interface{ CloseWrite() error }
	if closer, ok := conn.(writeCloser); ok {
		_ = closer.CloseWrite()
		return
	}
	_ = conn.Close()
}
