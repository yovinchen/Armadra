package main

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"armadra.local/host/internal/endpoints"
	"armadra.local/host/internal/localipc"
)

func TestListenNoneRefusesEverySurfaceThatWouldNeedAPort(t *testing.T) {
	dir := t.TempDir()
	for _, args := range [][]string{
		{"serve", "--data-dir", dir, "--listen", "none", "--allow-origin", "http://127.0.0.1:1"},
		{"serve", "--data-dir", dir, "--listen", "none", "--public-origin", "https://armadra.example"},
		{"serve", "--data-dir", dir, "--listen", "none", "--tls-cert", "/nonexistent.pem"},
	} {
		if _, err := parseConfig(args[1:]); err == nil {
			t.Fatalf("%v should have been refused", args)
		}
	}
	// On its own it is valid, and it does not become a listener by default.
	c, err := parseConfig([]string{"serve", "--data-dir", dir, "--listen", "none"})
	if err != nil {
		t.Fatalf("--listen none: %v", err)
	}
	if c.address != noListener {
		t.Fatalf("address = %q, want %q", c.address, noListener)
	}
	if c.endpointsDir != c.dataDir {
		t.Fatalf("endpointsDir = %q, want the data directory", c.endpointsDir)
	}
}

func TestEndpointsDirectoryMustBeAbsolute(t *testing.T) {
	dir := t.TempDir()
	if _, err := parseConfig([]string{"serve", "--data-dir", dir, "--endpoints-dir", "relative"}); err == nil {
		t.Fatal("a relative --endpoints-dir should be refused")
	}
	shared := t.TempDir()
	c, err := parseConfig([]string{"serve", "--data-dir", dir, "--endpoints-dir", shared})
	if err != nil {
		t.Fatalf("--endpoints-dir: %v", err)
	}
	if c.endpointsDir != filepath.Clean(shared) {
		t.Fatalf("endpointsDir = %q, want %q", c.endpointsDir, shared)
	}
}

// A Host started with no --listen address must leave no TCP port behind, and
// must still be findable: the control IPC endpoint goes into endpoints.json
// beside whatever the Runtime published there.
func TestServingWithoutAListenerPublishesOnlyTheControlEndpoint(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the named-pipe control endpoint is exercised in localipc's own tests")
	}
	dir := t.TempDir()
	shared := t.TempDir()
	// A Runtime record already in the file must survive the Host's publish.
	sharedFile := endpoints.Path(shared)
	runtimeRecord := endpoints.Now("runtime-instance")
	runtimeRecord.Socket = "/tmp/armadra/runtime.sock"
	if err := endpoints.Publish(sharedFile, endpoints.RuntimeService, runtimeRecord); err != nil {
		t.Fatalf("seed the Runtime record: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c, err := parseConfig([]string{"serve", "--data-dir", dir, "--listen", "none", "--endpoints-dir", shared})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	served := make(chan error, 1)
	go func() { served <- serveHost(ctx, c) }()

	deadline := time.Now().Add(10 * time.Second)
	var host *endpoints.Service
	for time.Now().Before(deadline) {
		if document := endpoints.Read(sharedFile); document.Host != nil {
			host = document.Host
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if host == nil {
		cancel()
		<-served
		t.Fatal("the Host never published its endpoint")
	}
	if host.HTTP != "" {
		t.Fatalf("a Host with --listen none must advertise no HTTP endpoint, got %q", host.HTTP)
	}
	if host.Socket == "" {
		t.Fatal("the control IPC endpoint was not published")
	}
	if host.ProcessID != uint32(os.Getpid()) {
		t.Fatalf("processId = %d, want this process", host.ProcessID)
	}
	// The published socket is the one a client would dial.
	expected, err := localipc.Endpoint(dir)
	if err != nil {
		t.Fatalf("endpoint: %v", err)
	}
	if host.Socket != expected {
		t.Fatalf("socket = %q, want %q", host.Socket, expected)
	}
	select {
	case err := <-served:
		t.Fatalf("serve returned early: %v", err)
	default:
	}
	if _, err := net.DialTimeout("unix", host.Socket, time.Second); err != nil {
		t.Fatalf("the published control endpoint does not accept: %v", err)
	}
	if document := endpoints.Read(sharedFile); document.Runtime == nil || document.Runtime.Socket != "/tmp/armadra/runtime.sock" {
		t.Fatalf("the Host publish disturbed the Runtime record: %+v", document.Runtime)
	}

	cancel()
	if err := <-served; err != nil && !strings.Contains(err.Error(), "context canceled") {
		t.Fatalf("serve: %v", err)
	}
	// A clean shutdown takes the address with it.
	if document := endpoints.Read(sharedFile); document.Host != nil {
		t.Fatalf("the Host record outlived the process: %+v", document.Host)
	}
	if document := endpoints.Read(sharedFile); document.Runtime == nil {
		t.Fatal("withdrawal removed the Runtime record")
	}
}

// The loopback default still works, and the address it publishes is the one it
// actually bound rather than the one it was asked for.
func TestServingWithAnEphemeralPortPublishesTheBoundAddress(t *testing.T) {
	dir := t.TempDir()
	shared := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c, err := parseConfig([]string{"serve", "--data-dir", dir, "--listen", "127.0.0.1:0", "--endpoints-dir", shared})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	served := make(chan error, 1)
	go func() { served <- serveHost(ctx, c) }()

	sharedFile := endpoints.Path(shared)
	deadline := time.Now().Add(10 * time.Second)
	var host *endpoints.Service
	for time.Now().Before(deadline) {
		if document := endpoints.Read(sharedFile); document.Host != nil && document.Host.HTTP != "" {
			host = document.Host
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if host == nil {
		cancel()
		<-served
		t.Fatal("the Host never published an HTTP endpoint")
	}
	address := strings.TrimPrefix(host.HTTP, "http://")
	if strings.HasSuffix(address, ":0") {
		t.Fatalf("the requested port was published instead of the bound one: %q", host.HTTP)
	}
	connection, err := net.DialTimeout("tcp", address, 2*time.Second)
	if err != nil {
		t.Fatalf("the published address does not accept: %v", err)
	}
	_ = connection.Close()

	cancel()
	if err := <-served; err != nil && !strings.Contains(err.Error(), "context canceled") {
		t.Fatalf("serve: %v", err)
	}
}
