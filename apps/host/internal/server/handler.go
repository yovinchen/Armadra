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
	ProtocolMinor = 1
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
	allowed, err := originSet(options)
	if err != nil {
		return nil, err
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Add("Vary", "Origin")
		origin, explicit, permitted := checkOrigin(r, allowed)
		if !loopbackAuthority(r.Host) || !permitted {
			writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "Local request origin is not allowed")
			return
		}
		var method string
		switch r.URL.Path {
		case "/health":
			method = http.MethodGet
		case HelloPath:
			method = http.MethodPost
		default:
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
		hello(w, r, identity)
	}), nil
}

func hello(w http.ResponseWriter, r *http.Request, identity Identity) {
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
	writeProto(w, http.StatusOK, &pb.HelloResponse{
		Protocol:       &pb.ProtocolVersion{Major: ProtocolMajor, Minor: min(request.Protocol.GetMinor(), ProtocolMinor)},
		HostInstanceId: identity.InstanceID,
		HostId:         identity.HostID,
		Capabilities:   []string{"protocol.hello.v1", "host.identity.v1"},
		MaxFrameBytes:  MaxFrameBytes,
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
	return err == nil && u.Scheme == "http" && u.Host == r.Host && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == ""
}
