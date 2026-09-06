package server

import (
	"net/http"
	"strings"

	"armadra.local/host/internal/identity"
)

// Runtime requests are authorized against the device's own grants before a
// single byte reaches the execution service (host protocol design §6). Two
// dimensions are checked together:
//
//   - the workspace the path names, so a device granted one workspace cannot
//     read another one's files, and
//   - the class of the request: read, write, or execute.
//
// "execute" is the class that starts or drives a program on the machine — a
// terminal, a paste, an approval answer, a Git command, a hook installation. It
// requires the area's write grant *and* terminal:write, which is the only
// permission that means "run things on this host". A device granted
// files:write can therefore edit a file but cannot make the Host run anything.
type accessClass int

const (
	readAccess accessClass = iota
	writeAccess
	executeAccess
)

// runtimeArea groups the Runtime's routes by the grant that owns them.
type runtimeArea struct{ read, write string }

var (
	canvasArea    = runtimeArea{"canvas:read", "canvas:write"}
	terminalArea  = runtimeArea{"terminal:read", "terminal:write"}
	filesArea     = runtimeArea{"files:read", "files:write"}
	gitArea       = runtimeArea{"git:read", "git:write"}
	resourcesArea = runtimeArea{"resources:read", "settings:write"}
	// A controlled browser opens web pages on the machine the Host runs on
	// and lets whoever drives it type into them. That is the same class of
	// authority as a terminal, so reading a session or watching its picture
	// needs terminal:read, and anything that drives the page — navigating,
	// input, a lease takeover, installing the managed build — is execution
	// (browser completion design §2.9).
	browserArea    = runtimeArea{"terminal:read", "terminal:write"}
	settingsArea   = runtimeArea{"settings:read", "settings:write"}
	credentialArea = runtimeArea{"resources:read", "credential:use"}
)

// runtimeAuthorization is what a proxied request must satisfy.
type runtimeAuthorization struct {
	scopes []identity.Scope
	// websocket requests cannot carry a CSRF header, so they are gated on the
	// exact Origin and the SameSite=Strict session cookie instead.
	class accessClass
	// workspace and files are what the second narrowing needs: once the Host
	// owns the filesystem domain, a forwarded file request is also checked
	// against that workspace's registered root (proxy.go). They are recorded
	// here rather than re-derived, so the two checks can never disagree about
	// which route was classified how.
	workspace string
	files     bool
}

// authorizeRuntimePath maps one Runtime route onto the grants it needs. An
// unknown path is refused: a route this Host has never heard of must not
// inherit whatever authority the closest prefix happened to have.
func authorizeRuntimePath(method, path string) (runtimeAuthorization, bool) {
	rest, ok := strings.CutPrefix(path, RuntimePrefix)
	if !ok || strings.Contains(path, "..") {
		return runtimeAuthorization{}, false
	}
	segments := strings.Split(strings.Trim(rest, "/"), "/")
	if len(segments) == 0 || segments[0] == "" {
		return runtimeAuthorization{}, false
	}
	workspace := ""
	area := canvasArea
	class := classOf(method)
	switch segments[0] {
	case "health":
		return runtimeAuthorization{scopes: []identity.Scope{{Permission: resourcesArea.read}}, class: readAccess}, method == http.MethodGet
	case "workspaces":
		if len(segments) >= 3 {
			workspace = segments[1]
			area, class = workspaceArea(segments[2:], class)
		} else {
			// The workspace list and creation are canvas-level and are never
			// narrowed to a workspace the caller has not named yet.
			area, class = canvasArea, canvasWorkspaceClass(segments, class)
		}
	case "terminals":
		area = terminalArea
		if class != readAccess {
			class = executeAccess
		}
		if len(segments) >= 3 && segments[2] == "ws" {
			class = executeAccess
		}
	case "agents", "agent-status", "conversations":
		area = canvasArea
		if len(segments) >= 3 && (segments[2] == "hooks" || segments[2] == "suggest-title") {
			class = executeAccess
		}
	case "browser":
		// `/api/browser/managed` is the machine's pinned browser build, not a
		// workspace's: installing or removing it runs an installer on this
		// host, and reading its state is read. It is the only route in this
		// space — anything else under it is refused rather than let in on the
		// strength of the prefix.
		if len(segments) != 2 || segments[1] != "managed" {
			return runtimeAuthorization{}, false
		}
		area = browserArea
		if class != readAccess {
			class = executeAccess
		}
	case "approvals", "control":
		// Answering an approval or confirming a control request drives a CLI
		// that is already running. That is execution, not a canvas edit.
		area, class = terminalArea, executeAccess
	case "git":
		// /api/git/clone and its job polling are repository execution.
		area = gitArea
		if class != readAccess {
			class = executeAccess
		}
	case "usage":
		area = credentialArea
		if len(segments) >= 2 && segments[1] == "copilot" && class != readAccess {
			class = executeAccess
		} else if class != readAccess {
			class = readAccess
		}
	case "power":
		area = resourcesArea
	case "settings":
		area = settingsArea
	case "ssh":
		area, class = settingsArea, executeAccess
	case "data":
		area = settingsArea
		if class != readAccess {
			class = executeAccess
		}
	default:
		return runtimeAuthorization{}, false
	}
	scopes := []identity.Scope{{Permission: area.read, WorkspaceID: workspace}}
	if class != readAccess {
		scopes = []identity.Scope{{Permission: area.write, WorkspaceID: workspace}}
	}
	if class == executeAccess && scopes[0].Permission != terminalArea.write {
		scopes = append(scopes, identity.Scope{Permission: terminalArea.write, WorkspaceID: workspace})
	}
	return runtimeAuthorization{scopes: scopes, class: class, workspace: workspace, files: area == filesArea}, true
}

// workspaceArea resolves the part of a /api/workspaces/{id}/... route after the
// workspace id.
func workspaceArea(segments []string, class accessClass) (runtimeArea, accessClass) {
	switch segments[0] {
	case "git":
		if class != readAccess {
			class = executeAccess
		}
		return gitArea, class
	case "files", "file", "file-download", "file-entries", "file-index", "file-info",
		"file-search", "file-version", "file-watch", "imports", "language-service":
		return filesArea, class
	case "resources":
		if class != readAccess {
			class = executeAccess
		}
		return resourcesArea, class
	case "browser":
		return browserArea, browserClass(segments, class)
	case "sessions", "handoffs", "deliveries", "context-links", "nodes":
		if len(segments) >= 3 && (segments[2] == "accept" || segments[2] == "cancel") {
			class = executeAccess
		}
		return canvasArea, class
	case "open":
		return canvasArea, executeAccess
	default:
		// boards, assets, exports, events and anything else the canvas owns.
		return canvasArea, class
	}
}

// browserClass splits a /api/workspaces/{id}/browser/... route three ways.
//
// Reading a session, its page text, its downloads or its picture is read —
// including the frame stream, which is a WebSocket the Host proxies without
// looking inside. Holding a subscription is a write: it makes the machine
// encode frames. Everything that drives the page is execution, because a
// browser typing into a page is a program running on this host.
func browserClass(segments []string, class accessClass) accessClass {
	if class == readAccess {
		return readAccess
	}
	if len(segments) >= 4 && segments[3] == "subscription" {
		return writeAccess
	}
	return executeAccess
}

// canvasWorkspaceClass separates opening a directory on the machine from
// listing or creating workspace records.
func canvasWorkspaceClass(segments []string, class accessClass) accessClass {
	if len(segments) >= 2 && (segments[1] == "open-directory" || segments[1] == "import") {
		return executeAccess
	}
	return class
}

func classOf(method string) accessClass {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return readAccess
	default:
		return writeAccess
	}
}
