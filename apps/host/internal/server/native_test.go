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
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const (
	nativeOrigin  = "tauri://localhost"
	browserOrigin = "http://127.0.0.1:1420"
)

// nativeFixture is the desktop shape: a plain loopback listener whose
// allowlist names the shell's origin and a browser development origin.
type nativeFixture struct {
	identity *auth.Service
	server   *httptest.Server
}

func newNativeFixture(t *testing.T, origins ...string) *nativeFixture {
	t.Helper()
	store, err := storage.Open(t.TempDir(), authHost)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	identity, err := auth.New(store, auth.Config{InstanceID: authInstance})
	if err != nil {
		t.Fatal(err)
	}
	if origins == nil {
		origins = []string{nativeOrigin, browserOrigin}
	}
	handler, err := NewHandlerWithOptions(Identity{HostID: authHost, InstanceID: authInstance}, Options{Identity: identity, AllowedOrigins: origins})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return &nativeFixture{identity: identity, server: server}
}

func (f *nativeFixture) ticket(t *testing.T, origin string) string {
	t.Helper()
	issued, err := f.identity.IssueBootstrap(context.Background(), auth.BootstrapRequest{HostID: authHost, InstanceID: authInstance, Origin: origin, DeviceName: "本机桌面", Scopes: []auth.Scope{{Permission: "identity:read"}, {Permission: "identity:manage"}}})
	if err != nil {
		t.Fatal(err)
	}
	return issued.Ticket
}

type nativeReply struct {
	status  int
	header  http.Header
	body    []byte
	session *pb.AuthenticatedSession
}

// post sends one authenticated-surface request. `bearer` is the token the
// native transport presents; `csrf` the session-bound header a mutation needs.
func (f *nativeFixture) post(t *testing.T, origin, action string, message proto.Message, bearer, csrf string, change ...func(*http.Request)) nativeReply {
	t.Helper()
	body := authWire(t, message)
	request, err := http.NewRequest("POST", f.server.URL+AuthPrefix+action, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", origin)
	request.Header.Set("Content-Type", MediaType)
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	if csrf != "" {
		request.Header.Set("X-Armadra-CSRF", csrf)
	}
	for _, edit := range change {
		edit(request)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	reply := nativeReply{status: response.StatusCode, header: response.Header, body: data}
	if response.StatusCode == 200 && (action == "Pair" || action == "Refresh" || action == "Current") {
		reply.session = new(pb.AuthenticatedSession)
		if err := proto.Unmarshal(data, reply.session); err != nil {
			t.Fatal(err)
		}
	}
	return reply
}

func expectNativeStatus(t *testing.T, reply nativeReply, status int, code string) {
	t.Helper()
	if reply.status != status {
		t.Fatalf("status %d, want %d (%s)", reply.status, status, reply.body)
	}
	if code != "" {
		failure := new(pb.ErrorResponse)
		if err := proto.Unmarshal(reply.body, failure); err != nil || failure.Code != code {
			t.Fatalf("code %q, want %q", failure.Code, code)
		}
	}
}

func (f *nativeFixture) hello(t *testing.T, origin string) *pb.HelloResponse {
	t.Helper()
	request, _ := http.NewRequest("POST", f.server.URL+HelloPath, bytes.NewReader(helloBytes(t, 1, ProtocolMinor)))
	request.Header.Set("Origin", origin)
	request.Header.Set("Content-Type", MediaType)
	response, err := f.server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	if response.StatusCode != 200 {
		t.Fatalf("hello from %s: %d %s", origin, response.StatusCode, data)
	}
	result := new(pb.HelloResponse)
	if err := proto.Unmarshal(data, result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestNativeSessionIsAdvertisedOnlyToTheShellOrigin(t *testing.T) {
	f := newNativeFixture(t)
	if !hasCapability(f.hello(t, nativeOrigin).Capabilities, "identity.native-session.v1") {
		t.Fatal("native origin was not offered the native session")
	}
	for _, hello := range []*pb.HelloResponse{f.hello(t, browserOrigin), f.hello(t, "")} {
		if hasCapability(hello.Capabilities, "identity.native-session.v1") || hasCapability(hello.Capabilities, "identity.browser-session.v1") {
			t.Fatalf("plain HTTP advertised a session to a non-native origin: %v", hello.Capabilities)
		}
	}
	// The HTTPS shape keeps advertising the browser session and never the
	// native one, even to an allowlisted Tauri origin.
	secure := newAuthFixture(t, func(_ *authFixture, options *Options) { options.AllowedOrigins = []string{nativeOrigin} })
	request, _ := http.NewRequest("POST", secure.origin+HelloPath, bytes.NewReader(helloBytes(t, 1, ProtocolMinor)))
	request.Header.Set("Origin", nativeOrigin)
	request.Header.Set("Content-Type", MediaType)
	response, err := secure.server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	hello := new(pb.HelloResponse)
	if err := proto.Unmarshal(data, hello); err != nil {
		t.Fatal(err)
	}
	if hasCapability(hello.Capabilities, "identity.native-session.v1") {
		t.Fatal("HTTPS Host advertised the native session")
	}
}

func TestNativeSessionPairsWithBearerAndRefusesEveryOtherCombination(t *testing.T) {
	f := newNativeFixture(t)
	ticket := f.ticket(t, nativeOrigin)
	pair := &pb.PairDeviceRequest{ExpectedHostId: authHost, ExpectedInstanceId: authInstance, Ticket: ticket}
	// A browser origin, even an allowlisted one, cannot spend the shell's
	// ticket: the gate refuses before the identity service sees it.
	expectNativeStatus(t, f.post(t, browserOrigin, "Pair", pair, "", ""), 403, "PERMISSION_DENIED")
	// A native origin the operator did not allow is a plain cross-origin
	// request, refused like any other.
	other := newNativeFixture(t, browserOrigin)
	otherTicket := other.ticket(t, nativeOrigin)
	expectNativeStatus(t, other.post(t, nativeOrigin, "Pair", &pb.PairDeviceRequest{ExpectedHostId: authHost, ExpectedInstanceId: authInstance, Ticket: otherTicket}, "", ""), 403, "PERMISSION_DENIED")

	reply := f.post(t, nativeOrigin, "Pair", pair, "", "")
	expectNativeStatus(t, reply, 200, "")
	if len(reply.header.Values("Set-Cookie")) != 0 {
		t.Fatal("native pairing set cookies")
	}
	if reply.header.Get("Access-Control-Allow-Origin") != nativeOrigin || reply.header.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("unexpected CORS headers: %v", reply.header)
	}
	session := reply.session
	if session.Native == nil || session.Native.AccessToken == "" || session.Native.RefreshToken == "" || session.CsrfToken == "" || session.Device.GetDisplayName() != "本机桌面" {
		t.Fatal("native pairing did not return bearer credentials")
	}
	if session.Native.AccessToken == session.Native.RefreshToken || strings.Contains(string(reply.body), ticket) {
		t.Fatal("native credentials are not distinct secrets")
	}
	// The ticket was consumed: a replay from the same origin is refused.
	expectNativeStatus(t, f.post(t, nativeOrigin, "Pair", pair, "", ""), 401, "UNAUTHENTICATED")

	access, refresh, csrf := session.Native.AccessToken, session.Native.RefreshToken, session.CsrfToken
	current := &pb.CurrentSessionRequest{}
	reply = f.post(t, nativeOrigin, "Current", current, access, "")
	expectNativeStatus(t, reply, 200, "")
	if reply.session.Native != nil || reply.session.CsrfToken != "" {
		t.Fatal("Current leaked credentials")
	}
	// Without a bearer, with the wrong secret, with a repeated header, or
	// with the cookie spelling of the same secret, nothing authenticates.
	expectNativeStatus(t, f.post(t, nativeOrigin, "Current", current, "", ""), 401, "UNAUTHENTICATED")
	expectNativeStatus(t, f.post(t, nativeOrigin, "Current", current, refresh, ""), 401, "UNAUTHENTICATED")
	expectNativeStatus(t, f.post(t, nativeOrigin, "Current", current, access, "", func(r *http.Request) {
		r.Header.Add("Authorization", "Bearer "+access)
	}), 401, "UNAUTHENTICATED")
	expectNativeStatus(t, f.post(t, nativeOrigin, "Current", current, "", "", func(r *http.Request) {
		r.Header.Set("Authorization", "Basic "+access)
	}), 401, "UNAUTHENTICATED")
	expectNativeStatus(t, f.post(t, nativeOrigin, "Current", current, "", "", func(r *http.Request) {
		r.AddCookie(&http.Cookie{Name: cookieName(authHost, false, "access"), Value: access})
	}), 401, "UNAUTHENTICATED")
	// The bearer is bound to the native origin: a browser origin presenting
	// it is stopped at the gate, and never reaches the session table.
	expectNativeStatus(t, f.post(t, browserOrigin, "Current", current, access, ""), 403, "PERMISSION_DENIED")

	// A permissioned method answers the bearer session.
	reply = f.post(t, nativeOrigin, "ListDevices", &pb.ListDevicesRequest{}, access, "")
	expectNativeStatus(t, reply, 200, "")
	devices := new(pb.ListDevicesResponse)
	if err := proto.Unmarshal(reply.body, devices); err != nil || len(devices.Devices) != 1 || devices.Devices[0].DisplayName != "本机桌面" {
		t.Fatalf("device listing failed: %v %v", err, devices)
	}

	// Refresh rotates every secret and returns the new pair in the body; the
	// spent refresh and the old access are dead afterwards.
	reply = f.post(t, nativeOrigin, "Refresh", &pb.RefreshSessionRequest{}, refresh, csrf)
	expectNativeStatus(t, reply, 200, "")
	rotated := reply.session
	if rotated.Native == nil || rotated.Native.AccessToken == access || rotated.Native.RefreshToken == refresh || rotated.CsrfToken == csrf {
		t.Fatal("refresh did not rotate the native credentials")
	}
	if len(reply.header.Values("Set-Cookie")) != 0 {
		t.Fatal("native refresh set cookies")
	}
	expectNativeStatus(t, f.post(t, nativeOrigin, "Current", current, access, ""), 401, "UNAUTHENTICATED")
	expectNativeStatus(t, f.post(t, nativeOrigin, "Refresh", &pb.RefreshSessionRequest{}, refresh, csrf), 401, "UNAUTHENTICATED")
	expectNativeStatus(t, f.post(t, nativeOrigin, "Current", current, rotated.Native.AccessToken, ""), 200, "")

	// A mutation still needs the session-bound CSRF header.
	revoke := &pb.RevokeDeviceRequest{DeviceId: devices.Devices[0].DeviceId, ExpectedRevision: 1}
	expectNativeStatus(t, f.post(t, nativeOrigin, "RevokeDevice", revoke, rotated.Native.AccessToken, ""), 403, "PERMISSION_DENIED")

	// Logout takes the refresh bearer plus CSRF, and ends the session.
	reply = f.post(t, nativeOrigin, "Logout", &pb.LogoutSessionRequest{}, rotated.Native.RefreshToken, rotated.CsrfToken)
	expectNativeStatus(t, reply, 200, "")
	if len(reply.header.Values("Set-Cookie")) != 0 {
		t.Fatal("native logout touched cookies")
	}
	expectNativeStatus(t, f.post(t, nativeOrigin, "Current", current, rotated.Native.AccessToken, ""), 401, "UNAUTHENTICATED")
}

func TestNativePreflightAllowsAuthorizationOnlyForTheShell(t *testing.T) {
	f := newNativeFixture(t)
	preflight := func(origin, headers string) *http.Response {
		t.Helper()
		request, _ := http.NewRequest("OPTIONS", f.server.URL+AuthPrefix+"Pair", nil)
		request.Header.Set("Origin", origin)
		request.Header.Set("Access-Control-Request-Method", "POST")
		request.Header.Set("Access-Control-Request-Headers", headers)
		response, err := f.server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()
		return response
	}
	response := preflight(nativeOrigin, "content-type, authorization, x-armadra-csrf")
	if response.StatusCode != 204 || response.Header.Get("Access-Control-Allow-Origin") != nativeOrigin || response.Header.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("native preflight refused: %d %v", response.StatusCode, response.Header)
	}
	if !strings.Contains(strings.ToLower(response.Header.Get("Access-Control-Allow-Headers")), "authorization") {
		t.Fatal("native preflight did not allow the bearer header")
	}
	if response = preflight(browserOrigin, "content-type"); response.StatusCode != 403 {
		t.Fatal("browser origin reached the authenticated surface over plain HTTP")
	}
	// On the HTTPS shape the same-origin browser page may not send a bearer.
	secure := newAuthFixture(t)
	request, _ := http.NewRequest("OPTIONS", secure.origin+AuthPrefix+"Pair", nil)
	request.Header.Set("Origin", secure.origin)
	request.Header.Set("Access-Control-Request-Method", "POST")
	request.Header.Set("Access-Control-Request-Headers", "content-type, authorization")
	response, err := secure.server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("browser preflight was allowed to send a bearer")
	}
}

func TestSecureHostIgnoresBearerAndKeepsCookies(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	reply := f.post(t, client, "Pair", f.ticket(t, "浏览器", []auth.Scope{{Permission: "identity:read"}}), "")
	if reply.status != 200 {
		t.Fatalf("pair: %d", reply.status)
	}
	session := new(pb.AuthenticatedSession)
	if err := proto.Unmarshal(reply.body, session); err != nil {
		t.Fatal(err)
	}
	if session.Native != nil {
		t.Fatal("browser pairing returned bearer credentials")
	}
	// A bearer on the cookie transport is neither honoured nor fatal: the
	// cookies decide, exactly as before.
	reply = f.request(t, client, "Current", authWire(t, &pb.CurrentSessionRequest{}), func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer "+strings.Repeat("0", 32)+"."+strings.Repeat("A", 43))
	})
	if reply.status != 200 {
		t.Fatalf("cookie session was not restored beside a stray bearer: %d", reply.status)
	}
	if !strings.Contains(strings.ToLower(f.request(t, client, "Current", authWire(t, &pb.CurrentSessionRequest{}), nil).header.Get("Access-Control-Allow-Credentials")), "true") {
		t.Fatal("browser transport lost credentialed CORS")
	}
}

func TestBearerCredentialParsing(t *testing.T) {
	for _, tc := range []struct {
		values []string
		want   string
	}{
		{nil, ""},
		{[]string{"Bearer abc"}, "abc"},
		{[]string{"bearer abc"}, "abc"},
		{[]string{"Bearer  abc "}, "abc"},
		{[]string{"Basic abc"}, ""},
		{[]string{"Bearer"}, ""},
		{[]string{"Bearer "}, ""},
		{[]string{"Bearer a b"}, ""},
		{[]string{"Bearer a", "Bearer b"}, ""},
	} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:43121/", nil)
		for _, value := range tc.values {
			r.Header.Add("Authorization", value)
		}
		if got := bearerCredential(r); got != tc.want {
			t.Errorf("%v: got %q, want %q", tc.values, got, tc.want)
		}
	}
}
