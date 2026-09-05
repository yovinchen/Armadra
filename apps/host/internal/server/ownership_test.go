package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/canvashost"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

func (f *authFixture) ownership(t *testing.T, client *http.Client, action string, message proto.Message, csrf string) authReply {
	t.Helper()
	request, err := http.NewRequest("POST", f.origin+OwnershipPrefix+action, bytes.NewReader(authWire(t, message)))
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
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return authReply{status: response.StatusCode, header: response.Header, body: body, cookies: response.Cookies()}
}

// Host-wide grants: the ownership record covers this machine, not a workspace.
func ownershipScopes() []auth.Scope {
	return []auth.Scope{{Permission: ScopeOwnershipRead}, {Permission: ScopeOwnershipWrite}}
}

// stubRuntime is the other side of a handoff that never has to be reached in
// these tests: every request here is refused before the epoch would move.
type stubRuntime struct{}

func (stubRuntime) GetWriteOwnership(context.Context, string) (*pb.WorkerWriteOwnership, error) {
	return nil, errors.New("no Runtime in this test")
}

func (stubRuntime) SetWriteOwnership(context.Context, string, pb.CanvasOwnershipOwner, uint64, uint64, string) (*pb.WorkerWriteOwnership, error) {
	return nil, errors.New("no Runtime in this test")
}

// withOwnership assembles the surface and hands the caller the same service the
// handler serves, so a test can mint a maintenance token exactly as the local
// control channel does.
func withOwnership(assembled ...**ownership.Service) func(*authFixture, *Options) {
	return func(f *authFixture, options *Options) {
		canvases, err := canvashost.New(canvashost.Options{Store: f.store, HostID: authHost})
		if err != nil {
			panic(err)
		}
		service, err := ownership.New(ownership.Options{
			Store:      f.store,
			InstanceID: authInstance,
			Projectors: map[string]ownership.Projector{canvashost.Domain: canvases.AsProjector()},
		})
		if err != nil {
			panic(err)
		}
		options.Ownership = service
		options.OpenHandoff = func(context.Context) (ownership.Handoff, io.Closer, error) {
			return stubRuntime{}, io.NopCloser(bytes.NewReader(nil)), nil
		}
		for _, out := range assembled {
			*out = service
		}
	}
}

// A Host with no ownership service authenticates first, then says the surface
// is not here. It never answers an empty list, which a client would read as
// "no domain has an owner".
func TestOwnershipWithoutAServiceAuthenticatesThenReportsUnsupported(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", ownershipScopes())
	expectAuthStatus(t, f.ownership(t, client, "List", &pb.ListOwnershipRequest{Meta: scope("workspace")}, ""), http.StatusNotImplemented, "UNSUPPORTED")
	expectAuthStatus(t, f.ownership(t, client, "Switch", &pb.SwitchOwnershipRequest{
		Meta: scope("workspace"),
		Plan: &pb.OwnershipSwitchPlan{Domain: pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_CANVAS, TargetOwner: pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST},
	}, session.CsrfToken), http.StatusNotImplemented, "UNSUPPORTED")
	anonymous := f.client(t)
	expectAuthStatus(t, f.ownership(t, anonymous, "List", &pb.ListOwnershipRequest{Meta: scope("workspace")}, ""), http.StatusUnauthorized, "UNAUTHENTICATED")
}

// Every domain is listed, in switch order, whether or not it was ever recorded.
func TestOwnershipListsEveryDomainForAnAuthorizedDevice(t *testing.T) {
	f := newAuthFixture(t, withOwnership())
	client := f.client(t)
	f.pair(t, client, "手机", ownershipScopes())
	reply := f.ownership(t, client, "List", &pb.ListOwnershipRequest{Meta: scope("workspace")}, "")
	expectAuthStatus(t, reply, http.StatusOK, "")
	response := new(pb.ListOwnershipResponse)
	if err := proto.Unmarshal(reply.body, response); err != nil {
		t.Fatal(err)
	}
	if len(response.Ownership) != len(storage.OwnershipDomains) {
		t.Fatalf("listed %d domains", len(response.Ownership))
	}
	for _, record := range response.Ownership {
		if record.Owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME || record.Phase != pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_SETTLED {
			t.Fatalf("%v was reported as %v/%v", record.Domain, record.Owner, record.Phase)
		}
	}
	// One domain reads the same record the list did.
	single := f.ownership(t, client, "Get", &pb.GetOwnershipRequest{Meta: scope("workspace"), Domain: pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_AGENT}, "")
	expectAuthStatus(t, single, http.StatusOK, "")
	record := new(pb.GetOwnershipResponse)
	if err := proto.Unmarshal(single.body, record); err != nil {
		t.Fatal(err)
	}
	if record.Ownership.Domain != pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_AGENT || record.Ownership.Epoch != 1 {
		t.Fatalf("the agent domain read back as %v", record.Ownership)
	}
	// An unspecified domain is refused rather than read as the canvas.
	expectAuthStatus(t, f.ownership(t, client, "Get", &pb.GetOwnershipRequest{Meta: scope("workspace")}, ""), http.StatusBadRequest, "INVALID_ARGUMENT")
}

// A device granted only one workspace cannot read or move ownership: the
// requirement is host-wide, and a workspace-shaped grant does not satisfy it.
func TestOwnershipRefusesWorkspaceOnlyGrants(t *testing.T) {
	f := newAuthFixture(t, withOwnership())
	client := f.client(t)
	session, _ := f.pair(t, client, "平板", []auth.Scope{
		{Permission: ScopeOwnershipRead, WorkspaceID: "workspace", ExecutionHostID: authHost},
		{Permission: ScopeOwnershipWrite, WorkspaceID: "workspace", ExecutionHostID: authHost},
	})
	expectAuthStatus(t, f.ownership(t, client, "List", &pb.ListOwnershipRequest{Meta: scope("workspace")}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	expectAuthStatus(t, f.ownership(t, client, "Switch", &pb.SwitchOwnershipRequest{
		Meta: scope("workspace"),
		Plan: &pb.OwnershipSwitchPlan{Domain: pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_CANVAS, TargetOwner: pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST, MaintenanceToken: "irrelevant"},
	}, session.CsrfToken), http.StatusForbidden, "PERMISSION_DENIED")
}

// Moving a domain needs the CSRF header and a maintenance token that was issued
// at the machine. Neither is optional, and a missing token is refused before
// anything is read or written.
func TestOwnershipSwitchNeedsCsrfAndAMaintenanceToken(t *testing.T) {
	f := newAuthFixture(t, withOwnership())
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", ownershipScopes())
	plan := &pb.OwnershipSwitchPlan{
		Domain:      pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_CANVAS,
		TargetOwner: pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST,
		ImportId:    "import-1",
	}
	// No CSRF header: a page must not be able to start a switch on its own.
	expectAuthStatus(t, f.ownership(t, client, "Switch", &pb.SwitchOwnershipRequest{Meta: scope("workspace"), Plan: plan}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// CSRF but no token: the window was never opened at the machine.
	reply := f.ownership(t, client, "Switch", &pb.SwitchOwnershipRequest{Meta: scope("workspace"), Plan: plan}, session.CsrfToken)
	expectAuthStatus(t, reply, http.StatusBadRequest, "INVALID_ARGUMENT")
	// A token that was never issued is refused with the reason key a client
	// renders: go back to the machine and ask for a window.
	withToken := proto.Clone(plan).(*pb.OwnershipSwitchPlan)
	withToken.MaintenanceToken = "0123456789abcdef"
	denied := f.ownership(t, client, "Switch", &pb.SwitchOwnershipRequest{Meta: scope("workspace"), Plan: withToken}, session.CsrfToken)
	expectAuthStatus(t, denied, http.StatusForbidden, "PERMISSION_DENIED")
	failure := new(pb.ErrorResponse)
	if err := proto.Unmarshal(denied.body, failure); err != nil || failure.Message != ownership.ReasonMaintenance {
		t.Fatalf("the refusal did not name the maintenance window: %q", failure.Message)
	}
	// Nothing above touched the record.
	list := f.ownership(t, client, "List", &pb.ListOwnershipRequest{Meta: scope("workspace")}, "")
	response := new(pb.ListOwnershipResponse)
	if err := proto.Unmarshal(list.body, response); err != nil {
		t.Fatal(err)
	}
	if response.Ownership[0].Owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME {
		t.Fatal("a refused switch moved the canvas")
	}
}

// A token issued at the machine gets past the window check and into the state
// machine, where the switch order and the Runtime have their own say.
func TestOwnershipSwitchWithATokenReachesTheStateMachine(t *testing.T) {
	var service *ownership.Service
	f := newAuthFixture(t, withOwnership(&service))
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", ownershipScopes())
	// The token has to come from the same service the handler serves, exactly
	// as it would from the local control channel.
	issued, err := service.IssueMaintenance(context.Background(), storage.OwnershipDomainCanvas)
	if err != nil {
		t.Fatal(err)
	}
	plan := &pb.OwnershipSwitchPlan{
		Domain:           pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_CANVAS,
		TargetOwner:      pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST,
		ImportId:         "import-1",
		MaintenanceToken: issued.Token,
	}
	// The stub Runtime cannot be reached, so the switch stops at exactly the
	// step that needs it — with the window still open and no epoch moved.
	reply := f.ownership(t, client, "Switch", &pb.SwitchOwnershipRequest{Meta: scope("workspace"), Plan: plan}, session.CsrfToken)
	expectAuthStatus(t, reply, http.StatusConflict, "CONFLICT")
	failure := new(pb.ErrorResponse)
	if err = proto.Unmarshal(reply.body, failure); err != nil || failure.Message != ownership.ReasonUnknown {
		t.Fatalf("an unreachable Runtime was reported as %q", failure.Message)
	}
	record, err := service.Record(context.Background(), storage.OwnershipDomainCanvas)
	if err != nil {
		t.Fatal(err)
	}
	if record.Owner != storage.OwnerRuntime {
		t.Fatalf("the canvas moved without the Runtime: %+v", record)
	}
}
