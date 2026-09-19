package identity

import (
	"errors"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

// CanonicalOrigin validates a complete origin without credentials, paths or wildcards.
// Services require this canonical spelling verbatim for exact audience binding.
func CanonicalOrigin(value string) (string, error) {
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
	if scheme == "http" && host != "localhost" && (ipErr != nil || !ip.IsLoopback()) {
		return "", errors.New("http allowed origins must use a loopback host")
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

func validOrigin(value string) bool {
	normalized, err := CanonicalOrigin(value)
	return err == nil && normalized == value
}
