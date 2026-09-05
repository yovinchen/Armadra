package v1_test

import (
	"bytes"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The update contract must be able to say "I did not look" without that being
// confusable with "there is nothing new", and must carry a signature state
// that distinguishes an unsigned release from a device with no public key.
func TestUpdateContractWire(t *testing.T) {
	for name, message := range map[string]proto.Message{
		"update_unsupported": &pb.CheckForUpdateResponse{State: pb.UpdateCheckState_UPDATE_CHECK_STATE_UNSUPPORTED, Channel: pb.ReleaseChannel_RELEASE_CHANNEL_STABLE, InstalledVersion: &pb.SemanticVersion{Major: 0, Minor: 1, Patch: 0}, ReasonCode: "UPDATES_NOT_CONFIGURED", CheckedAtUnixMs: 1788557000000},
		"update_available": &pb.CheckForUpdateResponse{
			State:            pb.UpdateCheckState_UPDATE_CHECK_STATE_AVAILABLE,
			Channel:          pb.ReleaseChannel_RELEASE_CHANNEL_BETA,
			InstalledVersion: &pb.SemanticVersion{Major: 0, Minor: 1, Patch: 0},
			Release: &pb.ReleaseInfo{
				Version:            &pb.SemanticVersion{Major: 0, Minor: 2, Patch: 1, Prerelease: "beta.1"},
				Channel:            pb.ReleaseChannel_RELEASE_CHANNEL_BETA,
				PublishedAtUnixMs:  1788557900000,
				NotesUrl:           "https://example.invalid/发布说明",
				Compatibility:      &pb.UpdateCompatibility{MinimumInstalled: &pb.SemanticVersion{Minor: 1}, MaximumInstalled: &pb.SemanticVersion{Major: 1}, ProtocolMajor: 1, MinimumProtocolMinor: 1},
				Artifacts:          []*pb.UpdateArtifact{{Target: "darwin-aarch64", Url: "https://example.invalid/Armadra.tar.gz", SizeBytes: 9007199254740993, Sha256: bytes.Repeat([]byte{4}, 32), Signature: &pb.UpdateSignature{State: pb.UpdateSignatureState_UPDATE_SIGNATURE_STATE_PRESENT, Value: "dW50cnVzdGVkIGNvbW1lbnQ", KeyId: "key-1"}}},
			},
			CheckedAtUnixMs: 1788557900000,
			RetryAfterMs:    3600000,
		},
		"update_unconfigured_signature": &pb.UpdateArtifact{Target: "windows-x86_64", Url: "https://example.invalid/Armadra.msi", SizeBytes: 1, Sha256: bytes.Repeat([]byte{2}, 32), Signature: &pb.UpdateSignature{State: pb.UpdateSignatureState_UPDATE_SIGNATURE_STATE_UNCONFIGURED}},
	} {
		wire, err := proto.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		encoded := fixture(t, name, wire)
		decoded := message.ProtoReflect().New().Interface()
		if err = proto.Unmarshal(encoded, decoded); err != nil || !proto.Equal(decoded, message) {
			t.Fatal("update contract changed")
		}
	}
}
