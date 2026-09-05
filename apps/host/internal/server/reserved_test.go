package server

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

func decodeError(t *testing.T, response *http.Response) *pb.ErrorResponse {
	t.Helper()
	data, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	result := &pb.ErrorResponse{}
	if err := proto.Unmarshal(data, result); err != nil {
		t.Fatal(err)
	}
	return result
}

// A reserved method is refused with a reason, not with an empty success and
// not with the 404 an older Host would give for a name it never knew.
func TestReservedSurfacesAnswerUnsupported(t *testing.T) {
	s := httptest.NewServer(NewHandler(Identity{HostID: "persistent-host", InstanceID: "instance-1"}))
	defer s.Close()
	for path, capability := range map[string]string{
		PresencePrefix + "SubscribePresence":  CapabilityPresence,
		PresencePrefix + "AcquireWriterLease": CapabilityPresence,
		PresencePrefix + "ReleaseWriterLease": CapabilityPresence,
		PresencePrefix + "ApplyMutation":      CapabilityPresence,
		AccountPrefix + "BindNodeAccount":     CapabilityAccountBinding,
		AccountPrefix + "GetNodeAccount":      CapabilityAccountBinding,
		AccountPrefix + "ListAccounts":        CapabilityAccountBinding,
	} {
		body, err := proto.Marshal(&pb.BindNodeAccountRequest{NodeId: "node-1", Account: &pb.AccountRef{AccountId: "default"}})
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.Post(s.URL+path, MediaType, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		result := decodeError(t, response)
		if response.StatusCode != http.StatusNotImplemented || result.GetCode() != "UNSUPPORTED" {
			t.Fatalf("%s: unexpected answer %d %v", path, response.StatusCode, result)
		}
		if !strings.Contains(result.GetMessage(), capability) || !strings.Contains(result.GetMessage(), reservedReason) {
			t.Fatalf("%s: reason is missing from %q", path, result.GetMessage())
		}
	}
}

// A method name this build never defined is still NOT_FOUND: answering
// UNSUPPORTED would claim a contract exists.
func TestUnknownReservedMethodsStayNotFound(t *testing.T) {
	s := httptest.NewServer(NewHandler(Identity{HostID: "persistent-host", InstanceID: "instance-1"}))
	defer s.Close()
	for _, path := range []string{PresencePrefix + "Join", AccountPrefix + "DeleteAccount", "/rpc/armadra.v1.PresenceService/"} {
		response, err := http.Post(s.URL+path, MediaType, bytes.NewReader(nil))
		if err != nil {
			t.Fatal(err)
		}
		if result := decodeError(t, response); response.StatusCode != http.StatusNotFound || result.GetCode() != "NOT_FOUND" {
			t.Fatalf("%s: unexpected answer %d %v", path, response.StatusCode, result)
		}
	}
}

func TestReservedSurfacesRejectNonPost(t *testing.T) {
	s := httptest.NewServer(NewHandler(Identity{HostID: "persistent-host", InstanceID: "instance-1"}))
	defer s.Close()
	response, err := http.Get(s.URL + PresencePrefix + "SubscribePresence")
	if err != nil {
		t.Fatal(err)
	}
	if result := decodeError(t, response); response.StatusCode != http.StatusMethodNotAllowed || result.GetCode() != "INVALID_ARGUMENT" {
		t.Fatalf("unexpected answer %d %v", response.StatusCode, result)
	}
}

// Hello names both reserved surfaces so the UI can show "unsupported" instead
// of an empty participant list or a disabled-looking binding control.
func TestHelloReportsReservedCapabilitiesAsUnsupported(t *testing.T) {
	s := httptest.NewServer(NewHandler(Identity{HostID: "persistent-host", InstanceID: "instance-1"}))
	defer s.Close()
	response, err := http.Post(s.URL+HelloPath, MediaType, bytes.NewReader(helloBytes(t, 1, 1)))
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	result := &pb.HelloResponse{}
	if err := proto.Unmarshal(data, result); err != nil {
		t.Fatal(err)
	}
	statuses := map[string]*pb.CapabilityStatus{}
	for _, status := range result.GetCapabilityStatus() {
		statuses[status.GetName()] = status
	}
	if len(statuses) != 2 {
		t.Fatalf("unexpected capability status: %v", result.GetCapabilityStatus())
	}
	for _, name := range []string{CapabilityPresence, CapabilityAccountBinding} {
		status := statuses[name]
		if status.GetState() != pb.CapabilityState_CAPABILITY_STATE_UNSUPPORTED || status.GetReason() != reservedReason {
			t.Fatalf("%s is not reported unsupported: %v", name, status)
		}
	}
	// The positive list must not gain an entry for something that does not run.
	for _, capability := range result.GetCapabilities() {
		if strings.Contains(capability, CapabilityPresence) || strings.Contains(capability, "account") {
			t.Fatalf("reserved surface advertised as a capability: %v", result.GetCapabilities())
		}
	}
}
