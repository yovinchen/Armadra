package server

import (
	"bytes"
	"context"
	"net/http"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/agenthost"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

func (f *authFixture) agent(t *testing.T, client *http.Client, action string, message proto.Message, csrf string) authReply {
	t.Helper()
	request, err := http.NewRequest("POST", f.origin+AgentPrefix+action, bytes.NewReader(authWire(t, message)))
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

// The agent surface reuses the terminal grants, for the reason §6.3 gives: the
// same device with the same grants has to get the same allow/deny answer before
// and after the domain moves, and a device's grants are frozen at pairing.
func agentScopes() []auth.Scope {
	return []auth.Scope{
		{Permission: agenthost.ScopeRead, WorkspaceID: "workspace"},
		{Permission: agenthost.ScopeWrite, WorkspaceID: "workspace"},
	}
}

func withAgents(f *authFixture, options *Options) {
	service, err := agenthost.New(agenthost.Options{Store: f.store, HostID: authHost, InstanceID: "host-instance-1"})
	if err != nil {
		panic(err)
	}
	options.Agents = service
}

func hostOwnsAgents(t *testing.T, store *storage.Store) {
	t.Helper()
	if _, err := store.PutOwnership(context.Background(), storage.Ownership{
		Domain: storage.OwnershipDomainAgent, Owner: storage.OwnerHost, Epoch: 2,
		Phase: storage.OwnershipSettled, ReasonCode: ownership.ReasonVerified,
		CreatedAtMS: 1788560523004, UpdatedAtMS: 1788560523004,
	}, 0); err != nil {
		t.Fatal(err)
	}
}

// A Host with no agent service authenticates first and then says the surface is
// unavailable. It never answers an empty status list, which a client cannot
// tell apart from a board where nothing is waiting — and would draw as "no
// agent needs you" while somebody's CLI sits blocked on a question.
func TestAgentWithoutAServiceAuthenticatesThenReportsUnsupported(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", agentScopes())
	expectAuthStatus(t, f.agent(t, client, "ListStatus", &pb.ListAgentStatusRequest{Meta: scope("workspace")}, ""), http.StatusNotImplemented, "UNSUPPORTED")
	expectAuthStatus(t, f.agent(t, client, "AnswerApproval", &pb.AnswerApprovalRequest{Meta: scope("workspace")}, session.CsrfToken), http.StatusNotImplemented, "UNSUPPORTED")
	anonymous := f.client(t)
	expectAuthStatus(t, f.agent(t, anonymous, "ListStatus", &pb.ListAgentStatusRequest{Meta: scope("workspace")}, ""), http.StatusUnauthorized, "UNAUTHENTICATED")
}

func TestAgentRequestsAreScopedToTheirWorkspaceAndHost(t *testing.T) {
	f := newAuthFixture(t, withAgents)
	client := f.client(t)
	f.pair(t, client, "手机", agentScopes())
	hostOwnsAgents(t, f.store)
	// A workspace the device was never granted must not be reachable.
	expectAuthStatus(t, f.agent(t, client, "ListStatus", &pb.ListAgentStatusRequest{Meta: scope("another-workspace")}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// Another Host or execution host is refused, never treated as local.
	foreign := &pb.CommandMeta{RequestId: "request-2", Scope: &pb.Scope{HostId: "33333333333333333333333333333333", WorkspaceId: "workspace"}}
	expectAuthStatus(t, f.agent(t, client, "ListStatus", &pb.ListAgentStatusRequest{Meta: foreign}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// A mutation without the CSRF header is refused before it reaches the store.
	expectAuthStatus(t, f.agent(t, client, "MarkRead", &pb.MarkAgentReadRequest{
		Meta: scope("workspace"), OperationId: "read-1", NodeId: "node-one",
	}, ""), http.StatusForbidden, "PERMISSION_DENIED")
	// A granted read of an empty board is an empty list, not an error.
	listed := f.agent(t, client, "ListStatus", &pb.ListAgentStatusRequest{Meta: scope("workspace")}, "")
	if listed.status != http.StatusOK {
		t.Fatalf("a granted read was refused: %d %s", listed.status, listed.body)
	}
	response := new(pb.ListAgentStatusResponse)
	if err := proto.Unmarshal(listed.body, response); err != nil {
		t.Fatal(err)
	}
	if len(response.GetStatuses()) != 0 {
		t.Fatalf("an empty board answered with statuses: %+v", response.GetStatuses())
	}
}

// While the Runtime owns the domain, the Host answers reads and refuses every
// mutation with the one stable code both services use.
func TestAgentWritesAreRefusedWhileTheRuntimeOwnsTheDomain(t *testing.T) {
	f := newAuthFixture(t, withAgents)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", agentScopes())
	// No ownership row is written, so the Runtime still owns the domain.
	reply := f.agent(t, client, "MarkRead", &pb.MarkAgentReadRequest{
		Meta: scope("workspace"), OperationId: "read-1", NodeId: "node-one",
	}, session.CsrfToken)
	expectAuthStatus(t, reply, http.StatusConflict, "CONFLICT")
	if !bytes.Contains(reply.body, []byte("ownership_moved")) {
		t.Fatalf("the refusal did not name ownership_moved: %s", reply.body)
	}
	// Reading keeps answering throughout: a client has to be able to draw the
	// board whichever side writes it.
	if listed := f.agent(t, client, "ListStatus", &pb.ListAgentStatusRequest{Meta: scope("workspace")}, ""); listed.status != http.StatusOK {
		t.Fatalf("a read was refused while the Runtime owned the domain: %d", listed.status)
	}
}

// Installing a Hook makes a CLI on the machine call back into the Runtime. It
// is execution, and a Host with no channel to that machine says so rather than
// reporting a Hook it never wrote.
func TestInstallingHooksWithoutAReachableWorkerIsUnavailable(t *testing.T) {
	f := newAuthFixture(t, withAgents)
	client := f.client(t)
	session, _ := f.pair(t, client, "手机", agentScopes())
	hostOwnsAgents(t, f.store)
	expectAuthStatus(t, f.agent(t, client, "InstallHooks", &pb.InstallHooksRequest{
		Meta: scope("workspace"), OperationId: "install-1", AgentId: "claude",
	}, session.CsrfToken), http.StatusServiceUnavailable, "UNAVAILABLE")
}
