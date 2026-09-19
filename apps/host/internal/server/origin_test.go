package server

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseOrigin(t *testing.T) {
	for input, want := range map[string]string{
		"http://localhost:1420": "http://localhost:1420", "http://127.0.0.1:1420": "http://127.0.0.1:1420", "http://[::1]:1420": "http://[::1]:1420", "https://EXAMPLE.COM:443": "https://example.com", "http://LOCALHOST:80": "http://localhost", "http://127.0.0.2:8080": "http://127.0.0.2:8080", "https://shell.localhost": "https://shell.localhost",
	} {
		got, err := ParseOrigin(input)
		if err != nil || got != want {
			t.Errorf("%q = %q, %v; want %q", input, got, err, want)
		}
	}
	for _, input := range []string{"", "*", "null", "http://example.com", "http://shell.localhost", "http://shell.localhost:1420", "http://192.168.0.1:1420", "https://user:password@example.com", "https://example.com/", "https://example.com/path", "https://example.com?", "https://example.com#", "https://example.com?q=x", "https://example.com#fragment", "https://example.com\r\n", " https://example.com", "https://example.com https://other.example", "ftp://localhost", "app://localhost", "custom://localhost", "https://example.com:", "https://[example.com]", "https://[127.0.0.1]", "https://example.com:65536", "https://example.com:0", "https://*.example.com", "https://[::1%25zone]", "https://example.com\\path"} {
		if got, err := ParseOrigin(input); err == nil {
			t.Errorf("accepted %q as %q", input, got)
		}
		if handler, err := NewHandlerWithOptions(Identity{}, Options{AllowedOrigins: []string{input}}); err == nil || handler != nil {
			t.Errorf("invalid configuration accepted %q", input)
		}
	}
}

func TestExplicitOriginMetadataHTTP(t *testing.T) {
	const origin = "http://localhost:1420"
	handler, err := NewHandlerWithOptions(Identity{HostID: "host", InstanceID: "instance"}, Options{AllowedOrigins: []string{origin, "http://127.0.0.1:54321", "http://[::1]:61000"}})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	for _, allowed := range []string{origin, "http://127.0.0.1:54321", "http://[::1]:61000"} {
		for _, route := range []struct{ method, path string }{{"GET", "/health"}, {"POST", HelloPath}} {
			request, _ := http.NewRequest(route.method, server.URL+route.path, bytes.NewReader(helloBytes(t, 1, 1)))
			request.Header.Set("Origin", allowed)
			request.Header.Set("Sec-Fetch-Site", "cross-site")
			request.Header.Set("Content-Type", MediaType)
			response, err := server.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode != 200 {
				t.Fatalf("%s %s status %d", allowed, route.path, response.StatusCode)
			}
			if response.Header.Get("Access-Control-Allow-Origin") != allowed {
				t.Fatal("origin was not exactly echoed")
			}
			if response.Header.Get("Access-Control-Allow-Credentials") != "" {
				t.Fatal("credential CORS must remain disabled")
			}
			if !strings.Contains(strings.Join(response.Header.Values("Vary"), ","), "Origin") {
				t.Fatal("missing Vary: Origin")
			}
		}
	}
	preflightRequest, _ := http.NewRequest("OPTIONS", server.URL+HelloPath, nil)
	preflightRequest.Header.Set("Origin", origin)
	preflightRequest.Header.Set("Access-Control-Request-Method", "POST")
	preflightRequest.Header.Set("Access-Control-Request-Headers", "content-type, accept")
	preflightResponse, err := server.Client().Do(preflightRequest)
	if err != nil {
		t.Fatal(err)
	}
	preflightResponse.Body.Close()
	if preflightResponse.StatusCode != 204 || preflightResponse.Header.Get("Access-Control-Allow-Origin") != origin || preflightResponse.Header.Get("Access-Control-Allow-Headers") != "content-type, accept" || preflightResponse.Header.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatal("real HTTP preflight failed")
	}
	for _, origin := range []string{"http://127.0.0.1:1420", "http://localhost:1421", "http://localhost:1420/", "https://localhost:1420", "https://attacker.example", "null"} {
		request, _ := http.NewRequest("GET", server.URL+"/health", nil)
		request.Header.Set("Origin", origin)
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 403 || response.Header.Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("unapproved origin %q returned %d", origin, response.StatusCode)
		}
	}
	response, err := server.Client().Get(server.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 || response.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CLI access changed")
	}
}

func TestOriginPreflight(t *testing.T) {
	const allowed = "http://localhost:1420"
	handler, err := NewHandlerWithOptions(Identity{}, Options{AllowedOrigins: []string{allowed}})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, path, origin, method, headers, host string
		status                                    int
	}{
		{name: "hello", path: HelloPath, origin: allowed, method: "POST", headers: "Content-Type, Accept", status: 204},
		{name: "health", path: "/health", origin: allowed, method: "GET", status: 204},
		{name: "wrong method", path: HelloPath, origin: allowed, method: "GET", status: 403},
		{name: "missing method", path: HelloPath, origin: allowed, status: 403},
		{name: "missing origin", path: HelloPath, method: "POST", status: 403},
		{name: "wrong origin", path: HelloPath, origin: "http://localhost:1421", method: "POST", status: 403},
		{name: "unknown route", path: "/other", origin: allowed, method: "POST", status: 404},
		{name: "authorization", path: HelloPath, origin: allowed, method: "POST", headers: "authorization", status: 403},
		{name: "partial allowed headers", path: HelloPath, origin: allowed, method: "POST", headers: "content-type, x-extra", status: 403},
		{name: "empty header token", path: HelloPath, origin: allowed, method: "POST", headers: "content-type,", status: 403},
		{name: "remote authority", path: HelloPath, origin: allowed, method: "POST", host: "192.168.1.2:43121", status: 403},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest("OPTIONS", "http://127.0.0.1:43121"+tc.path, nil)
			if tc.host != "" {
				request.Host = tc.host
			}
			if tc.origin != "" {
				request.Header.Set("Origin", tc.origin)
			}
			if tc.method != "" {
				request.Header.Set("Access-Control-Request-Method", tc.method)
			}
			if tc.headers != "" {
				request.Header.Set("Access-Control-Request-Headers", tc.headers)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != tc.status {
				t.Fatalf("status %d, want %d", response.Code, tc.status)
			}
			if response.Header().Get("Access-Control-Allow-Credentials") != "" {
				t.Fatal("credentials allowed")
			}
			if tc.status == 204 {
				if response.Header().Get("Access-Control-Allow-Origin") != tc.origin || response.Header().Get("Access-Control-Allow-Methods") != tc.method {
					t.Fatal("incorrect preflight grants")
				}
				vary := strings.Join(response.Header().Values("Vary"), ",")
				for _, field := range []string{"Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"} {
					if !strings.Contains(vary, field) {
						t.Fatalf("missing Vary %s", field)
					}
				}
			} else if response.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatal("denied preflight granted CORS")
			}
		})
	}
}

func TestOriginHeadersDoNotBroadenSameOrigin(t *testing.T) {
	handler, err := NewHandlerWithOptions(Identity{}, Options{AllowedOrigins: []string{"http://localhost:1420"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		origin, fetch, method, path string
		duplicate                   bool
		status                      int
	}{
		{origin: "http://127.0.0.1:43121", method: "GET", path: "/health", status: 200},
		{origin: "http://127.0.0.1:43121", fetch: "cross-site", method: "GET", path: "/health", status: 403},
		{fetch: "cross-site", method: "GET", path: "/health", status: 403},
		{origin: "http://localhost:1420", method: "DELETE", path: "/health", status: 405},
		{origin: "http://localhost:1420", method: "GET", path: "/unknown", status: 404},
		{origin: "http://localhost:1420", method: "GET", path: "/health", duplicate: true, status: 403},
	} {
		request := httptest.NewRequest(tc.method, "http://127.0.0.1:43121"+tc.path, nil)
		request.Header.Set("Origin", tc.origin)
		request.Header.Set("Sec-Fetch-Site", tc.fetch)
		if tc.duplicate {
			request.Header.Add("Origin", tc.origin)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != tc.status {
			t.Fatalf("%+v got %d", tc, response.Code)
		}
		if response.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("unexpected cross-origin grant")
		}
	}
}
