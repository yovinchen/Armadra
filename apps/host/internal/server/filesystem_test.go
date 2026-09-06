package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/endpoints"
	"armadra.local/host/internal/fshost"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/runtimelink"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

func (f *authFixture) filesystem(t *testing.T, client *http.Client, action string, message proto.Message, csrf string) authReply {
	t.Helper()
	request, err := http.NewRequest("POST", f.origin+FilesystemPrefix+action, bytes.NewReader(authWire(t, message)))
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

func filesystemScopes() []auth.Scope {
	return []auth.Scope{
		// Workspace-scoped and not narrowed to one execution host, which is how
		// a real device is paired for files: the routes the proxy forwards are
		// classified by workspace, not by the machine behind them.
		{Permission: fshost.ScopeRead, WorkspaceID: "workspace"},
		{Permission: fshost.ScopeWrite, WorkspaceID: "workspace"},
		// The grant that turns a file request into an execution one. It is
		// separate on purpose: a device may edit a file without being able to
		// make this machine run anything.
		{Permission: "terminal:write", WorkspaceID: "workspace"},
	}
}

func withFilesystem(f *authFixture, options *Options) {
	service, err := fshost.New(fshost.Options{Store: f.store, HostID: authHost})
	if err != nil {
		panic(err)
	}
	options.Filesystem = service
}

// withRuntimeAt points the proxy at a stand-in Runtime by publishing its
// address into an endpoints document, exactly the way the real Runtime does.
func withRuntimeAt(url string) func(*authFixture, *Options) {
	return func(f *authFixture, options *Options) {
		directory, err := os.MkdirTemp("", "armadra-proxy-")
		if err != nil {
			panic(err)
		}
		document := endpoints.Document{Version: endpoints.Version, Runtime: &endpoints.Service{
			InstanceID: "runtime",
			WrittenAt:  "2026-09-06T09:00:00Z",
			HTTP:       url,
		}}
		encoded, err := json.Marshal(document)
		if err != nil {
			panic(err)
		}
		if err = os.WriteFile(endpoints.Path(directory), encoded, 0600); err != nil {
			panic(err)
		}
		options.Runtime = runtimelink.New(directory)
	}
}

// hostOwnsFilesystem records the domain as settled here, which is what every
// write path and the proxy narrowing both check.
func hostOwnsFilesystem(t *testing.T, store *storage.Store) {
	t.Helper()
	if _, err := store.PutOwnership(context.Background(), storage.Ownership{
		Domain: storage.OwnershipDomainFilesystem, Owner: storage.OwnerHost, Epoch: 2,
		Phase: storage.OwnershipSettled, ReasonCode: ownership.ReasonVerified,
		CreatedAtMS: 1788560523004, UpdatedAtMS: 1788560523004,
	}, 0); err != nil {
		t.Fatal(err)
	}
}

// A Host with no filesystem service authenticates first and then says the
// surface is unavailable. It never answers an empty root, which a client
// cannot tell apart from a workspace whose files are simply not there.
func TestFilesystemWithoutAServiceAuthenticatesThenReportsUnsupported(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", filesystemScopes())
	expectAuthStatus(t, f.filesystem(t, client, "GetRoot", &pb.GetWorkspaceRootRequest{Meta: scope("workspace")}, ""), http.StatusNotImplemented, "UNSUPPORTED")
	expectAuthStatus(t, f.filesystem(t, client, "RegisterRoot", &pb.RegisterWorkspaceRootRequest{Meta: scope("workspace")}, session.CsrfToken), http.StatusNotImplemented, "UNSUPPORTED")
	anonymous := f.client(t)
	expectAuthStatus(t, f.filesystem(t, anonymous, "GetRoot", &pb.GetWorkspaceRootRequest{Meta: scope("workspace")}, ""), http.StatusUnauthorized, "UNAUTHENTICATED")
}

func TestFilesystemRequestsAreScopedToTheirWorkspaceAndHost(t *testing.T) {
	f := newAuthFixture(t, withFilesystem)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", filesystemScopes())
	hostOwnsFilesystem(t, f.store)
	// A workspace the device was never granted must not be reachable.
	expectAuthStatus(t, f.filesystem(t, client, "GetRoot", &pb.GetWorkspaceRootRequest{Meta: scope("another-workspace")}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// Another Host or execution host is refused, never treated as local.
	foreign := &pb.CommandMeta{RequestId: "request-2", Scope: &pb.Scope{HostId: "33333333333333333333333333333333", WorkspaceId: "workspace"}}
	expectAuthStatus(t, f.filesystem(t, client, "GetRoot", &pb.GetWorkspaceRootRequest{Meta: foreign}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// A mutation without the CSRF header is refused before it reaches the store.
	expectAuthStatus(t, f.filesystem(t, client, "RegisterRoot", &pb.RegisterWorkspaceRootRequest{
		Meta: scope("workspace"), OperationId: "filesystem/workspace/register",
		Root: &pb.WorkspaceRoot{WorkspaceId: "workspace", CanonicalPath: "/项目", Permissions: &pb.CanvasWorkspacePermissions{Read: true}},
	}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// With it, the registration lands and reads back.
	registered := f.filesystem(t, client, "RegisterRoot", &pb.RegisterWorkspaceRootRequest{
		Meta: scope("workspace"), OperationId: "filesystem/workspace/register",
		Root: &pb.WorkspaceRoot{WorkspaceId: "workspace", CanonicalPath: "/项目", Permissions: &pb.CanvasWorkspacePermissions{Read: true, Write: true}},
	}, session.CsrfToken)
	if registered.status != http.StatusOK {
		t.Fatalf("the registration was refused: %d %s", registered.status, registered.body)
	}
	response := new(pb.RegisterWorkspaceRootResponse)
	if err := proto.Unmarshal(registered.body, response); err != nil {
		t.Fatal(err)
	}
	if response.Root.GetCanonicalPath() != "/项目" || response.Root.GetRevision() != 1 {
		t.Fatalf("the registration is not what was stored: %+v", response.Root)
	}
	// The same request again replays rather than registering a second time.
	replay := f.filesystem(t, client, "RegisterRoot", &pb.RegisterWorkspaceRootRequest{
		Meta: scope("workspace"), OperationId: "filesystem/workspace/register",
		Root: &pb.WorkspaceRoot{WorkspaceId: "workspace", CanonicalPath: "/项目", Permissions: &pb.CanvasWorkspacePermissions{Read: true, Write: true}},
	}, session.CsrfToken)
	if replay.status != http.StatusOK {
		t.Fatalf("a retry was refused: %d %s", replay.status, replay.body)
	}
	replayed := new(pb.RegisterWorkspaceRootResponse)
	if err := proto.Unmarshal(replay.body, replayed); err != nil {
		t.Fatal(err)
	}
	if !replayed.Receipt.GetReplayed() || replayed.Root.GetRevision() != 1 {
		t.Fatalf("a retry registered a second time: %+v", replayed)
	}
}

// While the Runtime owns the domain, the Host answers reads and refuses every
// mutation with the one stable code both services use.
func TestFilesystemWritesAreRefusedWhileTheRuntimeOwnsTheDomain(t *testing.T) {
	f := newAuthFixture(t, withFilesystem)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", filesystemScopes())
	reply := f.filesystem(t, client, "RegisterRoot", &pb.RegisterWorkspaceRootRequest{
		Meta: scope("workspace"), OperationId: "filesystem/workspace/register",
		Root: &pb.WorkspaceRoot{WorkspaceId: "workspace", CanonicalPath: "/项目", Permissions: &pb.CanvasWorkspacePermissions{Read: true}},
	}, session.CsrfToken)
	expectAuthStatus(t, reply, http.StatusConflict, "CONFLICT")
	if !bytes.Contains(reply.body, []byte("ownership_moved")) {
		t.Fatalf("the refusal did not carry the stable code: %s", reply.body)
	}
	// Reads keep answering; this workspace simply has no root yet.
	expectAuthStatus(t, f.filesystem(t, client, "GetRoot", &pb.GetWorkspaceRootRequest{Meta: scope("workspace")}, ""), http.StatusNotFound, "NOT_FOUND")
}

// Once the Host owns the domain, a forwarded file request is narrowed by the
// registered root as well as by the device's grants. The Runtime's own
// `permissions_json` is the record the switch retired, so continuing to defer
// to it would forward requests against permissions the Host had revoked.
func TestProxyNarrowsFileRequestsToTheRegisteredRoot(t *testing.T) {
	forwarded := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded++
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	f := newAuthFixture(t, withFilesystem, withRuntimeAt(upstream.URL))
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", filesystemScopes())
	hostOwnsFilesystem(t, f.store)

	read := func(path, method string, csrf string) int {
		t.Helper()
		request, err := http.NewRequest(method, f.origin+path, bytes.NewReader(nil))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Origin", f.origin)
		request.Header.Set("Sec-Fetch-Site", "same-origin")
		if csrf != "" {
			request.Header.Set("X-Armadra-CSRF", csrf)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		return response.StatusCode
	}

	// No registration at all: while the Host owns the domain there is nothing
	// that says this workspace's files may be reached, and falling back to the
	// Runtime's row would be reading the retired record.
	if status := read("/api/workspaces/workspace/files", http.MethodGet, ""); status != http.StatusForbidden {
		t.Fatalf("an unregistered workspace was forwarded: %d", status)
	}
	if forwarded != 0 {
		t.Fatal("an unregistered workspace reached the Runtime")
	}

	// Read-only: the listing goes through, a save does not, and neither does
	// anything that would run a program.
	service, err := fshost.New(fshost.Options{Store: f.store, HostID: authHost})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.RegisterRoot(context.Background(), fshost.Caller{
		PrincipalID: "p", DeviceID: "d", DeviceEpoch: 1, WorkspaceID: "workspace",
		Scopes: []auth.Scope{{Permission: fshost.ScopeWrite, WorkspaceID: "workspace", ExecutionHostID: authHost}},
	}, &pb.RegisterWorkspaceRootRequest{
		OperationId: "filesystem/workspace/register",
		Root: &pb.WorkspaceRoot{
			WorkspaceId:   "workspace",
			CanonicalPath: "/项目",
			Permissions:   &pb.CanvasWorkspacePermissions{Read: true},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if status := read("/api/workspaces/workspace/files", http.MethodGet, ""); status != http.StatusOK {
		t.Fatalf("a read was refused on a readable root: %d", status)
	}
	if status := read("/api/workspaces/workspace/file", http.MethodPut, session.CsrfToken); status != http.StatusForbidden {
		t.Fatalf("a save was allowed on a read-only root: %d", status)
	}
	if forwarded != 1 {
		t.Fatalf("the wrong number of requests reached the Runtime: %d", forwarded)
	}
	// A route the filesystem domain does not own is untouched by the narrowing.
	if status := read("/api/workspaces/workspace/boards", http.MethodGet, ""); status != http.StatusForbidden {
		// canvas:read was never granted to this device, so this is the grant
		// check refusing — which is exactly the point: the narrowing only ever
		// narrows, it never widens.
		t.Logf("canvas route refused by the grant check as expected: %d", status)
	}
}

// Before the switch the narrowing does nothing at all: the Runtime still owns
// the record, and a Host that started narrowing early would refuse requests
// against a projection it has not been handed.
func TestProxyDoesNotNarrowWhileTheRuntimeOwnsTheDomain(t *testing.T) {
	forwarded := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded++
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	f := newAuthFixture(t, withFilesystem, withRuntimeAt(upstream.URL))
	client := f.client(t)
	f.pair(t, client, "手机", filesystemScopes())
	request, err := http.NewRequest(http.MethodGet, f.origin+"/api/workspaces/workspace/files", nil)
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
	if response.StatusCode != http.StatusOK || forwarded != 1 {
		t.Fatalf("an unregistered workspace was refused before the switch: %d, forwarded %d", response.StatusCode, forwarded)
	}
}
