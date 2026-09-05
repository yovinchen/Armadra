package v1_test

import (
	"bytes"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

// Protocol minor 2 adds `component` to the update artifact and to the check
// request (design docs/design/updates-and-service-install.md §1.5). One release
// publishes the desktop bundle, the Host, the Worker and the Hook for the same
// target, so a target alone stopped naming a download. These samples pin the
// new field's wire numbers; the fixtures below are what all three runtimes
// encode and decode.
func TestUpdateComponentContractWire(t *testing.T) {
	for name, message := range map[string]proto.Message{
		// The Host asking about its own program, on its own target.
		"update_component_request": &pb.CheckForUpdateRequest{
			Meta:             &pb.CommandMeta{RequestId: "更新检查"},
			Channel:          pb.ReleaseChannel_RELEASE_CHANNEL_BETA,
			InstalledVersion: &pb.SemanticVersion{Major: 0, Minor: 2, Patch: 0},
			Target:           "linux-x86_64",
			Component:        "host",
		},
		// An artifact that belongs to one program on one target.
		"update_component_artifact": &pb.UpdateArtifact{
			Target:    "windows-aarch64",
			Url:       "https://example.invalid/armadra-host_0.2.0_windows-aarch64.zip",
			SizeBytes: 9007199254740993,
			Sha256:    bytes.Repeat([]byte{6}, 32),
			Signature: &pb.UpdateSignature{State: pb.UpdateSignatureState_UPDATE_SIGNATURE_STATE_PRESENT, Value: "dW50cnVzdGVkIGNvbW1lbnQ", KeyId: "key-2"},
			Component: "host",
		},
		// The updater manifest is the same file on every platform, so it
		// carries a component and no target. A caller that matched on target
		// alone would either miss it or claim it belongs to one platform.
		"update_manifest_artifact": &pb.UpdateArtifact{
			Url:       "https://example.invalid/latest.json",
			SizeBytes: 2048,
			Sha256:    bytes.Repeat([]byte{9}, 32),
			Signature: &pb.UpdateSignature{State: pb.UpdateSignatureState_UPDATE_SIGNATURE_STATE_ABSENT},
			Component: "manifest",
		},
	} {
		wire, err := proto.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		encoded := fixture(t, name, wire)
		decoded := message.ProtoReflect().New().Interface()
		if err = proto.Unmarshal(encoded, decoded); err != nil || !proto.Equal(decoded, message) {
			t.Fatal("update component contract changed")
		}
	}
}

// A minor is additive: a peer built against minor 1 must still read a minor 2
// message, keeping the bytes it does not understand so a relay does not strip
// them. The check below is the same guarantee TestUnknownFieldsPreserved makes
// for the handshake, asserted on the field this batch introduced.
func TestUpdateComponentIsAdditive(t *testing.T) {
	current := &pb.UpdateArtifact{
		Target:    "darwin-aarch64",
		Url:       "https://example.invalid/armadra-worker_0.2.0_darwin-aarch64.tar.gz",
		SizeBytes: 12,
		Component: "worker",
	}
	wire, err := proto.Marshal(current)
	if err != nil {
		t.Fatal(err)
	}
	// Field 6 is the only difference between the two encodings, so an old
	// reader sees exactly the minor 1 message plus one unknown field.
	older := &pb.UpdateArtifact{Target: current.Target, Url: current.Url, SizeBytes: current.SizeBytes}
	olderWire, err := proto.Marshal(older)
	if err != nil {
		t.Fatal(err)
	}
	tag := protowire.AppendTag(nil, 6, protowire.BytesType)
	tag = protowire.AppendString(tag, "worker")
	if !bytes.Equal(wire, append(append([]byte{}, olderWire...), tag...)) {
		t.Fatal("component is not appended after the fields minor 1 already had")
	}
	// Decoding into a message with no fields keeps every field unknown, which
	// is the shape a binary relay sees: re-encoding must be byte-exact.
	relayed := &pb.HostStatusRequest{}
	if err := proto.Unmarshal(wire, relayed); err != nil {
		t.Fatal(err)
	}
	roundTrip, err := proto.Marshal(relayed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(roundTrip, wire) {
		t.Fatal("a relay that does not know component dropped bytes")
	}
}
