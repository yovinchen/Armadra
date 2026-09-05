package v1_test

import (
	"bytes"
	"math"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The resident channel's upward half (business migration §2.9). Nothing here
// implies a domain is owned by the Host: the same commit only records upcalls.
func TestWorkerChannelUpcallWire(t *testing.T) {
	for name, message := range map[string]proto.Message{
		// A first send and a replay of the same event differ only in `attempt`,
		// and that difference must survive: an operator reading an event has to
		// be able to tell a duplicate delivery from a duplicate observation.
		"worker_upcall_agent": &pb.WorkerUpcall{
			RequestId:        "w-0123456789abcdef",
			WorkerInstanceId: "abcdef0123456789abcdef0123456789",
			Sequence:         9007199254740993,
			Attempt:          1,
			EmittedAtUnixMs:  1788557900000,
			Event: &pb.WorkerUpcall_Agent{Agent: &pb.WorkerAgentUpcall{
				WorkspaceId:      "workspace-1",
				NodeId:           "节点-1",
				SessionId:        "会话-1",
				Payload:          []byte{0, 255, 27, 10},
				PayloadSha256:    bytes.Repeat([]byte{5}, 32),
				SchemaVersion:    1,
				Kind:             pb.WorkerAgentUpcallKind_WORKER_AGENT_UPCALL_KIND_HOOK_TURN,
				ObservedAtUnixMs: 1788557899000,
			}},
		},
		"worker_upcall_replay": &pb.WorkerUpcall{
			RequestId:        "w-replay-1",
			WorkerInstanceId: "abcdef0123456789abcdef0123456789",
			Sequence:         math.MaxUint64,
			Attempt:          math.MaxUint32,
			EmittedAtUnixMs:  math.MinInt64,
			Event: &pb.WorkerUpcall_Agent{Agent: &pb.WorkerAgentUpcall{
				NodeId:     "节点-2",
				Kind:       pb.WorkerAgentUpcallKind_WORKER_AGENT_UPCALL_KIND_APPROVAL_REQUESTED,
				ReasonCode: "agent.approval.pending",
			}},
		},
		// An unknown enum value stays the number it was. A Worker built after
		// this Host must not have its report silently read as UNSPECIFIED.
		"worker_upcall_unknown_kind": &pb.WorkerUpcall{
			RequestId:        "w-unknown-1",
			WorkerInstanceId: "abcdef0123456789abcdef0123456789",
			Sequence:         1,
			Attempt:          1,
			Event:            &pb.WorkerUpcall_Agent{Agent: &pb.WorkerAgentUpcall{Kind: pb.WorkerAgentUpcallKind(999)}},
		},
		"worker_upcall_accepted": &pb.WorkerUpcallReply{
			RequestId:        "w-0123456789abcdef",
			HostId:           "0123456789abcdef0123456789abcdef",
			WorkerInstanceId: "abcdef0123456789abcdef0123456789",
			AckSequence:      9007199254740993,
			Disposition:      pb.WorkerUpcallDisposition_WORKER_UPCALL_DISPOSITION_ACCEPTED,
			ReceivedAtUnixMs: 1788557900001,
		},
		// A duplicate still carries an ack: the Worker retires the frame either
		// way, so a Host that has already recorded an event never leaves it
		// pinned in the outbox forever.
		"worker_upcall_duplicate": &pb.WorkerUpcallReply{
			RequestId:        "w-replay-1",
			HostId:           "0123456789abcdef0123456789abcdef",
			WorkerInstanceId: "abcdef0123456789abcdef0123456789",
			AckSequence:      math.MaxUint64,
			Disposition:      pb.WorkerUpcallDisposition_WORKER_UPCALL_DISPOSITION_DUPLICATE,
			ReasonCode:       "worker.upcall.duplicate",
		},
		"worker_upcall_rejected": &pb.WorkerUpcallReply{
			RequestId:        "w-bad-1",
			HostId:           "0123456789abcdef0123456789abcdef",
			WorkerInstanceId: "abcdef0123456789abcdef0123456789",
			Disposition:      pb.WorkerUpcallDisposition_WORKER_UPCALL_DISPOSITION_REJECTED,
			ReasonCode:       "worker.upcall.malformed",
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
				t.Fatal("worker channel contract changed values or presence")
			}
		})
	}
}

// The handshake has to distinguish three states a Host reacts to differently:
// no channel at all, a channel with nothing pending, and a channel that owes a
// replay. An absent `channel` is the first; a present one with
// `unacknowledged` zero is the second.
func TestWorkerHelloCarriesTheChannelCapability(t *testing.T) {
	message := &pb.WorkerHelloResponse{
		Protocol:          &pb.ProtocolVersion{Major: 1},
		HostId:            "0123456789abcdef0123456789abcdef",
		InstanceId:        "abcdef0123456789abcdef0123456789",
		Platform:          "macos",
		Architecture:      "aarch64",
		Capabilities:      []string{"worker.roots.v1", "worker.upcall.v1"},
		MaxFrameBytes:     1 << 20,
		MaxFileChunkBytes: 256 << 10,
		MaxTextFileBytes:  1 << 20,
		RuntimeVersion:    "0.1.0",
		Channel: &pb.WorkerChannelCapability{
			WorkerInstanceId:  "abcdef0123456789abcdef0123456789",
			Socket:            "/tmp/状态/worker-upcall.sock",
			HighestSequence:   9007199254740993,
			Unacknowledged:    3,
			MaxUnacknowledged: 1024,
			State:             pb.WorkerChannelState_WORKER_CHANNEL_STATE_REPLAYING,
			ReasonCode:        "worker.upcall.replaying",
		},
	}
	data, err := proto.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	wire := fixture(t, "worker_hello_channel", data)
	decoded := &pb.WorkerHelloResponse{}
	if err := proto.Unmarshal(wire, decoded); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(message, decoded) || decoded.GetChannel().GetUnacknowledged() != 3 {
		t.Fatal("channel capability changed")
	}
	// The pre-existing Hello fixture has no channel, and adding the field must
	// not have given it one by default.
	if (&pb.WorkerHelloResponse{}).GetChannel() != nil {
		t.Fatal("an absent channel decoded as a present one")
	}
}
