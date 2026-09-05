package runtimelink

import (
	"context"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"armadra.local/host/internal/endpoints"
)

func TestTheSocketIsPreferredOverAPortAndOnlyLoopbackPortsAreAccepted(t *testing.T) {
	both := endpoints.Service{HTTP: "http://127.0.0.1:5000", Socket: "/tmp/armadra/runtime.sock", Pipe: `\\.\pipe\armadra`}
	target, err := targetOf(both)
	if err != nil || target.Socket != "/tmp/armadra/runtime.sock" || target.Address != "" {
		t.Fatalf("an OS-scoped transport was not preferred: %+v %v", target, err)
	}
	pipeOnly, err := targetOf(endpoints.Service{HTTP: "http://127.0.0.1:5000", Pipe: `\\.\pipe\armadra`})
	if err != nil || pipeOnly.Pipe == "" {
		t.Fatalf("the named pipe was not preferred over a port: %+v %v", pipeOnly, err)
	}
	loopback, err := targetOf(endpoints.Service{HTTP: "http://127.0.0.1:5000"})
	if err != nil || loopback.Address != "127.0.0.1:5000" || loopback.Origin() != "http://127.0.0.1:5000" {
		t.Fatalf("a loopback port was rejected: %+v %v", loopback, err)
	}
	for _, record := range []endpoints.Service{
		{HTTP: "http://192.168.1.20:5000"},
		{HTTP: "https://127.0.0.1:5000"},
		{HTTP: "http://runtime.example:5000"},
		{HTTP: "http://127.0.0.1:5000/api"},
		{HTTP: "http://127.0.0.1"},
		{},
	} {
		if _, err = targetOf(record); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("%+v was accepted as a Runtime address", record)
		}
	}
}

func TestASocketTargetNamesAPortlessLoopbackOrigin(t *testing.T) {
	target := Target{Socket: "/tmp/armadra/runtime.sock"}
	if target.Origin() != "http://127.0.0.1" || target.Authority() != "127.0.0.1" {
		t.Fatalf("a socket target described itself as %q / %q", target.Origin(), target.Authority())
	}
	if empty := (Target{}); !empty.Empty() {
		t.Fatal("an empty target did not report itself as empty")
	}
}

func TestPipeNamesOutsideTheLocalNamespaceAreRefused(t *testing.T) {
	if _, err := pipeName(`\\.\pipe\armadra-runtime`); err != nil {
		t.Fatalf("a local pipe was refused: %v", err)
	}
	for _, name := range []string{`\\server\pipe\armadra`, `\\.\pipe\`, `\\.\pipe\a\b`, "armadra", ""} {
		if _, err := pipeName(name); err == nil {
			t.Fatalf("%q was accepted as a local pipe", name)
		}
	}
}

func TestAMissingOrStaleRecordIsUnavailableAndForgotten(t *testing.T) {
	directory := t.TempDir()
	resolver := New(directory)
	if _, err := resolver.Resolve(); !errors.Is(err, ErrUnavailable) {
		t.Fatal("an empty endpoints document resolved to an address")
	}
	record := endpoints.Now("runtime")
	record.Socket = filepath.Join(directory, "nothing.sock")
	if err := endpoints.Publish(resolver.File(), endpoints.RuntimeService, record); err != nil {
		t.Fatal(err)
	}
	target, err := resolver.Resolve()
	if err != nil || target.Socket == "" {
		t.Fatalf("the published socket was not resolved: %v", err)
	}
	if _, err = resolver.Dial(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("dialling a socket nothing listens on succeeded: %v", err)
	}
}

// A resolver must actually carry a request over the transport it found. The
// upstream here is a plain loopback server, which is the TCP shape; the socket
// shape is exercised end to end by the Host's own proxy test.
func TestTheResolverCarriesARequestToAPublishedRuntime(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("this fixture uses a loopback TCP upstream and a socket path")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	seen := make(chan string, 1)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("Origin")
		w.WriteHeader(http.StatusNoContent)
	}), ReadHeaderTimeout: time.Second}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()

	directory := t.TempDir()
	resolver := New(directory)
	record := endpoints.Now("runtime")
	record.HTTP = "http://" + listener.Addr().String()
	if err = endpoints.Publish(resolver.File(), endpoints.RuntimeService, record); err != nil {
		t.Fatal(err)
	}
	target, err := resolver.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodGet, "http://"+target.Authority()+"/api/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", target.Origin())
	response, err := resolver.Client(target).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("the upstream answered %d", response.StatusCode)
	}
	if origin := <-seen; origin != "http://"+listener.Addr().String() {
		t.Fatalf("the Runtime saw the origin %q", origin)
	}
}
