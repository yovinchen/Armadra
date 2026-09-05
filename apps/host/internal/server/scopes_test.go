package server

import (
	"net/http"
	"slices"
	"testing"

	"armadra.local/host/internal/identity"
)

func permissions(scopes []identity.Scope) []string {
	names := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		names = append(names, scope.Permission)
	}
	slices.Sort(names)
	return names
}

func TestRuntimeRoutesAreClassifiedAsReadWriteOrExecute(t *testing.T) {
	for _, expectation := range []struct {
		method, path string
		want         []string
		workspace    string
	}{
		{http.MethodGet, "/api/health", []string{"resources:read"}, ""},
		{http.MethodGet, "/api/workspaces", []string{"canvas:read"}, ""},
		{http.MethodPost, "/api/workspaces", []string{"canvas:write"}, ""},
		// Opening a directory reaches the filesystem of the machine, so it is
		// execution and not a canvas edit.
		{http.MethodPost, "/api/workspaces/open-directory", []string{"canvas:write", "terminal:write"}, ""},
		{http.MethodGet, "/api/workspaces/w-1/boards", []string{"canvas:read"}, "w-1"},
		{http.MethodPut, "/api/workspaces/w-1/boards/b-1", []string{"canvas:write"}, "w-1"},
		{http.MethodGet, "/api/workspaces/w-1/files", []string{"files:read"}, "w-1"},
		{http.MethodPost, "/api/workspaces/w-1/file", []string{"files:write"}, "w-1"},
		{http.MethodGet, "/api/workspaces/w-1/git/status", []string{"git:read"}, "w-1"},
		{http.MethodPost, "/api/workspaces/w-1/git/commit", []string{"git:write", "terminal:write"}, "w-1"},
		{http.MethodGet, "/api/terminals", []string{"terminal:read"}, ""},
		{http.MethodPost, "/api/terminals", []string{"terminal:write"}, ""},
		{http.MethodGet, "/api/terminals/s-1/ws", []string{"terminal:write"}, ""},
		{http.MethodPost, "/api/approvals/p-1/answer", []string{"terminal:write"}, ""},
		{http.MethodGet, "/api/settings", []string{"settings:read"}, ""},
		{http.MethodPut, "/api/settings", []string{"settings:write"}, ""},
		{http.MethodPost, "/api/usage/copilot/login", []string{"credential:use", "terminal:write"}, ""},
	} {
		authorization, known := authorizeRuntimePath(expectation.method, expectation.path)
		if !known {
			t.Fatalf("%s %s was not classified", expectation.method, expectation.path)
		}
		if got := permissions(authorization.scopes); !slices.Equal(got, expectation.want) {
			t.Fatalf("%s %s needs %v, got %v", expectation.method, expectation.path, expectation.want, got)
		}
		for _, scope := range authorization.scopes {
			if scope.WorkspaceID != expectation.workspace {
				t.Fatalf("%s %s narrowed to %q instead of %q", expectation.method, expectation.path, scope.WorkspaceID, expectation.workspace)
			}
		}
	}
}

func TestUnknownRuntimeRoutesAreRefusedRatherThanInheritingAPrefix(t *testing.T) {
	for _, path := range []string{
		"/api/not-a-route", "/api/", "/api/../health", "/health", "/rpc/armadra.v1.HostService/Hello",
		"/api/browser/sessions",
	} {
		if _, known := authorizeRuntimePath(http.MethodGet, path); known {
			t.Fatalf("%s was authorized by an unrelated prefix", path)
		}
	}
}

// A grant for one workspace must not reach another, and must not reach the
// routes that name no workspace at all.
func TestWorkspaceGrantsDoNotWiden(t *testing.T) {
	granted := []identity.Scope{{Permission: "canvas:read", WorkspaceID: "w-1"}}
	allowed, _ := authorizeRuntimePath(http.MethodGet, "/api/workspaces/w-1/boards")
	if !identity.Permits(granted, allowed.scopes) {
		t.Fatal("the granted workspace was refused")
	}
	for _, path := range []string{"/api/workspaces/w-2/boards", "/api/workspaces", "/api/terminals"} {
		required, _ := authorizeRuntimePath(http.MethodGet, path)
		if identity.Permits(granted, required.scopes) {
			t.Fatalf("a workspace-scoped grant reached %s", path)
		}
	}
}
