package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

const authHost = "11111111111111111111111111111111"
const authInstance = "22222222222222222222222222222222"

type authFixture struct {
	t        *testing.T
	store    *storage.Store
	identity *auth.Service
	server   *httptest.Server
	handler  http.Handler
	origin   string
	clock    atomic.Int64
}
type authReply struct {
	status  int
	header  http.Header
	body    []byte
	cookies []*http.Cookie
}

// newAuthFixture builds the authenticated surface. The variadic hooks let one
// suite add a service — the GitHub one, say — without every other test having
// to know it exists.
func newAuthFixture(t *testing.T, configure ...func(*authFixture, *Options)) *authFixture {
	t.Helper()
	f := &authFixture{t: t}
	f.clock.Store(time.Now().UnixMilli())
	var err error
	f.store, err = storage.Open(t.TempDir(), authHost)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.store.Close() })
	f.identity, err = auth.New(f.store, auth.Config{InstanceID: authInstance, Clock: func() time.Time { return time.UnixMilli(f.clock.Load()) }})
	if err != nil {
		t.Fatal(err)
	}
	f.server = httptest.NewUnstartedServer(nil)
	f.origin = "https://" + f.server.Listener.Addr().String()
	options := Options{Identity: f.identity, PublicOrigin: f.origin}
	for _, hook := range configure {
		hook(f, &options)
	}
	f.handler, err = NewHandlerWithOptions(Identity{HostID: authHost, InstanceID: authInstance}, options)
	if err != nil {
		f.server.Close()
		t.Fatal(err)
	}
	f.server.Config.Handler = f.handler
	f.server.StartTLS()
	t.Cleanup(f.server.Close)
	return f
}
func (f *authFixture) client(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Transport: f.server.Client().Transport, Jar: jar, Timeout: 5 * time.Second}
}
func (f *authFixture) ticket(t *testing.T, name string, scopes []auth.Scope) *pb.PairDeviceRequest {
	t.Helper()
	ticket, err := f.identity.IssueBootstrap(context.Background(), auth.BootstrapRequest{HostID: authHost, InstanceID: authInstance, Origin: f.origin, DeviceName: name, Scopes: scopes})
	if err != nil {
		t.Fatal(err)
	}
	return &pb.PairDeviceRequest{ExpectedHostId: authHost, ExpectedInstanceId: authInstance, Ticket: ticket.Ticket}
}
func authWire(t *testing.T, message proto.Message) []byte {
	t.Helper()
	wire, err := proto.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	return wire
}
func (f *authFixture) request(t *testing.T, client *http.Client, action string, body []byte, change func(*http.Request)) authReply {
	t.Helper()
	r, err := http.NewRequest("POST", f.origin+AuthPrefix+action, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", f.origin)
	r.Header.Set("Content-Type", MediaType)
	if change != nil {
		change(r)
	}
	response, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.TLS == nil || len(response.TLS.VerifiedChains) == 0 {
		t.Fatal("fixture request did not verify its HTTPS certificate")
	}
	return authReply{status: response.StatusCode, header: response.Header, body: data, cookies: response.Cookies()}
}
func (f *authFixture) post(t *testing.T, client *http.Client, action string, message proto.Message, csrf string) authReply {
	return f.request(t, client, action, authWire(t, message), func(r *http.Request) {
		if csrf != "" {
			r.Header.Set("X-Armadra-CSRF", csrf)
		}
	})
}
func expectAuthStatus(t *testing.T, response authReply, status int, code string) {
	t.Helper()
	if response.status != status {
		t.Fatalf("HTTP status=%d want=%d", response.status, status)
	}
	if response.header.Get("Cache-Control") != "no-store" || response.header.Get("X-Content-Type-Options") != "nosniff" || response.header.Get("Content-Type") != MediaType {
		t.Fatal("missing response privacy/content headers")
	}
	if code != "" {
		var failure pb.ErrorResponse
		if err := proto.Unmarshal(response.body, &failure); err != nil || failure.Code != code {
			t.Fatalf("error code=%s want=%s decode=%v", failure.Code, code, err)
		}
		if len(response.cookies) != 0 {
			t.Fatal("rejected request set authentication cookies")
		}
	}
}
func decodeSession(t *testing.T, response authReply) *pb.AuthenticatedSession {
	t.Helper()
	expectAuthStatus(t, response, 200, "")
	value := new(pb.AuthenticatedSession)
	if err := proto.Unmarshal(response.body, value); err != nil {
		t.Fatal(err)
	}
	if value.HostId != authHost || value.Device == nil || value.Device.PrincipalId == "" || value.Device.DeviceId == "" || value.Device.Role != "owner" || value.Device.Revision != 1 {
		t.Fatal("invalid authenticated metadata")
	}
	return value
}
func (f *authFixture) pair(t *testing.T, client *http.Client, name string, scopes []auth.Scope) (*pb.AuthenticatedSession, authReply) {
	t.Helper()
	reply := f.post(t, client, "Pair", f.ticket(t, name, scopes), "")
	return decodeSession(t, reply), reply
}
func assertSafeCookies(t *testing.T, response authReply) {
	t.Helper()
	if len(response.cookies) != 2 {
		t.Fatal("expected exactly access and refresh cookies")
	}
	for _, cookie := range response.cookies {
		if !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.Domain != "" || !strings.HasPrefix(cookie.Name, "__Host-armadra_"+authHost+"_") || cookie.Value == "" {
			t.Fatal("unsafe authentication cookie attributes")
		}
		if bytes.Contains(response.body, []byte(cookie.Value)) {
			t.Fatal("bearer credential leaked into response body")
		}
	}
}

func TestHTTPSPairCurrentAndTicketIsSingleUse(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	ticket := f.ticket(t, "浏览器 owner", auth.AllScopes())
	reply := f.post(t, client, "Pair", ticket, "")
	session := decodeSession(t, reply)
	assertSafeCookies(t, reply)
	if session.CsrfToken == "" || session.Device.DisplayName != "浏览器 owner" || session.Device.CreatedAtUnixMs != f.clock.Load() {
		t.Fatal("paired session omitted approved device metadata")
	}
	if reply.header.Get("Access-Control-Allow-Origin") != f.origin || reply.header.Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatal("authenticated origin response was not precise")
	}
	expectAuthStatus(t, f.post(t, f.client(t), "Pair", ticket, ""), 401, "UNAUTHENTICATED")
	current := decodeSession(t, f.post(t, client, "Current", &pb.CurrentSessionRequest{}, ""))
	if current.Device.DeviceId != session.Device.DeviceId || current.CsrfToken != "" {
		t.Fatal("Current leaked CSRF or changed device")
	}
	// Grants describe this authenticated session, not every session of a device.
	field := current.ProtoReflect().Descriptor().Fields().ByName("scopes")
	if field == nil || current.ProtoReflect().Get(field).List().Len() == 0 {
		t.Fatal("authenticated session omitted its grants")
	}
	events, err := f.store.GetEvents(context.Background(), storage.EventQuery{})
	if err != nil || events.HighWatermark != 0 {
		t.Fatal("HTTP identity writes leaked into business outbox")
	}
}

func TestAuthRejectsWrongOriginAuthorityAndPlainHTTP(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	session, _ := f.pair(t, client, "browser", auth.AllScopes())
	cases := map[string]func(*http.Request){
		"missing Origin":   func(r *http.Request) { r.Header.Del("Origin") },
		"wrong Origin":     func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") },
		"null Origin":      func(r *http.Request) { r.Header.Set("Origin", "null") },
		"duplicate Origin": func(r *http.Request) { r.Header.Add("Origin", f.origin) },
		"wrong authority":  func(r *http.Request) { r.Host = "localhost:9" },
		"wrong scheme":     func(r *http.Request) { r.Header.Set("Origin", strings.Replace(f.origin, "https:", "http:", 1)) },
		"cross site":       func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			expectAuthStatus(t, f.request(t, client, "Current", nil, change), 403, "PERMISSION_DENIED")
		})
	}
	if session.CsrfToken == "" {
		t.Fatal("fixture missing CSRF")
	}
	// Even a configured CORS exception and forwarded HTTPS claim cannot upgrade
	// an actual plaintext request into a credential transport.
	for _, options := range []Options{{Identity: f.identity}, {Identity: f.identity, AllowedOrigins: []string{"http://127.0.0.1:1420"}}, {Identity: f.identity, PublicOrigin: f.origin}} {
		handler, err := NewHandlerWithOptions(Identity{HostID: authHost, InstanceID: authInstance}, options)
		if err != nil {
			t.Fatal(err)
		}
		for _, action := range []string{"Pair", "Current", "Refresh", "RenewCsrf", "Logout", "ListDevices", "RevokeDevice"} {
			req := httptest.NewRequest("POST", "http://127.0.0.1:43121"+AuthPrefix+action, bytes.NewReader(nil))
			req.Header.Set("Origin", "http://127.0.0.1:43121")
			if len(options.AllowedOrigins) > 0 {
				req.Header.Set("Origin", options.AllowedOrigins[0])
			}
			req.Header.Set("Content-Type", MediaType)
			req.Header.Set("X-Forwarded-Proto", "https")
			u, _ := url.Parse(f.origin)
			for _, cookie := range client.Jar.Cookies(u) {
				req.AddCookie(cookie)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != 403 || len(rec.Result().Cookies()) != 0 {
				t.Fatalf("plaintext %s accepted or set cookies", action)
			}
		}
	}
}

func TestMetadataAllowlistCannotEnableCrossOriginAuthentication(t *testing.T) {
	f := newAuthFixture(t)
	for _, other := range []string{"https://other.example", "http://localhost:1420", "tauri://localhost"} {
		handler, err := NewHandlerWithOptions(Identity{HostID: authHost, InstanceID: authInstance}, Options{Identity: f.identity, PublicOrigin: f.origin, AllowedOrigins: []string{other}})
		if err != nil {
			t.Fatal(err)
		}
		for _, method := range []string{"POST", "OPTIONS"} {
			request := httptest.NewRequest(method, f.origin+AuthPrefix+"RenewCsrf", nil)
			request.TLS = &tls.ConnectionState{}
			request.Header.Set("Origin", other)
			request.Header.Set("Content-Type", MediaType)
			request.Header.Set("Access-Control-Request-Method", "POST")
			request.Header.Set("Access-Control-Request-Headers", "content-type")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != 403 || response.Header().Get("Access-Control-Allow-Credentials") != "" {
				t.Fatal("metadata allowlist enabled credential audience")
			}
		}
	}
	handler, err := NewHandlerWithOptions(Identity{HostID: authHost, InstanceID: authInstance}, Options{Identity: f.identity})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", f.origin+AuthPrefix+"Current", nil)
	request.TLS = &tls.ConnectionState{}
	request.Header.Set("Origin", f.origin)
	request.Header.Set("Content-Type", MediaType)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatal("TLS without explicit public origin enabled authentication")
	}
}

func TestHTTPSPairRejectsWrongHostInstanceAndExpiredTicket(t *testing.T) {
	f := newAuthFixture(t)
	ticket := f.ticket(t, "approved", auth.AllScopes())
	client := f.client(t)
	wrongHost := proto.Clone(ticket).(*pb.PairDeviceRequest)
	wrongHost.ExpectedHostId = strings.Repeat("a", 32)
	wrongInstance := proto.Clone(ticket).(*pb.PairDeviceRequest)
	wrongInstance.ExpectedInstanceId = strings.Repeat("b", 32)
	for _, bad := range []*pb.PairDeviceRequest{wrongHost, wrongInstance} {
		expectAuthStatus(t, f.post(t, client, "Pair", bad, ""), 401, "UNAUTHENTICATED")
	}
	decodeSession(t, f.post(t, client, "Pair", ticket, ""))
	expired := f.ticket(t, "expires", auth.AllScopes())
	f.clock.Add(auth.BootstrapTTL.Milliseconds())
	expectAuthStatus(t, f.post(t, f.client(t), "Pair", expired, ""), 401, "UNAUTHENTICATED")
}

func TestHTTPSCSRFRecoveryRefreshRotationAndExpiredAccessLogout(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	session, paired := f.pair(t, client, "browser", auth.AllScopes())
	u, _ := url.Parse(f.origin)
	oldCookies := client.Jar.Cookies(u)
	expectAuthStatus(t, f.post(t, client, "Refresh", &pb.RefreshSessionRequest{}, ""), 401, "UNAUTHENTICATED")
	f.clock.Store(session.ExpiresAtUnixMs)
	expectAuthStatus(t, f.post(t, client, "Current", &pb.CurrentSessionRequest{}, ""), 401, "UNAUTHENTICATED")
	renewed := f.post(t, client, "RenewCsrf", &pb.RenewCsrfRequest{}, "")
	expectAuthStatus(t, renewed, 200, "")
	var csrf pb.RenewCsrfResponse
	if err := proto.Unmarshal(renewed.body, &csrf); err != nil || csrf.CsrfToken == "" || csrf.CsrfToken == session.CsrfToken {
		t.Fatal("CSRF recovery did not rotate bound secret")
	}
	if len(renewed.cookies) != 0 {
		t.Fatal("CSRF recovery replaced bearer cookies")
	}
	expectAuthStatus(t, f.post(t, client, "Refresh", &pb.RefreshSessionRequest{}, session.CsrfToken), 401, "UNAUTHENTICATED")
	refreshed := f.post(t, client, "Refresh", &pb.RefreshSessionRequest{}, csrf.CsrfToken)
	current := decodeSession(t, refreshed)
	assertSafeCookies(t, refreshed)
	for i, cookie := range refreshed.cookies {
		if cookie.Value == paired.cookies[i].Value {
			t.Fatal("refresh retained old bearer token")
		}
	}
	stale := f.client(t)
	stale.Jar.SetCookies(u, oldCookies)
	expectAuthStatus(t, f.post(t, stale, "Refresh", &pb.RefreshSessionRequest{}, csrf.CsrfToken), 401, "UNAUTHENTICATED")
	expectAuthStatus(t, f.post(t, client, "Logout", &pb.LogoutSessionRequest{}, csrf.CsrfToken), 401, "UNAUTHENTICATED")
	f.clock.Store(current.ExpiresAtUnixMs)
	closed := f.post(t, client, "Logout", &pb.LogoutSessionRequest{}, current.CsrfToken)
	expectAuthStatus(t, closed, 200, "")
	var result pb.SessionClosedResponse
	if err := proto.Unmarshal(closed.body, &result); err != nil || !result.Closed {
		t.Fatal("logout did not confirm persisted revocation")
	}
	if len(closed.cookies) != 2 {
		t.Fatal("logout did not clear both cookies")
	}
	for _, cookie := range closed.cookies {
		if cookie.MaxAge >= 0 || cookie.Value != "" || !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode {
			t.Fatal("logout cookie removal lost protection")
		}
	}
	expectAuthStatus(t, f.post(t, client, "RenewCsrf", &pb.RenewCsrfRequest{}, ""), 401, "UNAUTHENTICATED")
}

func TestHTTPSDeviceRevocationCASAndScopedPermissions(t *testing.T) {
	f := newAuthFixture(t)
	ownerClient := f.client(t)
	owner, _ := f.pair(t, ownerClient, "owner", auth.AllScopes())
	limitedClient := f.client(t)
	limited, _ := f.pair(t, limitedClient, "limited", []auth.Scope{{Permission: "canvas:read", WorkspaceID: "workspace-a", ExecutionHostID: "worker-a"}})
	expectAuthStatus(t, f.post(t, limitedClient, "ListDevices", &pb.ListDevicesRequest{}, ""), 403, "PERMISSION_DENIED")
	expectAuthStatus(t, f.post(t, limitedClient, "RevokeDevice", &pb.RevokeDeviceRequest{DeviceId: owner.Device.DeviceId, ExpectedRevision: owner.Device.Revision}, limited.CsrfToken), 403, "PERMISSION_DENIED")
	// Narrow grants must remain inspectable through Current without granting
	// device-management access; they are attached to the authenticated session.
	current := decodeSession(t, f.post(t, limitedClient, "Current", &pb.CurrentSessionRequest{}, ""))
	field := current.ProtoReflect().Descriptor().Fields().ByName("scopes")
	if field == nil || current.ProtoReflect().Get(field).List().Len() != 1 {
		t.Fatal("Current lost narrow grants")
	}
	expectAuthStatus(t, f.post(t, ownerClient, "RevokeDevice", &pb.RevokeDeviceRequest{DeviceId: limited.Device.DeviceId, ExpectedRevision: limited.Device.Revision}, ""), 403, "PERMISSION_DENIED")
	expectAuthStatus(t, f.post(t, ownerClient, "RevokeDevice", &pb.RevokeDeviceRequest{DeviceId: limited.Device.DeviceId, ExpectedRevision: limited.Device.Revision + 1}, owner.CsrfToken), 409, "CONFLICT")
	expectAuthStatus(t, f.post(t, limitedClient, "Current", &pb.CurrentSessionRequest{}, ""), 200, "")
	revoked := f.post(t, ownerClient, "RevokeDevice", &pb.RevokeDeviceRequest{DeviceId: limited.Device.DeviceId, ExpectedRevision: limited.Device.Revision}, owner.CsrfToken)
	expectAuthStatus(t, revoked, 200, "")
	var receipt pb.RevokeDeviceResponse
	if err := proto.Unmarshal(revoked.body, &receipt); err != nil || !receipt.Revoked || receipt.DeviceId != limited.Device.DeviceId {
		t.Fatal("wrong revocation receipt")
	}
	expectAuthStatus(t, f.post(t, limitedClient, "Current", &pb.CurrentSessionRequest{}, ""), 401, "UNAUTHENTICATED")
	expectAuthStatus(t, f.post(t, limitedClient, "RenewCsrf", &pb.RenewCsrfRequest{}, ""), 401, "UNAUTHENTICATED")
	listed := f.post(t, ownerClient, "ListDevices", &pb.ListDevicesRequest{Limit: 1}, "")
	expectAuthStatus(t, listed, 200, "")
	var page pb.ListDevicesResponse
	if err := proto.Unmarshal(listed.body, &page); err != nil || len(page.Devices) != 1 || !page.HasMore || page.NextId == "" {
		t.Fatal("device pagination lost cursor")
	}
	next := f.post(t, ownerClient, "ListDevices", &pb.ListDevicesRequest{Limit: 1, AfterId: page.NextId}, "")
	expectAuthStatus(t, next, 200, "")
	var tail pb.ListDevicesResponse
	if err := proto.Unmarshal(next.body, &tail); err != nil || len(tail.Devices) != 1 || tail.HasMore {
		t.Fatal("incorrect final device page")
	}
	for _, device := range append(page.Devices, tail.Devices...) {
		if device.DeviceId == limited.Device.DeviceId && (device.Revision != 2 || device.RevokedAtUnixMs == 0) {
			t.Fatal("revocation state/revision not persisted")
		}
	}
}

func TestHTTPSRejectsDuplicateCookiesAndMalformedFrames(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	session, _ := f.pair(t, client, "browser", auth.AllScopes())
	u, _ := url.Parse(f.origin)
	cookies := client.Jar.Cookies(u)
	for _, cookie := range cookies {
		action := "Current"
		if strings.HasSuffix(cookie.Name, "_refresh") {
			action = "RenewCsrf"
		}
		reply := f.request(t, client, action, nil, func(r *http.Request) { r.AddCookie(cookie) })
		expectAuthStatus(t, reply, 401, "UNAUTHENTICATED")
	}
	deep := []byte{}
	for range 5000 {
		deep = protowire.AppendTag(deep, 99, protowire.StartGroupType)
	}
	for range 5000 {
		deep = protowire.AppendTag(deep, 99, protowire.EndGroupType)
	}
	cases := []struct {
		name   string
		body   []byte
		change func(*http.Request)
		status int
		code   string
	}{
		{"gzip", nil, func(r *http.Request) { r.Header.Set("Content-Encoding", "gzip") }, 415, "UNSUPPORTED"},
		{"json", nil, func(r *http.Request) { r.Header.Set("Content-Type", "application/json") }, 415, "INVALID_ARGUMENT"},
		{"type parameter", nil, func(r *http.Request) { r.Header.Set("Content-Type", MediaType+"; charset=utf-8") }, 415, "INVALID_ARGUMENT"},
		{"duplicate type", nil, func(r *http.Request) { r.Header.Add("Content-Type", MediaType) }, 400, "INVALID_ARGUMENT"},
		{"missing type", nil, func(r *http.Request) { r.Header.Del("Content-Type") }, 400, "INVALID_ARGUMENT"},
		{"query", nil, func(r *http.Request) { r.URL.RawQuery = "ticket=must-not-log" }, 400, "INVALID_ARGUMENT"},
		{"duplicate CSRF", nil, func(r *http.Request) {
			r.Header.Add("X-Armadra-CSRF", session.CsrfToken)
			r.Header.Add("X-Armadra-CSRF", session.CsrfToken)
		}, 403, "PERMISSION_DENIED"},
		{"invalid wire", []byte{0x0a, 0xff}, nil, 400, "INVALID_ARGUMENT"},
		{"deep group", deep, nil, 400, "INVALID_ARGUMENT"},
		{"too large", bytes.Repeat([]byte{1}, MaxFrameBytes+1), nil, 413, "RESOURCE_EXHAUSTED"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			reply := f.request(t, client, "Current", test.body, test.change)
			expectAuthStatus(t, reply, test.status, test.code)
			if bytes.Contains(reply.body, []byte("must-not-log")) || bytes.Contains(reply.body, []byte(session.CsrfToken)) {
				t.Fatal("error disclosed request secrets")
			}
		})
	}
}

func TestIdentityPreflightOnlyAllowsConfiguredHTTPSAudience(t *testing.T) {
	f := newAuthFixture(t)
	for _, test := range []struct {
		method, headers, origin string
		status                  int
	}{{"POST", "content-type, x-armadra-csrf", f.origin, 204}, {"DELETE", "content-type", f.origin, 403}, {"POST", "authorization", f.origin, 403}, {"POST", "content-type", "https://evil.example", 403}, {"POST", "content-type", "", 403}} {
		request := httptest.NewRequest("OPTIONS", f.origin+AuthPrefix+"Refresh", nil)
		request.TLS = &tls.ConnectionState{}
		request.Header.Set("Origin", test.origin)
		request.Header.Set("Access-Control-Request-Method", test.method)
		request.Header.Set("Access-Control-Request-Headers", test.headers)
		response := httptest.NewRecorder()
		f.handler.ServeHTTP(response, request)
		if response.Code != test.status {
			t.Fatalf("preflight status %d want %d", response.Code, test.status)
		}
		if response.Code == 204 && (response.Header().Get("Access-Control-Allow-Origin") != f.origin || response.Header().Get("Access-Control-Allow-Credentials") != "true" || response.Header().Get("Access-Control-Allow-Methods") != "POST") {
			t.Fatal("preflight broadened credential audience")
		}
		if len(response.Result().Cookies()) != 0 {
			t.Fatal("preflight issued cookies")
		}
	}
}
