package v1_test

import (
	"math"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The language service has three contracts that a refactor loses quietly:
//
//   - "not found" and "probe failed" are different answers, and both are
//     different from "running". A descriptor that carries no pid is a server
//     that is not running, not a server whose pid happens to be zero.
//   - `payload_json` is opaque bytes. Chinese text and emoji inside a
//     JSON-RPC message must survive byte-for-byte on every runtime, because
//     the transport never re-encodes it.
//   - `expected_sha256` is a map, and a path that is absent from it means
//     "this file must not exist yet" — a distinction that only survives if
//     absence stays absence on the wire.
func TestLanguageServiceWire(t *testing.T) {
	for name, message := range map[string]proto.Message{
		"language_capabilities": &pb.LanguageCapabilities{
			ExecutionHostId: "local",
			Servers: []*pb.LanguageServerDescriptor{
				{
					ServerId:        "ruff",
					LanguageId:      "python",
					FileExtensions:  []string{"py", "pyi"},
					Executable:      "/opt/homebrew/bin/ruff",
					Version:         "0.16.1",
					State:           pb.LanguageServerState_LANGUAGE_SERVER_STATE_RUNNING,
					Features:        []pb.LanguageFeature{pb.LanguageFeature_LANGUAGE_FEATURE_DIAGNOSTICS, pb.LanguageFeature_LANGUAGE_FEATURE_FORMATTING, pb.LanguageFeature_LANGUAGE_FEATURE_CODE_ACTION},
					RestartCount:    2,
					Pid:             proto.Int64(4242),
					StartTimeUnixMs: proto.Int64(1788556300000),
					OpenDocuments:   3,
					ProbedAtUnixMs:  1788557000000,
				},
				// The rustup proxy: the file is on PATH, `--version` fails, and
				// the honest answer is "we could not find out" with no pid.
				{
					ServerId:       "rust-analyzer",
					LanguageId:     "rust",
					FileExtensions: []string{"rs"},
					State:          pb.LanguageServerState_LANGUAGE_SERVER_STATE_UNSUPPORTED,
					Reason:         "server_probe_failed",
					ProbedAtUnixMs: 1788557000000,
				},
			},
			MaxDocumentBytes: 1048576,
			MaxSessions:      32,
			MaxMessageBytes:  983040,
		},
		"language_session": &pb.LanguageSession{
			SessionId:              "会话-1",
			ServerId:               "ruff",
			Generation:             math.MaxUint64,
			State:                  pb.LanguageServerState_LANGUAGE_SERVER_STATE_RUNNING,
			ServerCapabilitiesJson: []byte(`{"hoverProvider":true}`),
		},
		"language_frame_message": &pb.LanguageFrame{
			LinkEpoch: "epoch-1",
			Payload: &pb.LanguageFrame_Message{Message: &pb.LanguageMessage{
				SessionId:   "会话-1",
				Sequence:    9007199254740993,
				Kind:        pb.LanguageMessageKind_LANGUAGE_MESSAGE_KIND_RESPONSE,
				Method:      "textDocument/hover",
				RequestId:   "7:client-1",
				PayloadJson: []byte(`{"jsonrpc":"2.0","id":7,"result":{"contents":"注释 📘","uri":"armadra:///源码/主.py"}}`),
			}},
		},
		"language_frame_ack": &pb.LanguageFrame{
			LinkEpoch: "epoch-1",
			Payload: &pb.LanguageFrame_Ack{Ack: &pb.LanguageAck{
				SessionId:            "会话-1",
				ReceivedThrough:      math.MaxUint64,
				AvailableCreditBytes: 4194304,
			}},
		},
		"language_apply_edit": &pb.LanguageApplyEditRequest{
			RootId:            "root-1",
			SessionId:         "会话-1",
			WorkspaceEditJson: []byte(`{"changes":{"armadra:///src/主.py":[]}}`),
			// `src/新.py` is deliberately not in the map: it must not exist.
			ExpectedSha256: map[string]string{"src/主.py": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"},
			AllowWrite:     true,
		},
		// Restart and stop are one frame with an action, and the action is not
		// a boolean: a third one (say "reprobe") must be addable without the
		// two that shipped changing meaning.
		"language_control": &pb.LanguageControlRequest{
			RootId:       "root-1",
			WorkspaceId:  "ws-1",
			ServerId:     "ruff",
			Action:       pb.LanguageControlAction_LANGUAGE_CONTROL_ACTION_RESTART,
			AllowExecute: true,
		},
	} {
		data, err := proto.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		wire := fixture(t, name, data)
		decoded := message.ProtoReflect().New().Interface()
		if err = proto.Unmarshal(wire, decoded); err != nil || !proto.Equal(decoded, message) {
			t.Fatalf("%s changed", name)
		}
	}
}

// A stopped server has no pid, and an absent pid must not decode as 0 —
// otherwise the resource panel would claim a process that does not exist.
func TestLanguageAbsentPidIsNotZero(t *testing.T) {
	running, err := proto.Marshal(&pb.LanguageServerDescriptor{ServerId: "ruff", Pid: proto.Int64(0)})
	if err != nil {
		t.Fatal(err)
	}
	stopped, err := proto.Marshal(&pb.LanguageServerDescriptor{ServerId: "ruff"})
	if err != nil {
		t.Fatal(err)
	}
	if len(running) == len(stopped) {
		t.Fatal("a measured pid of 0 encodes like a server that is not running")
	}
	var back pb.LanguageServerDescriptor
	if err = proto.Unmarshal(stopped, &back); err != nil || back.Pid != nil {
		t.Fatal("an absent pid decoded as a value")
	}
}

// Every language enumeration reserves 0 for UNSPECIFIED, so a default frame
// never claims to be a real state, feature or message kind.
func TestLanguageEnumsReserveZero(t *testing.T) {
	if pb.LanguageServerState_LANGUAGE_SERVER_STATE_UNSPECIFIED != 0 ||
		pb.LanguageFeature_LANGUAGE_FEATURE_UNSPECIFIED != 0 ||
		pb.LanguageMessageKind_LANGUAGE_MESSAGE_KIND_UNSPECIFIED != 0 ||
		pb.LanguageControlAction_LANGUAGE_CONTROL_ACTION_UNSPECIFIED != 0 {
		t.Fatal("a language enumeration gives 0 a meaning")
	}
}

// A control frame with no action must not read as "restart": an empty request
// is a caller that never said what it wanted, and starting a process on that
// basis is the one outcome nobody asked for.
func TestLanguageControlDefaultsToNoAction(t *testing.T) {
	data, err := proto.Marshal(&pb.LanguageControlRequest{ServerId: "ruff"})
	if err != nil {
		t.Fatal(err)
	}
	var back pb.LanguageControlRequest
	if err = proto.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	if back.GetAction() != pb.LanguageControlAction_LANGUAGE_CONTROL_ACTION_UNSPECIFIED {
		t.Fatal("an unset control action decoded as a real one")
	}
}

// The Worker oneof branches are additive: the language numbers must not
// collide with the ownership and command branches that came before them.
func TestLanguageWorkerBranchesAreDistinct(t *testing.T) {
	request := &pb.WorkerRequest{
		RequestId: "language-1",
		Action:    &pb.WorkerRequest_LanguageCapabilities{LanguageCapabilities: &pb.LanguageCapabilitiesRequest{RootId: "root-1", Refresh: true}},
	}
	data, err := proto.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var decoded pb.WorkerRequest
	if err = proto.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.GetLanguageCapabilities() == nil || decoded.GetGetWriteOwnership() != nil {
		t.Fatal("the language branch did not survive its own oneof")
	}
	response := &pb.WorkerResponse{
		RequestId: "language-1",
		Result:    &pb.WorkerResponse_LanguageSession{LanguageSession: &pb.LanguageSession{SessionId: "会话-1", State: pb.LanguageServerState_LANGUAGE_SERVER_STATE_STOPPED}},
	}
	if data, err = proto.Marshal(response); err != nil {
		t.Fatal(err)
	}
	var back pb.WorkerResponse
	if err = proto.Unmarshal(data, &back); err != nil || back.GetLanguageSession().GetState() != pb.LanguageServerState_LANGUAGE_SERVER_STATE_STOPPED {
		t.Fatal("a closed session lost its final state")
	}
}
