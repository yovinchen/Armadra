package v1_test

import (
	"bytes"
	"encoding/hex"
	"flag"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

var updateFixtures = flag.Bool("update-fixtures", false, "regenerate shared wire fixtures")

func fixture(t *testing.T, name string, data []byte) []byte {
	t.Helper()
	path := filepath.Join("../../../../../proto/fixtures", name+".hex")
	if *updateFixtures {
		if err := os.WriteFile(path, []byte(hex.EncodeToString(data)+"\n"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	encoded, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	wire, err := hex.DecodeString(strings.TrimSpace(string(encoded)))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(wire, data) {
		t.Fatalf("%s encoding differs from shared fixture", name)
	}
	return wire
}

func cases() map[string]proto.Message {
	return map[string]proto.Message{
		"hello":          &pb.HelloRequest{ClientId: "客户端📡", Protocol: &pb.ProtocolVersion{Major: 1}},
		"hello_response": &pb.HelloResponse{Protocol: &pb.ProtocolVersion{Major: 1}, HostInstanceId: "主机", Capabilities: []string{"protocol.hello"}, MaxFrameBytes: 1048576},
		"error":          &pb.ErrorResponse{Code: "UNSUPPORTED", Message: "尚未实现"},
		"meta_absent":    &pb.CommandMeta{RequestId: "请求"},
		"meta_zero":      &pb.CommandMeta{RequestId: "请求", ExpectedRevision: proto.Uint64(0)},
		"meta_large":     &pb.CommandMeta{RequestId: "请求", Scope: &pb.Scope{HostId: "主机", WorkspaceId: "工作区", ExecutionHostId: "执行主机"}, IdempotencyKey: "唯一", ExpectedRevision: proto.Uint64(math.MaxUint64), DeadlineUnixMs: math.MinInt64},
		"frame_input":    &pb.StreamFrame{StreamId: "流", Sequence: math.MaxUint64, Epoch: "纪元", Payload: &pb.StreamFrame_TerminalInput{TerminalInput: &pb.TerminalInput{Session: &pb.SessionAddress{SessionId: "会话", Generation: 9007199254740993}, InputId: "输入", Data: []byte{0, 255, 27, 10}, WriterLeaseId: "租约"}}},
		"frame_output":   &pb.StreamFrame{Sequence: 9007199254740993, Payload: &pb.StreamFrame_TerminalOutput{TerminalOutput: []byte{0, 255, 27, 10}}},
		"frame_ack":      &pb.StreamFrame{Payload: &pb.StreamFrame_Ack{Ack: &pb.StreamAck{ReceivedThrough: math.MaxUint64, AvailableCreditBytes: 1048576}}},
	}
}

func TestSharedContract(t *testing.T) {
	for name, message := range cases() {
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
				t.Fatal("decoded message changed values or presence")
			}
		})
	}
}

func TestUnknownFieldsPreserved(t *testing.T) {
	known, _ := proto.Marshal(cases()["hello"])
	wire := protowire.AppendTag(known, 127, protowire.VarintType)
	wire = protowire.AppendVarint(wire, 123)
	wire = fixture(t, "hello_unknown", wire)
	decoded := &pb.HelloRequest{}
	if err := proto.Unmarshal(wire, decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.ProtoReflect().GetUnknown()) == 0 {
		t.Fatal("unknown field lost")
	}
	encoded, _ := proto.Marshal(decoded)
	if !bytes.Equal(encoded, wire) {
		t.Fatal("binary relay lost unknown field")
	}
}

func TestOneofLastMemberWins(t *testing.T) {
	input, _ := proto.Marshal(cases()["frame_input"])
	ack, _ := proto.Marshal(cases()["frame_ack"])
	decoded := &pb.StreamFrame{}
	if err := proto.Unmarshal(append(input, ack...), decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.GetAck() == nil || decoded.GetTerminalInput() != nil {
		t.Fatal("oneof not replaced by last member")
	}
}

func TestMalformedWireRejected(t *testing.T) {
	if err := proto.Unmarshal([]byte{0x0a, 0xff}, &pb.HelloRequest{}); err == nil {
		t.Fatal("accepted truncated wire")
	}
}
