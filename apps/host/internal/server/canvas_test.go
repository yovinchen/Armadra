package server

import (
	"bytes"
	"net/http"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/canvashost"
	auth "armadra.local/host/internal/identity"
	"google.golang.org/protobuf/proto"
)

func (f *authFixture) canvas(t *testing.T, client *http.Client, action string, message proto.Message, csrf string) authReply {
	t.Helper()
	request, err := http.NewRequest("POST", f.origin+CanvasPrefix+action, bytes.NewReader(authWire(t, message)))
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

func canvasScopes() []auth.Scope {
	return []auth.Scope{
		{Permission: "canvas:read", WorkspaceID: "workspace", ExecutionHostID: authHost},
		{Permission: "canvas:write", WorkspaceID: "workspace", ExecutionHostID: authHost},
	}
}

func withCanvas(f *authFixture, options *Options) {
	service, err := canvashost.New(canvashost.Options{Store: f.store, HostID: authHost})
	if err != nil {
		panic(err)
	}
	options.Canvas = service
}

// A Host with no canvas service authenticates first and then says the surface
// is unavailable. It never answers an empty workspace, which a client cannot
// tell apart from a project that really has no canvases.
func TestCanvasWithoutAServiceAuthenticatesThenReportsUnsupported(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", canvasScopes())
	expectAuthStatus(t, f.canvas(t, client, "ListCanvases", &pb.ListCanvasesRequest{Meta: scope("workspace")}, ""), http.StatusNotImplemented, "UNSUPPORTED")
	expectAuthStatus(t, f.canvas(t, client, "SaveDocument", &pb.SaveCanvasDocumentRequest{Meta: scope("workspace")}, session.CsrfToken), http.StatusNotImplemented, "UNSUPPORTED")
	anonymous := f.client(t)
	expectAuthStatus(t, f.canvas(t, anonymous, "ListCanvases", &pb.ListCanvasesRequest{Meta: scope("workspace")}, ""), http.StatusUnauthorized, "UNAUTHENTICATED")
}

func TestCanvasRequestsAreScopedToTheirWorkspaceAndHost(t *testing.T) {
	f := newAuthFixture(t, withCanvas)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", canvasScopes())
	// A workspace the device was never granted must not be reachable.
	expectAuthStatus(t, f.canvas(t, client, "ListCanvases", &pb.ListCanvasesRequest{Meta: scope("another-workspace")}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// Another Host or execution host is refused, never treated as local.
	foreign := &pb.CommandMeta{RequestId: "request-2", Scope: &pb.Scope{HostId: "33333333333333333333333333333333", WorkspaceId: "workspace"}}
	expectAuthStatus(t, f.canvas(t, client, "ListCanvases", &pb.ListCanvasesRequest{Meta: foreign}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	elsewhere := &pb.CommandMeta{RequestId: "request-3", Scope: &pb.Scope{WorkspaceId: "workspace", ExecutionHostId: "33333333333333333333333333333333"}}
	expectAuthStatus(t, f.canvas(t, client, "GetOwnership", &pb.GetCanvasOwnershipRequest{Meta: elsewhere}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// An absent scope is an invalid request, not a host-wide read.
	expectAuthStatus(t, f.canvas(t, client, "ListCanvases", &pb.ListCanvasesRequest{}, ""), http.StatusBadRequest, "INVALID_ARGUMENT")
	// Every mutation requires the rotating CSRF token.
	for _, action := range []struct {
		name    string
		message proto.Message
	}{
		{"SaveDocument", &pb.SaveCanvasDocumentRequest{Meta: scope("workspace"), OperationId: "save", Canvas: &pb.Canvas{CanvasId: "canvas-1", WorkspaceId: "workspace"}}},
		{"DeleteCanvas", &pb.DeleteCanvasRequest{Meta: scope("workspace"), OperationId: "delete", CanvasId: "canvas-1"}},
		{"PutWorkspace", &pb.PutCanvasWorkspaceRequest{Meta: scope("workspace"), OperationId: "put", Workspace: &pb.CanvasWorkspace{WorkspaceId: "workspace"}}},
	} {
		expectAuthStatus(t, f.canvas(t, client, action.name, action.message, ""), http.StatusForbidden, "PERMISSION_DENIED")
	}
	// With the token, the same mutations reach the service and are refused
	// there for the right reason: this Host does not own canvas writes yet.
	expectAuthStatus(t, f.canvas(t, client, "SaveDocument", &pb.SaveCanvasDocumentRequest{Meta: scope("workspace"), OperationId: "save", Canvas: &pb.Canvas{CanvasId: "canvas-1", WorkspaceId: "workspace"}}, session.CsrfToken), http.StatusConflict, "CONFLICT")
}

// Reads keep working while the Runtime owns writes; that read-only fallback is
// the whole reason the Host serves this surface before the switch.
func TestCanvasReadsAnswerWhileTheRuntimeOwnsWrites(t *testing.T) {
	f := newAuthFixture(t, withCanvas)
	client := f.client(t)
	f.pair(t, client, "手机", canvasScopes())
	reply := f.canvas(t, client, "GetOwnership", &pb.GetCanvasOwnershipRequest{Meta: scope("workspace")}, "")
	if reply.status != http.StatusOK {
		t.Fatalf("ownership read failed with %d", reply.status)
	}
	result := new(pb.CanvasOwnershipResponse)
	if err := proto.Unmarshal(reply.body, result); err != nil {
		t.Fatal(err)
	}
	if result.Ownership.GetOwner() != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME {
		t.Fatalf("a Host that never switched claimed ownership: %v", result.Ownership)
	}
	if result.Ownership.GetPhase() != pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_SETTLED {
		t.Fatalf("an untouched Host reported an open maintenance window: %v", result.Ownership)
	}
	if f.canvas(t, client, "ListCanvases", &pb.ListCanvasesRequest{Meta: scope("workspace")}, "").status != http.StatusOK {
		t.Fatal("a canvas listing was refused while the Runtime owned writes")
	}
}

// The capability is advertised only when the surface is actually assembled.
func TestHelloAdvertisesTheCanvasSurfaceOnlyWhenAssembled(t *testing.T) {
	bare := newAuthFixture(t)
	if hasCapability(helloCapabilities(t, bare), "canvas.documents.v1") {
		t.Fatal("a Host with no canvas service advertised one")
	}
	assembled := newAuthFixture(t, withCanvas)
	if !hasCapability(helloCapabilities(t, assembled), "canvas.documents.v1") {
		t.Fatal("an assembled canvas service was not advertised")
	}
}
