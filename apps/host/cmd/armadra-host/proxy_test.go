package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/daemon"
	"armadra.local/host/internal/endpoints"
	"armadra.local/host/internal/server"
	"google.golang.org/protobuf/proto"
)

// The end-to-end proxy test runs the real Rust Runtime, not a stub: the point
// of H02 is that a phone reaches the same execution service a desktop does, and
// a hand-written fake would agree with whatever the Host happened to send.
//
// Everything here is loopback. The external service is switched on at
// 127.0.0.1, which is exactly the path a LAN address takes minus the interface.
func runtimeBinary(t *testing.T) string {
	t.Helper()
	if override := os.Getenv("ARMADRA_RUNTIME_BINARY"); override != "" {
		return override
	}
	name := "armadra-runtime"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	directory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for range 6 {
		for _, profile := range []string{"debug", "release"} {
			candidate := filepath.Join(directory, "target", profile, name)
			if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
				return candidate
			}
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}
		directory = parent
	}
	t.Skip("no built Runtime binary; run `cargo build -p armadra-runtime` or set ARMADRA_RUNTIME_BINARY")
	return ""
}

type proxyFixture struct {
	origin    string
	address   string
	client    *http.Client
	tls       *tls.Config
	dataDir   string
	runtimeAt string
	workspace string
	jar       *cookiejar.Jar
	csrf      string
}

func freeLoopbackPort(t *testing.T) string {
	t.Helper()
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := probe.Addr().String()
	probe.Close()
	return address
}

// startRuntime runs the real Runtime on a private Unix socket in its own data
// directory, and waits until it has published that address.
func startRuntime(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the Runtime publishes a named pipe on Windows; this fixture drives the socket transport")
	}
	binary := runtimeBinary(t)
	// A Unix socket path is bounded by SUN_LEN, which the Go test temporary
	// directory name alone can exhaust. This one is deliberately short.
	dataDir, err := os.MkdirTemp("", "armadra-rt")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dataDir) })
	socket := filepath.Join(dataDir, "runtime.sock")
	ctx, cancel := context.WithCancel(context.Background())
	child := exec.CommandContext(ctx, binary, "--listen", "unix:"+socket)
	child.Env = append(os.Environ(),
		"ARMADRA_DATA_DIR="+dataDir,
		"ARMADRA_DATABASE_URL=sqlite://"+filepath.Join(dataDir, "canvas.db")+"?mode=rwc",
		"RUST_LOG=warn",
	)
	logs := &syncBuffer{}
	child.Stdout, child.Stderr = logs, logs
	if err = child.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cancel()
		_ = child.Wait()
		if t.Failed() {
			t.Log("runtime output:\n" + logs.String())
		}
	})
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		record := endpoints.Read(endpoints.Path(dataDir)).Runtime
		if record != nil && record.Socket != "" {
			conn, err := net.Dial("unix", record.Socket)
			if err == nil {
				conn.Close()
				return dataDir
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("the Runtime never published a reachable socket\n%s", logs.String())
	return ""
}

// startProxyHost brings up a Host with no TCP listener of its own, then turns
// the external service on. Nothing is reachable until that switch is applied.
func startProxyHost(t *testing.T, runtimeDir, webDir string) *proxyFixture {
	t.Helper()
	fixture := httptest.NewTLSServer(http.NotFoundHandler())
	certificate := fixture.TLS.Certificates[0]
	leaf := fixture.Certificate()
	fixture.Close()
	key, err := x509.MarshalPKCS8PrivateKey(certificate.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	certPath, keyPath := filepath.Join(directory, "cert.pem"), filepath.Join(directory, "key.pem")
	if err = os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Certificate[0]}), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), 0600); err != nil {
		t.Fatal(err)
	}
	address := freeLoopbackPort(t)
	origin := "https://" + address
	arguments := []string{
		"serve", "--data-dir", filepath.Join(directory, "host"),
		"--listen", noListener,
		"--endpoints-dir", runtimeDir,
		"--tls-cert", certPath, "--tls-key", keyPath, "--public-origin", origin,
		"--external-service", "on", "--external-address", "127.0.0.1",
	}
	if webDir != "" {
		arguments = append(arguments, "--serve-web", webDir)
	}
	c, err := parseConfig(arguments)
	if err != nil {
		t.Fatal(err)
	}
	startPairHost(t, c)
	roots := x509.NewCertPool()
	roots.AddCert(leaf)
	config := &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12, ServerName: "127.0.0.1"}
	jar, _ := cookiejar.New(nil)
	transport := &http.Transport{TLSClientConfig: config}
	t.Cleanup(transport.CloseIdleConnections)
	link := &proxyFixture{
		origin:    origin,
		address:   address,
		tls:       config,
		dataDir:   c.dataDir,
		runtimeAt: runtimeDir,
		jar:       jar,
		client:    &http.Client{Transport: transport, Jar: jar, Timeout: 30 * time.Second},
	}
	// The switch binds after start-up, so wait for the port it was told to use.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		conn, dialErr := tls.Dial("tcp", address, config)
		if dialErr == nil {
			conn.Close()
			return link
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the external service never bound its listener")
	return nil
}

func (f *proxyFixture) do(t *testing.T, method, path string, body []byte, headers map[string]string) *http.Response {
	t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequest(method, f.origin+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	// A browser omits Origin on a same-origin GET and sends it on everything
	// else; the fixture mirrors that instead of always setting it.
	if method != http.MethodGet && method != http.MethodHead {
		request.Header.Set("Origin", f.origin)
		if f.csrf != "" {
			request.Header.Set("X-Armadra-CSRF", f.csrf)
		}
	}
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := f.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func (f *proxyFixture) json(t *testing.T, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var payload []byte
	headers := map[string]string{}
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			t.Fatal(err)
		}
		headers["Content-Type"] = "application/json"
	}
	response := f.do(t, method, path, payload, headers)
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	document := map[string]any{}
	_ = json.Unmarshal(raw, &document)
	return response.StatusCode, document
}

// pair consumes a locally issued ticket, exactly as the pairing page does.
func (f *proxyFixture) pair(t *testing.T, name string, scopes []*pb.AuthorizationGrant) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	status, err := daemon.Status(ctx, f.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	ticket, err := daemon.Bootstrap(ctx, f.dataDir, &pb.BootstrapTicketRequest{
		ExpectedHostId: status.HostId, ExpectedInstanceId: status.HostInstanceId,
		Origin: f.origin, DeviceName: name, Scopes: scopes,
	})
	if err != nil {
		t.Fatal(err)
	}
	wire, err := proto.Marshal(&pb.PairDeviceRequest{ExpectedHostId: status.HostId, ExpectedInstanceId: status.HostInstanceId, Ticket: ticket.Ticket})
	if err != nil {
		t.Fatal(err)
	}
	response := f.do(t, http.MethodPost, server.AuthPrefix+"Pair", wire, map[string]string{"Content-Type": server.MediaType})
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	session := new(pb.AuthenticatedSession)
	if response.StatusCode != http.StatusOK || proto.Unmarshal(body, session) != nil || session.CsrfToken == "" {
		t.Fatalf("pairing failed with %d", response.StatusCode)
	}
	f.csrf = session.CsrfToken
}

func allGrants() []*pb.AuthorizationGrant {
	names := []string{
		"canvas:read", "canvas:write", "terminal:read", "terminal:write",
		"files:read", "files:write", "git:read", "git:write", "github:read", "github:write",
		"browser:read", "browser:control", "automation:read", "automation:manage",
		"credential:use", "resources:read", "settings:read", "settings:write",
		"identity:read", "identity:manage",
	}
	grants := make([]*pb.AuthorizationGrant, 0, len(names))
	for _, name := range names {
		grants = append(grants, &pb.AuthorizationGrant{Permission: name})
	}
	return grants
}

func writeWebFixture(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	if err := os.MkdirAll(filepath.Join(directory, "assets"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte("<!doctype html><title>armadra shell</title><div id=root></div>"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "assets", "app-deadbeef.js"), []byte("export const shell = 1;\n"), 0644); err != nil {
		t.Fatal(err)
	}
	return directory
}

func TestHostServesTheShellAndProxiesAPairedDeviceToTheRuntime(t *testing.T) {
	runtimeDir := startRuntime(t)
	web := writeWebFixture(t)
	host := startProxyHost(t, runtimeDir, web)

	// 1. An unpaired device reaches the shell — which is also the pairing page —
	//    and its static assets, and nothing else.
	response := host.do(t, http.MethodGet, "/", nil, nil)
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || !strings.Contains(string(body), "armadra shell") {
		t.Fatalf("the shell was not served: %d %s", response.StatusCode, body)
	}
	if policy := response.Header.Get("Content-Security-Policy"); !strings.Contains(policy, "frame-ancestors 'none'") {
		t.Fatalf("the shell was served without a policy: %q", policy)
	}
	// A deep link still boots the application rather than 404ing.
	response = host.do(t, http.MethodGet, "/workspace/anything", nil, nil)
	body, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || !strings.Contains(string(body), "armadra shell") {
		t.Fatal("a deep link did not fall back to the application shell")
	}
	response = host.do(t, http.MethodGet, "/assets/app-deadbeef.js", nil, nil)
	response.Body.Close()
	if response.StatusCode != 200 || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/javascript") {
		t.Fatalf("a hashed asset was not served as script: %d %q", response.StatusCode, response.Header.Get("Content-Type"))
	}
	// A missing asset must not be answered with the HTML shell.
	response = host.do(t, http.MethodGet, "/assets/gone-00000000.js", nil, nil)
	response.Body.Close()
	if response.StatusCode != 404 {
		t.Fatalf("a missing asset answered %d", response.StatusCode)
	}
	if status, _ := host.json(t, http.MethodGet, "/api/health", nil); status != 401 {
		t.Fatalf("an unpaired device reached the Runtime: %d", status)
	}

	// 2. Pair, then the same routes answer from the real Runtime.
	host.pair(t, "手机", allGrants())
	status, health := host.json(t, http.MethodGet, "/api/health", nil)
	if status != 200 || health["status"] == nil {
		t.Fatalf("the proxied health check answered %d %v", status, health)
	}

	// 3. Open a canvas: create a workspace on a real directory.
	root := t.TempDir()
	status, workspace := host.json(t, http.MethodPost, "/api/workspaces", map[string]any{"name": "proxy", "rootPath": root})
	if status != 200 || workspace["id"] == nil {
		t.Fatalf("workspace creation answered %d %v", status, workspace)
	}
	workspaceID, _ := workspace["id"].(string)
	status, boards := host.json(t, http.MethodGet, "/api/workspaces/"+workspaceID+"/boards", nil)
	if status != 200 {
		t.Fatalf("listing boards answered %d %v", status, boards)
	}

	// 4. Create a terminal and prove a keystroke survives the proxy both ways.
	status, session := host.json(t, http.MethodPost, "/api/terminals", map[string]any{
		"workspaceId": workspaceID, "cwd": root, "shell": "/bin/sh", "args": []string{},
	})
	if status != 200 || session["id"] == nil {
		t.Fatalf("terminal creation answered %d %v", status, session)
	}
	sessionID, _ := session["id"].(string)
	socket, err := dialTestSocket(host.address, "/api/terminals/"+sessionID+"/ws", host.origin, host.tls, host.jar.Cookies(mustParse(t, host.origin)))
	if err != nil {
		t.Fatalf("the terminal stream did not open through the proxy: %v", err)
	}
	defer socket.Close()
	deadline := time.Now().Add(30 * time.Second)
	frame, err := socket.readText(deadline)
	if err != nil || !strings.Contains(frame, `"type":"hello"`) {
		t.Fatalf("the first frame was not a hello: %q %v", frame, err)
	}
	marker := "armadra-proxy-echo-4711"
	if err = socket.writeText(`{"type":"input","data":"echo ` + marker + `\r"}`); err != nil {
		t.Fatal(err)
	}
	seen := ""
	for time.Now().Before(deadline) && !strings.Contains(seen, marker) {
		text, readErr := socket.readText(deadline)
		if readErr != nil {
			break
		}
		seen += text
	}
	if !strings.Contains(seen, marker) {
		t.Fatalf("the terminal never echoed the proxied input: %q", seen)
	}
}

// A phone loses its socket constantly. What must not happen is a keystroke
// running twice because the client could not tell whether it landed. This
// drives the real Runtime over a real WebSocket and drops it mid-session.
func TestATerminalRemembersAppliedInputAcrossADroppedSocket(t *testing.T) {
	runtimeDir := startRuntime(t)
	host := startProxyHost(t, runtimeDir, writeWebFixture(t))
	host.pair(t, "手机", allGrants())
	root := t.TempDir()
	status, workspace := host.json(t, http.MethodPost, "/api/workspaces", map[string]any{"name": "reconnect", "rootPath": root})
	if status != 200 {
		t.Fatalf("workspace creation answered %d %v", status, workspace)
	}
	workspaceID, _ := workspace["id"].(string)
	status, session := host.json(t, http.MethodPost, "/api/terminals", map[string]any{
		"workspaceId": workspaceID, "cwd": root, "shell": "/bin/sh", "args": []string{},
	})
	if status != 200 {
		t.Fatalf("terminal creation answered %d %v", status, session)
	}
	sessionID, _ := session["id"].(string)
	cookies := host.jar.Cookies(mustParse(t, host.origin))
	attach := func(writer string) (*testSocket, map[string]any) {
		t.Helper()
		path := "/api/terminals/" + sessionID + "/ws?writer=" + url.QueryEscape(writer)
		socket, err := dialTestSocket(host.address, path, host.origin, host.tls, cookies)
		if err != nil {
			t.Fatalf("the terminal stream did not open: %v", err)
		}
		frame, err := socket.readText(time.Now().Add(30 * time.Second))
		if err != nil {
			socket.Close()
			t.Fatalf("no hello frame: %v", err)
		}
		document := map[string]any{}
		if json.Unmarshal([]byte(frame), &document) != nil || document["type"] != "hello" {
			socket.Close()
			t.Fatalf("the first frame was not a hello: %q", frame)
		}
		return socket, document
	}

	socket, hello := attach("phone-1")
	if hello["acknowledgedInput"] != float64(0) {
		t.Fatalf("a fresh writer started at %v instead of 0", hello["acknowledgedInput"])
	}
	// Wait for each acknowledgement, so the drop below happens at a point the
	// client genuinely knows about rather than at a random moment.
	deadline := time.Now().Add(30 * time.Second)
	for id := 1; id <= 2; id++ {
		if err := socket.writeText(fmt.Sprintf(`{"type":"input","data":"echo step-%d\r","inputId":%d}`, id, id)); err != nil {
			t.Fatal(err)
		}
		acknowledged := false
		for !acknowledged && time.Now().Before(deadline) {
			frame, err := socket.readText(deadline)
			if err != nil {
				t.Fatalf("the stream ended before input %d was acknowledged: %v", id, err)
			}
			acknowledged = strings.Contains(frame, `"type":"ack"`) &&
				strings.Contains(frame, fmt.Sprintf(`"inputId":%d`, id))
		}
		if !acknowledged {
			t.Fatalf("input %d was never acknowledged", id)
		}
	}
	// The drop: no close handshake, exactly what a phone losing its network does.
	socket.Close()

	resumed, hello := attach("phone-1")
	defer resumed.Close()
	if hello["acknowledgedInput"] != float64(2) {
		t.Fatalf("the reconnect was told %v was applied instead of 2", hello["acknowledgedInput"])
	}
	// A different client has its own account and is told nothing about this one.
	other, hello := attach("laptop-2")
	defer other.Close()
	if hello["acknowledgedInput"] != float64(0) {
		t.Fatalf("another writer inherited the mark %v", hello["acknowledgedInput"])
	}
}

func TestProxyNarrowsToTheDeviceGrantsAndWorkspace(t *testing.T) {
	runtimeDir := startRuntime(t)
	host := startProxyHost(t, runtimeDir, writeWebFixture(t))
	// A device that may look at one workspace's canvas and nothing else.
	host.pair(t, "查看设备", []*pb.AuthorizationGrant{
		{Permission: "canvas:read", WorkspaceId: "workspace-a"},
		{Permission: "resources:read"},
	})
	if status, _ := host.json(t, http.MethodGet, "/api/workspaces/workspace-a/boards", nil); status != 404 && status != 200 && status != 500 {
		t.Fatalf("the granted workspace was refused by the Host: %d", status)
	}
	for _, path := range []string{"/api/workspaces/workspace-b/boards", "/api/workspaces/workspace-a/files"} {
		if status, _ := host.json(t, http.MethodGet, path, nil); status != 403 {
			t.Fatalf("%s escaped the device grants: %d", path, status)
		}
	}
	for _, request := range []struct{ method, path string }{
		{http.MethodPost, "/api/terminals"},
		{http.MethodPost, "/api/workspaces"},
	} {
		if status, _ := host.json(t, request.method, request.path, map[string]any{}); status != 403 {
			t.Fatalf("%s %s escaped the device grants: %d", request.method, request.path, status)
		}
	}
	// An unknown Runtime route is refused rather than inheriting a prefix.
	if status, _ := host.json(t, http.MethodGet, "/api/not-a-route", nil); status != 404 {
		t.Fatalf("an unknown Runtime route answered %d", status)
	}
}

func TestExternalServiceSwitchIsAuthenticatedAndClosesItsListener(t *testing.T) {
	runtimeDir := startRuntime(t)
	host := startProxyHost(t, runtimeDir, writeWebFixture(t))
	if status, _ := host.json(t, http.MethodGet, server.ExternalServicePath, nil); status != 401 {
		t.Fatalf("the switch was readable without a device: %d", status)
	}
	host.pair(t, "owner", allGrants())
	status, document := host.json(t, http.MethodGet, server.ExternalServicePath, nil)
	if status != 200 || document["supported"] != true || document["enabled"] != true {
		t.Fatalf("the switch reported %d %v", status, document)
	}
	if document["accessUrl"] != host.origin {
		t.Fatalf("the switch offered %v instead of %s", document["accessUrl"], host.origin)
	}
	// The port is bound to the certificate origin; a different one is refused
	// with a reason rather than silently bound.
	if status, document = host.json(t, http.MethodPut, server.ExternalServicePath, map[string]any{"port": 1}); status != 400 {
		t.Fatalf("a mismatched port answered %d %v", status, document)
	}
	// A network address needs the explicit acknowledgement.
	if status, _ = host.json(t, http.MethodPut, server.ExternalServicePath, map[string]any{"address": "10.1.2.3", "allowLan": false}); status != 400 {
		t.Fatalf("an unacknowledged LAN address answered %d", status)
	}
	// A write without the session's CSRF token is refused.
	saved := host.csrf
	host.csrf = ""
	if status, _ = host.json(t, http.MethodPut, server.ExternalServicePath, map[string]any{"enabled": true}); status != 403 {
		t.Fatalf("a write without CSRF answered %d", status)
	}
	host.csrf = saved
	// Turning it off closes the only listener this Host had.
	if status, document = host.json(t, http.MethodPut, server.ExternalServicePath, map[string]any{"enabled": false}); status != 200 || document["enabled"] != false {
		t.Fatalf("turning the switch off answered %d %v", status, document)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := tls.Dial("tcp", host.address, host.tls)
		if err != nil {
			return
		}
		conn.Close()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the external listener stayed reachable after the switch was turned off")
}

func mustParse(t *testing.T, value string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

// syncBuffer collects a child's output from the goroutine `exec` copies it on,
// while the test reads it on failure. A plain bytes.Buffer races between the
// two; this one takes a lock on both sides.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
