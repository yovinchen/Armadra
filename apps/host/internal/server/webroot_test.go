package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func fixtureWebRoot(t *testing.T) (*WebRoot, string) {
	t.Helper()
	directory := t.TempDir()
	if err := os.MkdirAll(filepath.Join(directory, "assets"), 0755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"index.html":                 "<!doctype html><title>shell</title>",
		"assets/index-abc12345.js":   "export const a = 1;\n",
		"assets/index-abc12345.css":  ":root{color:red}\n",
		"favicon.ico":                "icon",
		"assets/font-abc12345.woff2": "font",
	} {
		if err := os.WriteFile(filepath.Join(directory, filepath.FromSlash(name)), []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	web, err := OpenWebRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { web.Close() })
	return web, directory
}

func serveStatic(t *testing.T, web *WebRoot, method, path string) *http.Response {
	t.Helper()
	recorder := httptest.NewRecorder()
	web.Serve(recorder, httptest.NewRequest(method, path, nil))
	return recorder.Result()
}

func TestWebRootRequiresAnApplicationShell(t *testing.T) {
	if _, err := OpenWebRoot(t.TempDir()); err == nil {
		t.Fatal("a directory without index.html was accepted")
	}
	if _, err := OpenWebRoot(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("a missing directory was accepted")
	}
	if _, err := OpenWebRoot(""); err == nil {
		t.Fatal("an empty directory was accepted")
	}
}

func TestWebRootServesTheShellAndItsAssets(t *testing.T) {
	web, _ := fixtureWebRoot(t)
	for _, expectation := range []struct{ path, kind, contains string }{
		{"/", "text/html; charset=utf-8", "shell"},
		{"/workspaces/abc/deep/link", "text/html; charset=utf-8", "shell"},
		{"/assets/index-abc12345.js", "text/javascript; charset=utf-8", "export"},
		{"/assets/index-abc12345.css", "text/css; charset=utf-8", "color"},
		{"/assets/font-abc12345.woff2", "font/woff2", "font"},
	} {
		response := serveStatic(t, web, http.MethodGet, expectation.path)
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 200 || response.Header.Get("Content-Type") != expectation.kind || !strings.Contains(string(body), expectation.contains) {
			t.Fatalf("%s answered %d %q %q", expectation.path, response.StatusCode, response.Header.Get("Content-Type"), body)
		}
		if !strings.Contains(response.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
			t.Fatalf("%s was served without a policy", expectation.path)
		}
	}
	// Hashed assets may be cached; the shell itself never is, so a redeployed
	// front end is picked up on the next load.
	if cache := serveStatic(t, web, http.MethodGet, "/assets/index-abc12345.js").Header.Get("Cache-Control"); !strings.Contains(cache, "immutable") {
		t.Fatalf("a hashed asset was not cacheable: %q", cache)
	}
	if cache := serveStatic(t, web, http.MethodGet, "/").Header.Get("Cache-Control"); strings.Contains(cache, "immutable") {
		t.Fatalf("the shell was made immutable: %q", cache)
	}
}

func TestWebRootRefusesTraversalAndMissingAssets(t *testing.T) {
	web, directory := fixtureWebRoot(t)
	secret := filepath.Join(filepath.Dir(directory), "secret.txt")
	if err := os.WriteFile(secret, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/../secret.txt", "/assets/../../secret.txt", "/./../secret.txt"} {
		response := serveStatic(t, web, http.MethodGet, path)
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if strings.Contains(string(body), "private") {
			t.Fatalf("%s escaped the web root", path)
		}
	}
	// A missing hashed asset must never be answered with HTML: a stale client
	// would then try to execute the application shell as JavaScript.
	response := serveStatic(t, web, http.MethodGet, "/assets/gone-00000000.js")
	response.Body.Close()
	if response.StatusCode != 404 {
		t.Fatalf("a missing asset answered %d", response.StatusCode)
	}
	response = serveStatic(t, web, http.MethodPost, "/")
	response.Body.Close()
	if response.StatusCode != 405 {
		t.Fatalf("a POST to the shell answered %d", response.StatusCode)
	}
}

func TestWebRootDoesNotFollowSymlinksOutOfTheBundle(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs a privilege this test does not require")
	}
	web, directory := fixtureWebRoot(t)
	secret := filepath.Join(filepath.Dir(directory), "escape.txt")
	if err := os.WriteFile(secret, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(directory, "assets", "escape-00000000.js")); err != nil {
		t.Fatal(err)
	}
	response := serveStatic(t, web, http.MethodGet, "/assets/escape-00000000.js")
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if strings.Contains(string(body), "private") {
		t.Fatal("a symlink inside the bundle escaped the web root")
	}
}
