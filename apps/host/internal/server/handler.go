// Package server provides the local protocol negotiation surface. It does not
// expose execution or user data before device authentication is implemented.
package server

import (
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

const (
	HelloPath     = "/rpc/armadra.v1.HostService/Hello"
	MediaType     = "application/x-protobuf"
	MaxFrameBytes = 1 << 20
	ProtocolMajor = 1
	// Minor 2 adds UpdateArtifact.component and CheckForUpdateRequest.component
	// (design docs/design/updates-and-service-install.md §1.5). A minor is
	// additive: a peer that speaks 1 keeps working and simply never asks about
	// a component other than the desktop bundle.
	ProtocolMinor = 2
)

// Identity separates a persistent data-directory ID from a process incarnation.
// Neither ID is an authentication token.
type Identity struct {
	HostID     string
	InstanceID string
}

// NewHandler accepts only loopback authorities and same-origin/CLI requests.
func NewHandler(identity Identity) http.Handler {
	handler, _ := NewHandlerWithOptions(identity, Options{})
	return handler
}

// NewHandlerWithOptions validates the explicit origin allowlist once.
func NewHandlerWithOptions(identity Identity, options Options) (http.Handler, error) {
	if options.PublicOrigin != "" {
		origin, err := ParseOrigin(options.PublicOrigin)
		if err != nil || origin != options.PublicOrigin || !strings.HasPrefix(origin, "https://") {
			return nil, errors.New("public origin must be an exact HTTPS origin")
		}
	}
	allowed, err := originSet(options)
	if err != nil {
		return nil, err
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Add("Vary", "Origin")
		origin, explicit, permitted := checkOrigin(r, allowed)
		authorityAllowed := loopbackAuthority(r.Host)
		if options.PublicOrigin != "" {
			authorityAllowed = r.TLS != nil && "https://"+r.Host == options.PublicOrigin
		}
		if !authorityAllowed || !permitted {
			writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "Local request origin is not allowed")
			return
		}
		if options.Identity != nil && (authMethod(r.URL.Path) || automationMethod(r.URL.Path) || githubMethod(r.URL.Path) || updatesMethod(r.URL.Path) || canvasMethod(r.URL.Path) || ownershipMethod(r.URL.Path) || settingsMethod(r.URL.Path)) {
			if origin != options.PublicOrigin {
				writeError(w, 403, "PERMISSION_DENIED", "Authentication requires the Host HTTPS origin")
				return
			}
			if r.TLS == nil || options.PublicOrigin == "" {
				writeError(w, 403, "PERMISSION_DENIED", "Browser authentication requires configured HTTPS")
				return
			}
			if origin == "" {
				writeError(w, 403, "PERMISSION_DENIED", "An exact browser origin is required")
				return
			}
			if r.Method == http.MethodOptions {
				identityPreflight(w, r, origin)
				return
			}
			if r.Method != http.MethodPost {
				w.Header().Set("Allow", "POST")
				writeError(w, 405, "INVALID_ARGUMENT", "POST required")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			if automationMethod(r.URL.Path) {
				automationRequest(w, r, identity, options.Identity, options.Automation)
				return
			}
			if ownershipMethod(r.URL.Path) {
				// Who may write which domain is answered even by a Host that
				// cannot move any of them: a client has to read it before it
				// decides where to save, and "unknown" is not an answer it can
				// act on.
				ownershipRequest(w, r, identity, options.Identity, options.Ownership, options.OpenHandoff)
				return
			}
			if settingsMethod(r.URL.Path) {
				// Host-wide, like the ownership record and unlike the canvas:
				// a Host with no settings service authenticates first and then
				// answers UNSUPPORTED from inside, so a device never learns
				// "your settings are empty".
				settingsRequest(w, r, identity, options.Identity, options.Settings)
				return
			}
			if canvasMethod(r.URL.Path) {
				// A Host with no canvas service authenticates first and then
				// answers UNSUPPORTED from inside; it never returns an empty
				// workspace, which a client would read as "nothing is there".
				canvasRequest(w, r, identity, options.Identity, options.Canvas)
				return
			}
			if githubMethod(r.URL.Path) {
				// A Host with no GitHub service still authenticates, then says
				// the surface is unavailable here. It never answers with data.
				if options.GitHub == nil {
					writeError(w, http.StatusNotImplemented, "UNSUPPORTED", "This Host has no GitHub credential service")
					return
				}
				githubRequest(w, r, identity, options.Identity, options.GitHub)
				return
			}
			// A nil Updates service is a Host with no configured release
			// source; it answers UNSUPPORTED in the contract's own state.
			if updatesMethod(r.URL.Path) {
				updatesRequest(w, r, identity, options.Identity, options.Updates)
				return
			}
			identityRequest(w, r, identity, options.Identity)
			return
		}
		// Everything below this line is reachable only once the Host actually
		// has browser authentication configured: an HTTPS origin, a
		// certificate, and an identity service to check devices against.
		browser := options.Identity != nil && options.PublicOrigin != "" && r.TLS != nil
		if options.External != nil && externalServiceRoute(r.URL.Path) {
			if !browser {
				writeJSONError(w, http.StatusNotImplemented, "UNSUPPORTED", "The external service switch requires configured HTTPS")
				return
			}
			device, ok := deviceOrigin(r, origin, options.PublicOrigin)
			if !ok {
				writeJSONError(w, http.StatusForbidden, "PERMISSION_DENIED", "An exact same-origin request is required")
				return
			}
			externalServiceHandler(w, r, identity, options.Identity, options.External, device)
			return
		}
		// The event stream is answered before the Runtime proxy: it is the
		// Host's own surface, and a path that looks like a stream must never
		// fall through to a forwarded request or to the static bundle.
		if r.URL.Path == EventStreamPath {
			if !browser || options.Events == nil {
				writeError(w, http.StatusNotFound, "NOT_FOUND", "Unknown endpoint")
				return
			}
			device, ok := deviceOrigin(r, origin, options.PublicOrigin)
			if !ok {
				writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "An exact same-origin request is required")
				return
			}
			eventStreamRequest(w, r, identity, options.Identity, options.Events, device)
			return
		}
		if strings.HasPrefix(r.URL.Path, RuntimePrefix) {
			if !browser || options.Runtime == nil {
				writeError(w, http.StatusNotFound, "NOT_FOUND", "Unknown endpoint")
				return
			}
			device, ok := deviceOrigin(r, origin, options.PublicOrigin)
			if !ok {
				writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "An exact same-origin request is required")
				return
			}
			runtimeRequest(w, r, identity, options.Identity, options.Runtime, device)
			return
		}
		// Defined but unimplemented surfaces answer UNSUPPORTED rather than
		// falling through to NOT_FOUND, which a client cannot tell apart from
		// an older Host that never heard of the method.
		if capability, reserved := reservedMethod(r.URL.Path); reserved {
			if r.Method == http.MethodOptions {
				preflight(w, r, origin, http.MethodPost)
				return
			}
			if explicit {
				w.Header().Set("Access-Control-Allow-Origin", origin)
			}
			reservedRequest(w, r, capability)
			return
		}
		var method string
		switch r.URL.Path {
		case "/health":
			method = http.MethodGet
		case HelloPath:
			method = http.MethodPost
		default:
			// The built front end is the last resort, never a fallback for a
			// protocol path: an unknown /rpc method must stay a protocol error
			// instead of turning into an HTML page a client cannot parse.
			if options.Web != nil && !protocolPath(r.URL.Path) {
				if explicit {
					w.Header().Set("Access-Control-Allow-Origin", origin)
				}
				options.Web.Serve(w, r)
				return
			}
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Unknown endpoint")
			return
		}
		if r.Method == http.MethodOptions {
			preflight(w, r, origin, method)
			return
		}
		if r.Method != method {
			w.Header().Set("Allow", method)
			writeError(w, http.StatusMethodNotAllowed, "INVALID_ARGUMENT", method+" required")
			return
		}
		if explicit {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		if r.URL.Path == "/health" {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = io.WriteString(w, "ok\n")
			return
		}
		authentication := options.Identity != nil && options.PublicOrigin != "" && r.TLS != nil
		hello(w, r, identity, helloSurfaces{
			authentication: authentication,
			scheduling:     authentication && options.Automation != nil,
			github:         authentication && options.GitHub != nil,
			proxying:       authentication && options.Runtime != nil,
			canvas:         authentication && options.Canvas != nil,
			events:         authentication && options.Events != nil,
			ownership:      authentication && options.Ownership != nil,
			settings:       authentication && options.Settings != nil,
		})
	}), nil
}

// protocolPath marks the spaces the Host answers itself. Nothing under them is
// ever served from the static bundle.
func protocolPath(path string) bool {
	return strings.HasPrefix(path, "/rpc/") || strings.HasPrefix(path, RuntimePrefix) ||
		strings.HasPrefix(path, "/host/") || strings.HasPrefix(path, "/ws/") || path == "/health"
}

// deviceOrigin resolves the browser origin an authenticated request is bound
// to. Browsers omit Origin on same-origin GET and HEAD, so its absence is
// accepted only for those methods and only when the fetch metadata still says
// the request came from this origin. A WebSocket handshake always carries an
// Origin, and is required to.
func deviceOrigin(r *http.Request, origin, public string) (string, bool) {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "", "same-origin", "none":
	default:
		return "", false
	}
	if origin != "" {
		if origin != public {
			return "", false
		}
		return origin, true
	}
	if isWebSocketUpgrade(r) || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return "", false
	}
	return public, true
}

// helloSurfaces is what this Host actually assembled. Each flag is advertised
// only when the surface really answers, so a client never plans against a
// capability that would then refuse it.
type helloSurfaces struct {
	authentication, scheduling, github, proxying, canvas, events, ownership, settings bool
}

func hello(w http.ResponseWriter, r *http.Request, identity Identity, surfaces helloSurfaces) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeError(w, http.StatusMethodNotAllowed, "INVALID_ARGUMENT", "POST required")
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != MediaType {
		writeError(w, http.StatusUnsupportedMediaType, "INVALID_ARGUMENT", "Protobuf content type required")
		return
	}
	if encoding := r.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		writeError(w, http.StatusUnsupportedMediaType, "UNSUPPORTED", "Compressed requests are not supported")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxFrameBytes)
	defer r.Body.Close()
	data, err := io.ReadAll(r.Body)
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			writeError(w, http.StatusRequestEntityTooLarge, "RESOURCE_EXHAUSTED", "Request exceeds frame budget")
		} else {
			writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Cannot read request")
		}
		return
	}
	request := &pb.HelloRequest{}
	if err := (proto.UnmarshalOptions{RecursionLimit: 32}).Unmarshal(data, request); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid protobuf message")
		return
	}
	if strings.TrimSpace(request.GetClientId()) == "" || len(request.GetClientId()) > 256 || request.GetProtocol() == nil {
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Client ID and protocol version required")
		return
	}
	if request.Protocol.GetMajor() != ProtocolMajor {
		writeError(w, http.StatusConflict, "UNSUPPORTED", "Protocol major version is incompatible")
		return
	}
	capabilities := []string{"protocol.hello.v1", "host.identity.v1"}
	if surfaces.authentication {
		capabilities = append(capabilities, "identity.browser-session.v1")
	}
	// Advertised only when a Worker is actually assembled: a client must never
	// read this as "plans exist" on a Host that cannot run them.
	if surfaces.scheduling {
		capabilities = append(capabilities, "automation.plans.v1")
	}
	// Advertised only when a credential service is actually assembled, so a
	// client never opens a GitHub panel this Host cannot serve at all.
	if surfaces.github {
		capabilities = append(capabilities, "github.issues.v1")
	}
	// Advertised only when a Runtime address is actually configured. A client
	// must never read this as "the execution service is up": it means requests
	// will be forwarded, and a Runtime that is down still answers DISCONNECTED.
	if surfaces.proxying {
		capabilities = append(capabilities, "runtime.proxy.v1")
	}
	// Advertised only when a canvas service is actually assembled. It says the
	// surface answers, not that this Host currently owns canvas writes: that is
	// what CanvasService/GetOwnership reports, and a client must read it before
	// it saves anything.
	if surfaces.canvas {
		capabilities = append(capabilities, "canvas.documents.v1")
	}
	// Advertised only when the stream is actually assembled. A client that does
	// not see it keeps its polling fallback rather than waiting on a socket
	// this Host will never open.
	if surfaces.events {
		capabilities = append(capabilities, "events.stream.v1")
	}
	// Advertised only when the ownership surface is assembled. It says the
	// record can be read here, not that this Host owns anything: which side
	// writes which domain is what OwnershipService/List reports, and a client
	// must read that before it decides where to save.
	if surfaces.ownership {
		capabilities = append(capabilities, "ownership.domains.v1")
	}
	// Advertised only when a settings service is actually assembled. Like the
	// canvas capability it says the surface answers, not that this Host owns
	// settings writes: which side writes the document is what
	// OwnershipService/List reports, and a client must read that before it
	// decides where to save a preference.
	if surfaces.settings {
		capabilities = append(capabilities, "settings.documents.v1")
	}
	writeProto(w, http.StatusOK, &pb.HelloResponse{
		Protocol:         &pb.ProtocolVersion{Major: ProtocolMajor, Minor: min(request.Protocol.GetMinor(), ProtocolMinor)},
		HostInstanceId:   identity.InstanceID,
		HostId:           identity.HostID,
		Capabilities:     capabilities,
		MaxFrameBytes:    MaxFrameBytes,
		CapabilityStatus: reservedCapabilityStatus(),
	})
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeProto(w, status, &pb.ErrorResponse{Code: code, Message: message})
}

func writeProto(w http.ResponseWriter, status int, message proto.Message) {
	data, err := proto.Marshal(message)
	if err != nil {
		http.Error(w, "Response encoding failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", MediaType)
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func loopbackAuthority(authority string) bool {
	host, port, err := net.SplitHostPort(authority)
	if err != nil || port == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func sameOrigin(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return err == nil && u.Scheme == scheme && u.Host == r.Host && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == ""
}
