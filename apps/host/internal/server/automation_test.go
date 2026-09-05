package server

import (
	"bytes"
	"net/http"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"google.golang.org/protobuf/proto"
)

func (f *authFixture) automation(t *testing.T, client *http.Client, action string, message proto.Message, csrf string) authReply {
	t.Helper()
	body := authWire(t, message)
	request, err := http.NewRequest("POST", f.origin+AutomationPrefix+action, bytes.NewReader(body))
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

func automationScopes() []auth.Scope {
	return []auth.Scope{
		{Permission: "automation:read", WorkspaceID: "workspace", ExecutionHostID: authHost},
		{Permission: "automation:manage", WorkspaceID: "workspace", ExecutionHostID: authHost},
	}
}
func scope(workspace string) *pb.CommandMeta {
	return &pb.CommandMeta{RequestId: "request-1", Scope: &pb.Scope{HostId: authHost, WorkspaceId: workspace, ExecutionHostId: authHost}}
}

// A Host started without an execution Worker must authenticate the caller and
// then say UNSUPPORTED. It must never answer an empty plan list, which would
// read as "no schedules" on a Host that simply cannot run any.
func TestAutomationWithoutAWorkerAuthenticatesThenReportsUnsupported(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", automationScopes())
	expectAuthStatus(t, f.automation(t, client, "ListPlans", &pb.ListAutomationPlansRequest{Meta: scope("workspace")}, ""), http.StatusNotImplemented, "UNSUPPORTED")
	expectAuthStatus(t, f.automation(t, client, "Define", &pb.DefineAutomationRequest{Meta: scope("workspace"), PlanId: "plan"}, session.CsrfToken), http.StatusNotImplemented, "UNSUPPORTED")
	anonymous := f.client(t)
	expectAuthStatus(t, f.automation(t, anonymous, "ListPlans", &pb.ListAutomationPlansRequest{Meta: scope("workspace")}, ""), http.StatusUnauthorized, "UNAUTHENTICATED")
	expectAuthStatus(t, f.automation(t, anonymous, "RunNow", &pb.RunAutomationNowRequest{Meta: scope("workspace"), PlanId: "plan"}, ""), http.StatusUnauthorized, "UNAUTHENTICATED")
}

func TestAutomationRequestsAreScopedToTheirWorkspaceAndHost(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", automationScopes())
	// A workspace the device was never granted must not be reachable.
	expectAuthStatus(t, f.automation(t, client, "ListPlans", &pb.ListAutomationPlansRequest{Meta: scope("another-workspace")}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// Another Host or execution host is refused, never treated as local.
	foreign := &pb.CommandMeta{RequestId: "request-2", Scope: &pb.Scope{HostId: "33333333333333333333333333333333", WorkspaceId: "workspace"}}
	expectAuthStatus(t, f.automation(t, client, "ListPlans", &pb.ListAutomationPlansRequest{Meta: foreign}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	elsewhere := &pb.CommandMeta{RequestId: "request-3", Scope: &pb.Scope{WorkspaceId: "workspace", ExecutionHostId: "33333333333333333333333333333333"}}
	expectAuthStatus(t, f.automation(t, client, "ListRuns", &pb.ListAutomationRunsRequest{Meta: elsewhere, PlanId: "plan"}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// An absent scope is an invalid request, not a host-wide read.
	expectAuthStatus(t, f.automation(t, client, "ListPlans", &pb.ListAutomationPlansRequest{}, ""), http.StatusBadRequest, "INVALID_ARGUMENT")
	// Every mutating method requires the rotating CSRF token.
	for _, action := range []struct {
		name    string
		message proto.Message
	}{
		{"DefineCommandSession", &pb.DefineCommandSessionRequest{Meta: scope("workspace"), SessionId: "command", RootPath: "/tmp"}},
		{"Define", &pb.DefineAutomationRequest{Meta: scope("workspace"), PlanId: "plan"}},
		{"Activate", &pb.ActivateAutomationRequest{Meta: scope("workspace"), PlanId: "plan"}},
		{"Pause", &pb.PauseAutomationRequest{Meta: scope("workspace"), PlanId: "plan"}},
		{"RunNow", &pb.RunAutomationNowRequest{Meta: scope("workspace"), PlanId: "plan"}},
	} {
		expectAuthStatus(t, f.automation(t, client, action.name, action.message, ""), http.StatusForbidden, "PERMISSION_DENIED")
		expectAuthStatus(t, f.automation(t, client, action.name, action.message, session.CsrfToken), http.StatusNotImplemented, "UNSUPPORTED")
	}
}

func TestReadOnlyAutomationGrantCannotManagePlans(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	session, _ := f.pair(t, client, "只读设备", []auth.Scope{{Permission: "automation:read", WorkspaceID: "workspace", ExecutionHostID: authHost}})
	expectAuthStatus(t, f.automation(t, client, "ListPlans", &pb.ListAutomationPlansRequest{Meta: scope("workspace")}, ""), http.StatusNotImplemented, "UNSUPPORTED")
	expectAuthStatus(t, f.automation(t, client, "Define", &pb.DefineAutomationRequest{Meta: scope("workspace"), PlanId: "plan"}, session.CsrfToken), http.StatusForbidden, "PERMISSION_DENIED")
	expectAuthStatus(t, f.automation(t, client, "RunNow", &pb.RunAutomationNowRequest{Meta: scope("workspace"), PlanId: "plan"}, session.CsrfToken), http.StatusForbidden, "PERMISSION_DENIED")
}

func TestUnknownAutomationMethodIsNotRouted(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	f.pair(t, client, "手机", automationScopes())
	expectAuthStatus(t, f.automation(t, client, "DeletePlan", &pb.PauseAutomationRequest{Meta: scope("workspace")}, ""), http.StatusNotFound, "NOT_FOUND")
	if automationMethod("/rpc/armadra.v1.IdentityService/Pair") || automationMethod(AutomationPrefix+"Unknown") || !automationMethod(AutomationPrefix+"ListRuns") {
		t.Fatal("automation routing accepted the wrong paths")
	}
}

// The Hello capability list must not promise scheduling on a Host that has no
// Worker; a client would otherwise show an automation surface that cannot run.
func TestHelloAdvertisesSchedulingOnlyWithAWorker(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	request, err := http.NewRequest("POST", f.origin+HelloPath, bytes.NewReader(authWire(t, &pb.HelloRequest{ClientId: "test", Protocol: &pb.ProtocolVersion{Major: 1, Minor: 1}})))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", f.origin)
	request.Header.Set("Content-Type", MediaType)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body := make([]byte, 4096)
	n, _ := response.Body.Read(body)
	hello := new(pb.HelloResponse)
	if err = proto.Unmarshal(body[:n], hello); err != nil {
		t.Fatal(err)
	}
	for _, capability := range hello.Capabilities {
		if capability == "automation.plans.v1" {
			t.Fatal("a Host without a Worker advertised scheduling")
		}
	}
}
