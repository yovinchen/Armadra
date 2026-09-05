package v1_test

import (
	pb "armadra.local/host/gen/armadra/v1"
	"bytes"
	"google.golang.org/protobuf/proto"
	"math"
	"testing"
)

func TestCommandExecutionEvidenceWire(t *testing.T) {
	for name, message := range map[string]proto.Message{
		"command_run":         &pb.CommandRequest{Action: &pb.CommandRequest_Run{Run: &pb.RunCommandRequest{OperationId: "operation-1", SessionId: "会话-1", RequestSha256: bytes.Repeat([]byte{8}, 32), ExpectedGeneration: math.MaxUint64, Stdin: []byte{0, 255, 27, 10}}}},
		"command_receipt":     &pb.CommandReceipt{OperationId: "operation-1", SessionId: "会话-1", Generation: 9007199254740993, Phase: pb.CommandPhase(999), Sequence: math.MaxUint64, ExitCode: proto.Int32(0), Stdout: []byte{0, 255, 10}, StdoutTotalBytes: 9007199254740993, StdoutTruncated: true},
		"command_absent_exit": &pb.CommandReceipt{OperationId: "operation-2", Phase: pb.CommandPhase_COMMAND_PHASE_NOT_DISPATCHED, NoEffectProven: true, CleanupConfirmed: true},
	} {
		data, err := proto.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		wire := fixture(t, name, data)
		decoded := message.ProtoReflect().New().Interface()
		if err = proto.Unmarshal(wire, decoded); err != nil || !proto.Equal(decoded, message) {
			t.Fatal("command evidence changed")
		}
	}
}
