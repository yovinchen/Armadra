package server

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"

	"armadra.local/host/internal/externalservice"
	auth "armadra.local/host/internal/identity"
)

// ExternalServicePath is the Host's own administration route for the
// "serve to my other devices" switch. It is not part of the cross-process
// business contract — no workspace, session or file data passes through it —
// so it is a small JSON document rather than a Protobuf service, in the same
// way /health is plain text. Everything a client actually does with a
// workspace still goes through the authenticated Runtime proxy.
const ExternalServicePath = "/host/external-service"

type externalServiceDocument struct {
	Supported    bool     `json:"supported"`
	Enabled      bool     `json:"enabled"`
	Address      string   `json:"address"`
	Port         int      `json:"port"`
	AllowLAN     bool     `json:"allowLan"`
	PublicOrigin string   `json:"publicOrigin"`
	BoundAddress string   `json:"boundAddress"`
	AccessURL    string   `json:"accessUrl"`
	Interfaces   []string `json:"interfaces"`
}

type externalServiceRequest struct {
	Enabled  *bool   `json:"enabled"`
	Address  *string `json:"address"`
	Port     *int    `json:"port"`
	AllowLAN *bool   `json:"allowLan"`
}

func externalServiceRoute(path string) bool { return path == ExternalServicePath }

func externalDocument(status externalservice.Status) externalServiceDocument {
	document := externalServiceDocument{
		Supported:    status.Supported,
		Enabled:      status.Enabled,
		Address:      status.Address,
		Port:         status.Port,
		AllowLAN:     status.AllowLAN,
		PublicOrigin: status.PublicOrigin,
		BoundAddress: status.BoundAddress,
		Interfaces:   status.Interfaces,
	}
	if document.Interfaces == nil {
		document.Interfaces = []string{}
	}
	// The address a device types is always the certificate-bound origin. The
	// interface address only decides which network can reach it, so a URL is
	// offered only while something is actually being served there.
	if status.Enabled && status.BoundAddress != "" && status.PublicOrigin != "" {
		host, _, err := net.SplitHostPort(status.BoundAddress)
		if err == nil {
			document.AccessURL = status.PublicOrigin
			if ip := net.ParseIP(host); ip != nil && !ip.IsLoopback() {
				document.AccessURL = "https://" + net.JoinHostPort(host, strconv.Itoa(status.Port))
			}
		}
	}
	return document
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		http.Error(w, "Response encoding failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeJSONError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"code": code, "message": message})
}

// externalServiceRequestHandler reads or changes the switch. Reading needs
// settings:read, changing needs settings:write and the session's CSRF token —
// the same rules every other authenticated surface on this Host uses.
func externalServiceHandler(w http.ResponseWriter, r *http.Request, host Identity, service *auth.Service, manager *externalservice.Manager, origin string) {
	if r.Method != http.MethodGet && r.Method != http.MethodPut {
		w.Header().Set("Allow", "GET, PUT")
		writeJSONError(w, http.StatusMethodNotAllowed, "INVALID_ARGUMENT", "GET or PUT required")
		return
	}
	permission := "settings:read"
	if r.Method == http.MethodPut {
		permission = "settings:write"
	}
	if len(r.Header.Values("X-Armadra-CSRF")) > 1 {
		writeJSONError(w, http.StatusForbidden, "PERMISSION_DENIED", "Device permission or CSRF check failed")
		return
	}
	if _, err := service.Authenticate(r.Context(), auth.AccessRequest{
		HostID:         host.HostID,
		Origin:         origin,
		AccessToken:    credential(r, host.HostID, "access"),
		CSRFToken:      r.Header.Get("X-Armadra-CSRF"),
		RequiredScopes: []auth.Scope{{Permission: permission}},
		RequireCSRF:    r.Method == http.MethodPut,
	}); err != nil {
		externalFailure(w, err)
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, externalDocument(manager.Status()))
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8<<10))
	if err != nil {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "RESOURCE_EXHAUSTED", "Request exceeds its limit")
		return
	}
	var input externalServiceRequest
	if json.Unmarshal(body, &input) != nil {
		writeJSONError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid request document")
		return
	}
	status := manager.Status()
	next := externalservice.Config{Enabled: status.Enabled, Address: status.Address, Port: status.Port, AllowLAN: status.AllowLAN}
	if input.Enabled != nil {
		next.Enabled = *input.Enabled
	}
	if input.Address != nil {
		next.Address = *input.Address
	}
	if input.Port != nil {
		next.Port = *input.Port
	}
	if input.AllowLAN != nil {
		next.AllowLAN = *input.AllowLAN
	}
	applied, err := manager.Apply(r.Context(), next)
	if err != nil {
		code, message := http.StatusBadRequest, err.Error()
		if errors.Is(err, externalservice.ErrUnsupported) {
			code = http.StatusNotImplemented
			writeJSONError(w, code, "UNSUPPORTED", message)
			return
		}
		writeJSONError(w, code, "INVALID_ARGUMENT", message)
		return
	}
	writeJSON(w, http.StatusOK, externalDocument(applied))
}

func externalFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, auth.ErrUnauthenticated):
		writeJSONError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "Device session is invalid or expired")
	case errors.Is(err, auth.ErrPermission):
		writeJSONError(w, http.StatusForbidden, "PERMISSION_DENIED", "Device permission or CSRF check failed")
	default:
		writeJSONError(w, http.StatusForbidden, "PERMISSION_DENIED", "Device permission or CSRF check failed")
	}
}
