package server

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

func helloBytes(t *testing.T, major, minor uint32) []byte {
	t.Helper()
	data, err := proto.Marshal(&pb.HelloRequest{ClientId: "画布客户端", Protocol: &pb.ProtocolVersion{Major: major, Minor: minor}})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestNegotiatesOnlyImplementedCapabilities(t *testing.T) {
	s := httptest.NewServer(NewHandler(Identity{HostID: "persistent-host", InstanceID: "instance-1"}))
	defer s.Close()
	for _, minor := range []uint32{0, 42} {
		response, err := http.Post(s.URL+HelloPath, MediaType, bytes.NewReader(helloBytes(t, 1, minor)))
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != 200 || response.Header.Get("Content-Type") != MediaType {
			t.Fatalf("unexpected response: %v", response)
		}
		result := &pb.HelloResponse{}
		if err := proto.Unmarshal(data, result); err != nil {
			t.Fatal(err)
		}
		if result.GetHostInstanceId() != "instance-1" || result.GetHostId() != "persistent-host" || result.GetProtocol().GetMajor() != 1 || result.GetProtocol().GetMinor() != min(minor, ProtocolMinor) || result.MaxFrameBytes != MaxFrameBytes {
			t.Fatalf("unexpected negotiation: %v", result)
		}
		if len(result.Capabilities) != 2 || result.Capabilities[0] != "protocol.hello.v1" || result.Capabilities[1] != "host.identity.v1" {
			t.Fatalf("unimplemented capability advertised: %v", result.Capabilities)
		}
	}
}

func TestRejectsInvalidOrUnsafeRequests(t *testing.T) {
	valid := helloBytes(t, 1, 0)
	cases := []struct {
		name, method, path, host, origin, contentType, encoding, fetchSite string
		body                                                               []byte
		status                                                             int
		code                                                               string
	}{
		{name: "incompatible version", body: helloBytes(t, 2, 0), status: 409, code: "UNSUPPORTED"},
		{name: "missing fields", body: []byte{}, status: 400, code: "INVALID_ARGUMENT"},
		{name: "malformed protobuf", body: []byte{0x0a, 0xff}, status: 400, code: "INVALID_ARGUMENT"},
		{name: "frame budget", body: bytes.Repeat([]byte{1}, MaxFrameBytes+1), status: 413, code: "RESOURCE_EXHAUSTED"},
		{name: "wrong media type", contentType: "application/json", body: valid, status: 415, code: "INVALID_ARGUMENT"},
		{name: "compressed input", encoding: "gzip", body: valid, status: 415, code: "UNSUPPORTED"},
		{name: "wrong method", method: "GET", body: valid, status: 405, code: "INVALID_ARGUMENT"},
		{name: "unknown endpoint", path: "/rpc/Execute", body: valid, status: 404, code: "NOT_FOUND"},
		{name: "dns rebinding", host: "attacker.example:43121", body: valid, status: 403, code: "PERMISSION_DENIED"},
		{name: "nonlocal host", host: "192.168.1.20:43121", body: valid, status: 403, code: "PERMISSION_DENIED"},
		{name: "cross origin", origin: "https://attacker.example", body: valid, status: 403, code: "PERMISSION_DENIED"},
		{name: "opaque origin", origin: "null", body: valid, status: 403, code: "PERMISSION_DENIED"},
		{name: "cross site fetch", fetchSite: "cross-site", body: valid, status: 403, code: "PERMISSION_DENIED"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			method, path, host, media := tc.method, tc.path, tc.host, tc.contentType
			if method == "" {
				method = "POST"
			}
			if path == "" {
				path = HelloPath
			}
			if host == "" {
				host = "127.0.0.1:43121"
			}
			if media == "" {
				media = MediaType
			}
			r := httptest.NewRequest(method, "http://127.0.0.1:43121"+path, bytes.NewReader(tc.body))
			r.Host = host
			r.Header.Set("Content-Type", media)
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Content-Encoding", tc.encoding)
			r.Header.Set("Sec-Fetch-Site", tc.fetchSite)
			w := httptest.NewRecorder()
			NewHandler(Identity{HostID: "persistent-host", InstanceID: "instance"}).ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status %d, want %d", w.Code, tc.status)
			}
			result := &pb.ErrorResponse{}
			if err := proto.Unmarshal(w.Body.Bytes(), result); err != nil {
				t.Fatal(err)
			}
			if result.GetCode() != tc.code {
				t.Fatalf("code %s, want %s", result.GetCode(), tc.code)
			}
		})
	}
}

func TestSameOriginAndIPv6Authorities(t *testing.T) {
	for _, host := range []string{"127.0.0.1:43121", "localhost:43121", "[::1]:43121"} {
		r := httptest.NewRequest("POST", "http://"+host+HelloPath, bytes.NewReader(helloBytes(t, 1, 0)))
		r.Header.Set("Content-Type", MediaType)
		r.Header.Set("Origin", "http://"+host)
		w := httptest.NewRecorder()
		NewHandler(Identity{HostID: "persistent-host", InstanceID: "instance"}).ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("%s: status %d", host, w.Code)
		}
	}
}

func TestLocalListenerAndHostShutdown(t *testing.T) {
	for _, address := range []string{"0.0.0.0:0", "[::]:0", ":0", "example.invalid:0", "localhost:0", "192.168.1.20:0"} {
		if l, err := ListenLocal(address); err == nil {
			l.Close()
			t.Fatalf("accepted non-explicit-loopback %s", address)
		}
	}
	l, err := ListenLocal("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, l, Identity{HostID: "persistent-host", InstanceID: "host-lifecycle"}) }()
	client := &http.Client{Timeout: 2 * time.Second}
	for i := 0; i < 2; i++ {
		res, err := client.Get("http://" + l.Addr().String() + "/health")
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		client.CloseIdleConnections()
		if err != nil || res.StatusCode != 200 || strings.TrimSpace(string(body)) != "ok" {
			t.Fatalf("health after reconnect: %s, %v", body, err)
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("host did not shut down")
	}
}
