package server

import (
	"armadra.local/host/internal/automationhost"
	"armadra.local/host/internal/externalservice"
	"armadra.local/host/internal/githubhost"
	"armadra.local/host/internal/identity"
	"armadra.local/host/internal/runtimelink"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

// Options permits explicitly named browser origins to read local metadata.
// This is not device authentication and never enables remote listening.
type Options struct {
	AllowedOrigins []string
	Identity       *identity.Service
	PublicOrigin   string
	// Automation is nil when this Host was started without an execution
	// Worker. Its methods then answer UNSUPPORTED instead of empty data.
	Automation *automationhost.Service
	// GitHub is nil when this Host has no credential service assembled. Its
	// methods then answer UNSUPPORTED, never an empty Issue list.
	GitHub *githubhost.Service
	// Web is the built front end this Host serves, or nil. It is the one
	// surface an unpaired device may reach: the shell is also the pairing page.
	Web *WebRoot
	// Runtime forwards an authenticated device's /api requests and streams to
	// the local execution service. Nil means this Host proxies nothing, and
	// every /api path answers NOT_FOUND rather than an empty success.
	Runtime *runtimelink.Resolver
	// External is the "serve to my other devices" switch. Nil hides its route.
	External *externalservice.Manager
}

// ParseOrigin validates a serialized origin and returns its canonical spelling.
// Paths (including /), credentials, opaque origins and wildcards are rejected.
func ParseOrigin(value string) (string, error) {
	invalid := func() (string, error) {
		return "", errors.New("invalid allowed origin: expected an exact serialized origin without credentials or path")
	}
	if value == "" || value == "null" || strings.ContainsAny(value, "*?#\\") {
		return invalid()
	}
	for _, r := range value {
		if r <= 0x20 || r >= 0x7f {
			return invalid()
		}
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Opaque != "" || parsed.User != nil || parsed.Host == "" || parsed.Path != "" || parsed.RawPath != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return invalid()
	}
	scheme := strings.ToLower(parsed.Scheme)
	host := strings.ToLower(parsed.Hostname())
	port := parsed.Port()
	if host == "" || strings.HasSuffix(parsed.Host, ":") {
		return invalid()
	}
	if scheme == "tauri" {
		if host == "localhost" && port == "" && !strings.Contains(parsed.Host, "[") {
			return "tauri://localhost", nil
		}
		return invalid()
	}
	if scheme != "http" && scheme != "https" {
		return invalid()
	}
	ip, ipErr := netip.ParseAddr(host)
	if strings.HasPrefix(parsed.Host, "[") && (ipErr != nil || !ip.Is6()) {
		return invalid()
	}
	if ipErr == nil {
		if ip.Zone() != "" {
			return invalid()
		}
		host = ip.String()
	} else {
		if strings.ContainsAny(host, ":%[]") || len(host) > 253 {
			return invalid()
		}
		for _, label := range strings.Split(host, ".") {
			if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return invalid()
			}
			for _, c := range label {
				if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
					return invalid()
				}
			}
		}
	}
	tauriHTTP := scheme == "http" && host == "tauri.localhost" && (port == "" || port == "80")
	if scheme == "http" && host != "localhost" && (ipErr != nil || !ip.IsLoopback()) && !tauriHTTP {
		return "", errors.New("http allowed origins must use a loopback host or the exact Tauri origin")
	}
	if port != "" {
		for _, c := range port {
			if c < '0' || c > '9' {
				return invalid()
			}
		}
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return invalid()
		}
		port = strconv.Itoa(number)
		if scheme == "http" && port == "80" || scheme == "https" && port == "443" {
			port = ""
		}
	}
	if port != "" {
		host = net.JoinHostPort(host, port)
	} else if ipErr == nil && ip.Is6() {
		host = "[" + host + "]"
	}
	return scheme + "://" + host, nil
}

func originSet(options Options) (map[string]bool, error) {
	origins := make(map[string]bool, len(options.AllowedOrigins))
	for _, value := range options.AllowedOrigins {
		normalized, err := ParseOrigin(value)
		if err != nil {
			return nil, err
		}
		origins[normalized] = true
	}
	return origins, nil
}

func checkOrigin(r *http.Request, allowed map[string]bool) (origin string, explicit bool, ok bool) {
	values := r.Header.Values("Origin")
	if len(values) > 1 {
		return "", false, false
	}
	origin = r.Header.Get("Origin")
	if origin != "" {
		normalized, err := ParseOrigin(origin)
		if err != nil || normalized != origin {
			return "", false, false
		}
		explicit = allowed[origin]
	}
	if explicit {
		return origin, true, true
	}
	return origin, false, sameOrigin(r)
}

func preflight(w http.ResponseWriter, r *http.Request, origin, method string) {
	w.Header().Add("Vary", "Access-Control-Request-Method")
	w.Header().Add("Vary", "Access-Control-Request-Headers")
	if origin == "" || len(r.Header.Values("Access-Control-Request-Method")) != 1 || r.Header.Get("Access-Control-Request-Method") != method {
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "Preflight method is not allowed")
		return
	}
	headers := []string{}
	seen := map[string]bool{}
	for _, line := range r.Header.Values("Access-Control-Request-Headers") {
		for _, part := range strings.Split(line, ",") {
			header := strings.ToLower(strings.TrimSpace(part))
			if header != "content-type" && header != "accept" {
				writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "Preflight header is not allowed")
				return
			}
			if !seen[header] {
				headers = append(headers, header)
				seen[header] = true
			}
		}
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", method)
	if len(headers) > 0 {
		w.Header().Set("Access-Control-Allow-Headers", strings.Join(headers, ", "))
	}
	w.WriteHeader(http.StatusNoContent)
}
