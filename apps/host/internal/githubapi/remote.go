package githubapi

import (
	"net/url"
	"regexp"
	"strings"
)

// Repository is a parsed git remote: which service it lives on and which
// owner/name it names there. Parsing happens locally, before any request, so a
// remote belonging to another service is recognised without contacting one.
type Repository struct {
	Owner, Name, WebHost string
}

var namePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)
var hostPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$`)

// NormalizeAPIBase returns the exact base every request is resolved against.
// Only HTTPS is accepted: an http base would put the bearer token on the wire
// in clear text, and a base carrying credentials, a query or a fragment is not
// a base at all.
func NormalizeAPIBase(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return PublicAPIBase, nil
	}
	if len(value) > 2048 || strings.ContainsAny(value, " \t\r\n\\") {
		return "", fail(CodeInvalid, 0, "API_BASE_INVALID")
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.Opaque != "" {
		return "", fail(CodeInvalid, 0, "API_BASE_INVALID")
	}
	host := strings.ToLower(parsed.Hostname())
	if !hostPattern.MatchString(host) {
		return "", fail(CodeInvalid, 0, "API_BASE_INVALID")
	}
	path := strings.TrimSuffix(parsed.Path, "/")
	if strings.Contains(path, "//") || strings.Contains(path, "..") {
		return "", fail(CodeInvalid, 0, "API_BASE_INVALID")
	}
	authority := host
	if port := parsed.Port(); port != "" {
		authority = host + ":" + port
	}
	return "https://" + authority + path, nil
}

// APIHost is the authority a base resolves to, used to check that a remote URL
// belongs to the configured service.
func APIHost(apiBase string) string {
	parsed, err := url.Parse(apiBase)
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}

// BelongsTo reports whether a remote URL's web host is served by this API base.
// The public API is the only case where the two hosts legitimately differ; for
// every enterprise base they must match, which is what stops an enterprise
// repository from being resolved against the public service.
func BelongsTo(apiBase, webHost string) bool {
	webHost = strings.ToLower(strings.TrimSuffix(webHost, "."))
	if webHost == "" {
		return false
	}
	if apiBase == PublicAPIBase {
		return webHost == "github.com" || webHost == "www.github.com" || webHost == "ssh.github.com"
	}
	return webHost == APIHost(apiBase)
}

// WebHostFor is the web host an API base serves, used when a resolved
// repository has to report where it actually lives.
func WebHostFor(apiBase string) string {
	if apiBase == PublicAPIBase {
		return "github.com"
	}
	return APIHost(apiBase)
}

// ParseRemote reads a git remote URL. It accepts https, ssh, git and the
// scp-like `git@host:owner/name` form, and it never performs a lookup: the host
// it returns is exactly what the URL named.
func ParseRemote(value string) (Repository, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 2048 || strings.ContainsAny(value, " \t\r\n") {
		return Repository{}, fail(CodeInvalid, 0, "REMOTE_INVALID")
	}
	var host, path string
	switch {
	case strings.Contains(value, "://"):
		parsed, err := url.Parse(value)
		if err != nil {
			return Repository{}, fail(CodeInvalid, 0, "REMOTE_INVALID")
		}
		switch parsed.Scheme {
		case "https", "http", "ssh", "git":
		default:
			return Repository{}, fail(CodeInvalid, 0, "REMOTE_SCHEME_UNSUPPORTED")
		}
		host = parsed.Hostname()
		path = parsed.Path
	default:
		// scp-like: [user@]host:path. A colon inside the path is not a
		// separator, so only the first one splits.
		at := strings.LastIndex(value, "@")
		rest := value
		if at >= 0 {
			rest = value[at+1:]
		}
		colon := strings.Index(rest, ":")
		if colon <= 0 {
			return Repository{}, fail(CodeInvalid, 0, "REMOTE_INVALID")
		}
		host = rest[:colon]
		path = rest[colon+1:]
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if !hostPattern.MatchString(host) {
		return Repository{}, fail(CodeInvalid, 0, "REMOTE_INVALID")
	}
	segments := []string{}
	for _, segment := range strings.Split(strings.Trim(path, "/"), "/") {
		if segment != "" {
			segments = append(segments, segment)
		}
	}
	if len(segments) < 2 {
		return Repository{}, fail(CodeInvalid, 0, "REMOTE_INVALID")
	}
	// Enterprise remotes are frequently served under /<owner>/<name> directly,
	// but some deployments prefix a path. The repository is always the last two
	// segments, and ".git" is a suffix of the name rather than part of it.
	owner := segments[len(segments)-2]
	name := strings.TrimSuffix(segments[len(segments)-1], ".git")
	if !namePattern.MatchString(owner) || !namePattern.MatchString(name) {
		return Repository{}, fail(CodeInvalid, 0, "REMOTE_INVALID")
	}
	return Repository{Owner: owner, Name: name, WebHost: host}, nil
}

// ValidName reports whether a value can be used as an owner or repository name
// in a request path without escaping surprises.
func ValidName(value string) bool { return namePattern.MatchString(value) }
