package v1_test

import (
	"math"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The reserved account (S02) and presence (H04) contracts must round-trip
// byte-identically in all three runtimes before anything is built on them.
// Nothing here implies the Host implements the operations: the same commit
// answers them with UNSUPPORTED.
func TestReservedAccountAndPresenceWire(t *testing.T) {
	for name, message := range map[string]proto.Message{
		// No secret is representable: only a reference into a credential store.
		"account_bind_request": &pb.BindNodeAccountRequest{
			Meta:   &pb.CommandMeta{RequestId: "绑定-1", Scope: &pb.Scope{HostId: "host-1", WorkspaceId: "workspace-1"}, ExpectedRevision: proto.Uint64(0)},
			NodeId: "node-1",
			Account: &pb.AccountRef{
				AccountId:  "default",
				ProviderId: "claude",
				Label:      "工作账号📇",
			},
			Credential: &pb.CredentialBinding{
				CredentialRef:   "keychain://armadra/claude/default",
				Scope:           pb.CredentialScope_CREDENTIAL_SCOPE_EXECUTION_HOST,
				AuthorizationId: "grant-1",
			},
		},
		"account_binding": &pb.NodeAccountBinding{
			NodeId:        "node-1",
			Account:       &pb.AccountRef{AccountId: "default"},
			Credential:    &pb.CredentialBinding{CredentialRef: "keychain://armadra/claude/default", Scope: pb.CredentialScope(999)},
			Revision:      math.MaxUint64,
			BoundAtUnixMs: 9007199254740993,
		},
		"presence_snapshot": &pb.SubscribePresenceResponse{
			Participants: []*pb.Presence{
				{ParticipantId: "principal-1", DeviceId: "device-1", DisplayName: "手机📱", CanvasId: "canvas-1", FocusNodeId: "node-1", State: pb.PresenceState_PRESENCE_STATE_ACTIVE, ObservedAtUnixMs: 1788557900000},
				{ParticipantId: "principal-2", State: pb.PresenceState_PRESENCE_STATE_DISCONNECTED, LastSeenUnixMs: proto.Int64(0)},
			},
			Lease:    &pb.WriterLease{LeaseId: "lease-1", CanvasId: "canvas-1", HolderParticipantId: "principal-1", Revision: 9007199254740993, ExpiresAtUnixMs: 1788557900000},
			Revision: math.MaxUint64,
		},
		// An absent expected_revision is "no CAS"; 0 is a real expectation.
		"presence_mutation": &pb.Mutation{
			MutationId:       "mutation-1",
			CanvasId:         "canvas-1",
			ActorId:          "principal-1",
			LeaseId:          "lease-1",
			ExpectedRevision: proto.Uint64(0),
			Revision:         9007199254740993,
			Kind:             pb.MutationKind_MUTATION_KIND_WHITEBOARD_BLOB,
			PayloadType:      "tldraw/snapshot",
			Payload:          []byte{0, 255, 27, 10},
			ObservedAtUnixMs: math.MinInt64,
		},
		"presence_acquire": &pb.AcquireWriterLeaseRequest{
			Meta:           &pb.CommandMeta{RequestId: "租约-1"},
			CanvasId:       "canvas-1",
			RequestedTtlMs: 300000,
		},
	} {
		t.Run(name, func(t *testing.T) {
			data, err := proto.Marshal(message)
			if err != nil {
				t.Fatal(err)
			}
			wire := fixture(t, name, data)
			decoded := message.ProtoReflect().New().Interface()
			if err := proto.Unmarshal(wire, decoded); err != nil {
				t.Fatal(err)
			}
			if !proto.Equal(message, decoded) {
				t.Fatal("reserved contract changed values or presence")
			}
		})
	}
}

// A Hello that names an unsupported surface must survive the wire: a client
// that loses this field would silently fall back to "maybe supported".
func TestHelloReportsUnsupportedSurfaces(t *testing.T) {
	message := &pb.HelloResponse{
		Protocol:       &pb.ProtocolVersion{Major: 1, Minor: 1},
		HostInstanceId: "新进程",
		HostId:         "0123456789abcdef0123456789abcdef",
		Capabilities:   []string{"protocol.hello.v1", "host.identity.v1"},
		MaxFrameBytes:  1048576,
		CapabilityStatus: []*pb.CapabilityStatus{
			{Name: "presence", State: pb.CapabilityState_CAPABILITY_STATE_UNSUPPORTED, Reason: "host.capability.reserved"},
			{Name: "accountBinding", State: pb.CapabilityState_CAPABILITY_STATE_UNSUPPORTED, Reason: "host.capability.reserved"},
		},
	}
	data, err := proto.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	wire := fixture(t, "hello_unsupported", data)
	decoded := &pb.HelloResponse{}
	if err := proto.Unmarshal(wire, decoded); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(message, decoded) || len(decoded.GetCapabilityStatus()) != 2 {
		t.Fatal("unsupported capability report changed")
	}
}
