package server

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/sessionhost"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

func (f *authFixture) session(t *testing.T, client *http.Client, action string, message proto.Message, csrf string) authReply {
	t.Helper()
	request, err := http.NewRequest("POST", f.origin+SessionPrefix+action, bytes.NewReader(authWire(t, message)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", f.origin)
	request.Header.Set("Content-Type", MediaType)
	if csrf != "" {
		request.Header.Set("X-Armadra-CSRF", csrf)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data := make([]byte, 0)
	buffer := make([]byte, 4096)
	for {
		n, readErr := response.Body.Read(buffer)
		data = append(data, buffer[:n]...)
		if readErr != nil {
			break
		}
	}
	return authReply{status: response.StatusCode, header: response.Header, body: data, cookies: response.Cookies()}
}

func sessionScopes() []auth.Scope {
	return []auth.Scope{
		{Permission: sessionhost.ScopeRead, WorkspaceID: "workspace"},
		{Permission: sessionhost.ScopeWrite, WorkspaceID: "workspace"},
	}
}

// terminalHostScopes is how a device that may attach to terminals is really
// paired. The Runtime's own `/api/terminals/{id}` routes name a session and not
// a workspace, so the grant that reaches them cannot be workspace-scoped — and
// that is exactly the gap the Host's second narrowing closes once it owns the
// session record.
func terminalHostScopes() []auth.Scope {
	return append(sessionScopes(), auth.Scope{Permission: sessionhost.ScopeRead}, auth.Scope{Permission: sessionhost.ScopeWrite})
}

func withSessions(f *authFixture, options *Options) {
	service, err := sessionhost.New(sessionhost.Options{Store: f.store, HostID: authHost})
	if err != nil {
		panic(err)
	}
	options.Sessions = service
}

// hostOwnsSessions records the domain as settled here, which is what every
// write path and the proxy narrowing both check.
func hostOwnsSessions(t *testing.T, store *storage.Store) {
	t.Helper()
	if _, err := store.PutOwnership(context.Background(), storage.Ownership{
		Domain: storage.OwnershipDomainSession, Owner: storage.OwnerHost, Epoch: 2,
		Phase: storage.OwnershipSettled, ReasonCode: ownership.ReasonVerified,
		CreatedAtMS: 1788560523004, UpdatedAtMS: 1788560523004,
	}, 0); err != nil {
		t.Fatal(err)
	}
}

// A Host with no session service authenticates first and then says the surface
// is unavailable. It never answers an empty listing, which a client cannot tell
// apart from a workspace whose terminals have all been closed — and would
// answer by offering to start one.
func TestSessionWithoutAServiceAuthenticatesThenReportsUnsupported(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", sessionScopes())
	expectAuthStatus(t, f.session(t, client, "List", &pb.ListSessionsRequest{Meta: scope("workspace")}, ""), http.StatusNotImplemented, "UNSUPPORTED")
	expectAuthStatus(t, f.session(t, client, "Create", &pb.CreateSessionRequest{Meta: scope("workspace")}, session.CsrfToken), http.StatusNotImplemented, "UNSUPPORTED")
	anonymous := f.client(t)
	expectAuthStatus(t, f.session(t, anonymous, "List", &pb.ListSessionsRequest{Meta: scope("workspace")}, ""), http.StatusUnauthorized, "UNAUTHENTICATED")
}

func TestSessionRequestsAreScopedToTheirWorkspaceAndHost(t *testing.T) {
	f := newAuthFixture(t, withSessions)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", sessionScopes())
	hostOwnsSessions(t, f.store)
	create := func(meta *pb.CommandMeta, csrf string) authReply {
		return f.session(t, client, "Create", &pb.CreateSessionRequest{
			Meta: meta, OperationId: "session/session-one/create",
			Session: &pb.Session{
				SessionId: "session-one", WorkspaceId: "workspace", SessionKey: "node-one",
				OwnerNodeId: "node-one", Kind: pb.SessionKind_SESSION_KIND_TERMINAL,
				Launch: &pb.SessionLaunch{Shell: "/bin/zsh", WorkingDirectory: "/项目"},
			},
		}, csrf)
	}
	// A workspace the device was never granted must not be reachable.
	expectAuthStatus(t, f.session(t, client, "List", &pb.ListSessionsRequest{Meta: scope("another-workspace")}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// Another Host or execution host is refused, never treated as local.
	foreign := &pb.CommandMeta{RequestId: "request-2", Scope: &pb.Scope{HostId: "33333333333333333333333333333333", WorkspaceId: "workspace"}}
	expectAuthStatus(t, f.session(t, client, "List", &pb.ListSessionsRequest{Meta: foreign}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// A mutation without the CSRF header is refused before it reaches the store.
	expectAuthStatus(t, create(scope("workspace"), ""), http.StatusForbidden, "PERMISSION_DENIED")

	created := create(scope("workspace"), session.CsrfToken)
	if created.status != http.StatusOK {
		t.Fatalf("the session was refused: %d %s", created.status, created.body)
	}
	response := new(pb.CreateSessionResponse)
	if err := proto.Unmarshal(created.body, response); err != nil {
		t.Fatal(err)
	}
	// Creating records intent and nothing more: the surface never starts a
	// program as a side effect of being asked whether one should exist.
	if response.Session.GetStatus() != pb.SessionStatus_SESSION_STATUS_PENDING || response.Session.GetRevision() != 1 {
		t.Fatalf("creating did not record a pending intent: %+v", response.Session)
	}
	// The same request again replays rather than recording a second session.
	replay := create(scope("workspace"), session.CsrfToken)
	replayed := new(pb.CreateSessionResponse)
	if err := proto.Unmarshal(replay.body, replayed); err != nil {
		t.Fatal(err)
	}
	if !replayed.Receipt.GetReplayed() || replayed.Session.GetRevision() != 1 {
		t.Fatalf("a retry recorded a second session: %+v", replayed)
	}
}

// A Host that has taken the domain but has no way to reach the execution host
// says so. Nothing was started and nothing was stopped, and a client draws
// "the machine is not reachable" rather than a failed session.
func TestStartingWithoutAReachableWorkerIsUnavailableNotFailed(t *testing.T) {
	f := newAuthFixture(t, withSessions)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", sessionScopes())
	hostOwnsSessions(t, f.store)
	created := f.session(t, client, "Create", &pb.CreateSessionRequest{
		Meta: scope("workspace"), OperationId: "session/session-one/create",
		Session: &pb.Session{
			SessionId: "session-one", WorkspaceId: "workspace", SessionKey: "node-one",
			Kind:   pb.SessionKind_SESSION_KIND_TERMINAL,
			Launch: &pb.SessionLaunch{Shell: "/bin/zsh", WorkingDirectory: "/项目"},
		},
	}, session.CsrfToken)
	if created.status != http.StatusOK {
		t.Fatalf("the session was refused: %d %s", created.status, created.body)
	}
	expectAuthStatus(t, f.session(t, client, "Start", &pb.StartSessionRequest{
		Meta: scope("workspace"), OperationId: "session/session-one/start",
		ExpectedRevision: 1, SessionId: "session-one",
	}, session.CsrfToken), http.StatusServiceUnavailable, "UNAVAILABLE")
	// And the record is untouched: nothing was started, so nothing is running.
	got := f.session(t, client, "Get", &pb.GetSessionRequest{Meta: scope("workspace"), SessionId: "session-one"}, "")
	response := new(pb.GetSessionResponse)
	if err := proto.Unmarshal(got.body, response); err != nil {
		t.Fatal(err)
	}
	if response.Session.GetStatus() != pb.SessionStatus_SESSION_STATUS_PENDING {
		t.Fatalf("an unreachable start changed the record: %v", response.Session.GetStatus())
	}
}

// While the Runtime owns the domain, the Host answers reads and refuses every
// mutation with the one stable code both services use.
func TestSessionWritesAreRefusedWhileTheRuntimeOwnsTheDomain(t *testing.T) {
	f := newAuthFixture(t, withSessions)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", sessionScopes())
	reply := f.session(t, client, "Create", &pb.CreateSessionRequest{
		Meta: scope("workspace"), OperationId: "session/session-one/create",
		Session: &pb.Session{
			SessionId: "session-one", WorkspaceId: "workspace", SessionKey: "node-one",
			Kind:   pb.SessionKind_SESSION_KIND_TERMINAL,
			Launch: &pb.SessionLaunch{Shell: "/bin/zsh", WorkingDirectory: "/项目"},
		},
	}, session.CsrfToken)
	expectAuthStatus(t, reply, http.StatusConflict, "CONFLICT")
	if !bytes.Contains(reply.body, []byte("ownership_moved")) {
		t.Fatalf("the refusal is not the one a client acts on: %s", reply.body)
	}
	// The read keeps answering, which is what lets a client show sessions the
	// Host does not yet decide about.
	listed := f.session(t, client, "List", &pb.ListSessionsRequest{Meta: scope("workspace")}, "")
	if listed.status != http.StatusOK {
		t.Fatalf("a read failed while the Runtime owns the domain: %d %s", listed.status, listed.body)
	}
}

// The terminal WebSocket path and its frames do not change; what changes is who
// decides whether the session being attached to exists. Once the Host owns the
// domain a forwarded attach is checked against the Host's record, not the
// Runtime's row — which is the row the switch just retired.
func TestTerminalProxyNarrowsAgainstTheHostsSessionRecord(t *testing.T) {
	forwarded := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		forwarded++
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	f := newAuthFixture(t, withSessions, withRuntimeAt(upstream.URL))
	client := f.client(t)
	f.pair(t, client, "手机", terminalHostScopes())

	read := func(path string) int {
		t.Helper()
		request, err := http.NewRequest(http.MethodGet, f.origin+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Origin", f.origin)
		request.Header.Set("Sec-Fetch-Site", "same-origin")
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		return response.StatusCode
	}

	// While the Runtime owns the domain, nothing is narrowed: the Runtime's own
	// row is still the record, and refusing here would break a session the
	// switch has not touched.
	if status := read("/api/terminals/session-one"); status != http.StatusOK || forwarded != 1 {
		t.Fatalf("a request was narrowed before the switch: %d forwarded=%d", status, forwarded)
	}

	hostOwnsSessions(t, f.store)
	// Now a session this Host has no record of is one nobody may attach to
	// through it. Falling back to the Runtime's row would be reading the record
	// the switch retired.
	if status := read("/api/terminals/session-one"); status != http.StatusForbidden || forwarded != 1 {
		t.Fatalf("an unrecorded session was forwarded after the switch: %d forwarded=%d", status, forwarded)
	}
	// A route that names no session — the backend probe — is untouched by the
	// narrowing, because there is no session record for it to be checked
	// against.
	if status := read("/api/terminals/backend"); status != http.StatusOK || forwarded != 2 {
		t.Fatalf("a session-free terminal route was narrowed: %d forwarded=%d", status, forwarded)
	}
}
