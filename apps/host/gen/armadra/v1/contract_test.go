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
		"worker_hello": &pb.WorkerRequest{RequestId: "request-worker", HostId: "0123456789abcdef0123456789abcdef", DeadlineUnixMs: 1788557900000, Action: &pb.WorkerRequest_Hello{Hello: &pb.WorkerHelloRequest{Protocol: &pb.ProtocolVersion{Major: 1}}}},
		"worker_chunk": &pb.WorkerResponse{RequestId: "chunk-1", HostId: "0123456789abcdef0123456789abcdef", InstanceId: "abcdef0123456789abcdef0123456789", Result: &pb.WorkerResponse_FileChunk{FileChunk: &pb.WorkerFileChunk{RootId: "root-1", Path: "正文.txt", MimeType: "text/plain", Sha256: bytes.Repeat([]byte{7}, 32), TotalBytes: 4, Offset: 1, Data: []byte{0x9f, 0x99, 0x82}, Eof: true}}},
		// An overwrite carries the content version the caller read; the
		// create-only case leaves it absent, and the two must stay
		// distinguishable on the wire (H02).
		"worker_write":         &pb.WorkerRequest{RequestId: "write-1", HostId: "0123456789abcdef0123456789abcdef", ExpectedInstanceId: "abcdef0123456789abcdef0123456789", DeadlineUnixMs: 1788557900000, Action: &pb.WorkerRequest_WriteFile{WriteFile: &pb.WorkerWriteFileRequest{RootId: "root-1", Path: "正文.txt", Content: "内容\n", ExpectedSha256: proto.String(strings.Repeat("a", 64)), Bom: true}}},
		"worker_write_new":     &pb.WorkerRequest{RequestId: "write-2", HostId: "0123456789abcdef0123456789abcdef", ExpectedInstanceId: "abcdef0123456789abcdef0123456789", DeadlineUnixMs: 1788557900000, Action: &pb.WorkerRequest_WriteFile{WriteFile: &pb.WorkerWriteFileRequest{RootId: "root-1", Path: "new.txt", Content: ""}}},
		"worker_service":       &pb.WorkerRequest{RequestId: "service-1", HostId: "0123456789abcdef0123456789abcdef", ExpectedInstanceId: "abcdef0123456789abcdef0123456789", DeadlineUnixMs: 1788557900000, Action: &pb.WorkerRequest_Service{Service: &pb.WorkerServiceRequest{RootId: "root-1", Operation: pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_COMMIT, RequestJson: []byte(`{"path":".","message":"提交"}`), AllowWrite: true, AllowExecute: true}}},
		"worker_service_reply": &pb.WorkerResponse{RequestId: "service-1", HostId: "0123456789abcdef0123456789abcdef", InstanceId: "abcdef0123456789abcdef0123456789", Result: &pb.WorkerResponse_Service{Service: &pb.WorkerServiceResponse{HttpStatus: 409, ResponseJson: []byte(`{"code":"conflict","message":"版本不匹配"}`)}}},
		"identity_bootstrap":   &pb.HostControlRequest{RequestId: "pair-1", Action: &pb.HostControlRequest_Bootstrap{Bootstrap: &pb.BootstrapTicketRequest{ExpectedHostId: "host-1", ExpectedInstanceId: "instance-1", Origin: "https://armadra.example", DeviceName: "手机📱", Scopes: []*pb.AuthorizationGrant{{Permission: "canvas:read"}, {Permission: "terminal:write", WorkspaceId: "workspace-1"}}}}},
		"identity_session":     &pb.AuthenticatedSession{HostId: "host-1", Device: &pb.DeviceIdentity{DeviceId: "device-1", PrincipalId: "owner-1", DisplayName: "手机📱", Role: "owner", CreatedAtUnixMs: 1788557000000, Revision: math.MaxUint64}, CsrfToken: "fixture-not-a-secret", Scopes: []*pb.AuthorizationGrant{{Permission: "canvas:read"}}, ExpiresAtUnixMs: 1788557900000},
		"migration_manifest":   &pb.MigrationExportManifest{FormatVersion: 1, ExportId: "导出-1", ExportedAtUnixMs: 1788557000000, ProducerVersion: "0.1.0", DatabaseFile: "source.sqlite", DatabaseBytes: 9007199254740993, DatabaseSha256: bytes.Repeat([]byte{1}, 32), Migrations: []*pb.ExportMigration{{Version: 1, Checksum: bytes.Repeat([]byte{2}, 48), Success: true, Description: "initial"}}, Tables: []*pb.ExportTable{{Name: "boards", RowCount: 2, Readable: true, SchemaSha256: bytes.Repeat([]byte{3}, 32)}}, AssetsComplete: true},
		"imported_sql_row": &pb.ImportedSqlRow{Table: "测试", Columns: []*pb.ImportedSqlColumn{
			{Name: "null", Value: &pb.ImportedSqlColumn_NullValue{NullValue: &pb.SqlNull{}}},
			{Name: "text", Value: &pb.ImportedSqlColumn_TextValue{TextValue: "会话😀"}},
			{Name: "integer", Value: &pb.ImportedSqlColumn_IntegerValue{IntegerValue: math.MinInt64}},
			{Name: "real", Value: &pb.ImportedSqlColumn_RealValue{RealValue: 1.5}},
			{Name: "blob", Value: &pb.ImportedSqlColumn_BlobValue{BlobValue: []byte{0, 255}}},
		}},
		"desktop_shutdown":     &pb.DesktopRuntimeControl{Action: &pb.DesktopRuntimeControl_Shutdown{Shutdown: &pb.DesktopShutdownRequest{}}},
		"management_running":   &pb.HostManagementResult{State: &pb.HostManagementResult_Running{Running: &pb.HostStatus{HostId: "host-1", HostInstanceId: "instance-1", HttpEndpoint: "http://127.0.0.1:43121", StartedAtUnixMs: 1788556300000, ProcessId: 321}}},
		"management_stopped":   &pb.HostManagementResult{State: &pb.HostManagementResult_Stopped{Stopped: &pb.HostStoppedState{}}},
		"control_status":       &pb.HostControlRequest{RequestId: "控制请求", Action: &pb.HostControlRequest_Status{Status: &pb.HostStatusRequest{}}},
		"control_stop":         &pb.HostControlRequest{RequestId: "停止请求", Action: &pb.HostControlRequest_Stop{Stop: &pb.HostStopRequest{ExpectedInstanceId: "instance-1"}}},
		"control_status_reply": &pb.HostControlResponse{RequestId: "控制请求", Result: &pb.HostControlResponse_Status{Status: &pb.HostStatus{HostId: "host-1", HostInstanceId: "instance-1", HttpEndpoint: "http://127.0.0.1:43121", StartedAtUnixMs: 1788556300000, ProcessId: 321}}},
		"control_stop_reply":   &pb.HostControlResponse{RequestId: "停止请求", Result: &pb.HostControlResponse_Stopped{Stopped: &pb.HostStopResponse{Accepted: true}}},
		"hello":                &pb.HelloRequest{ClientId: "客户端📡", Protocol: &pb.ProtocolVersion{Major: 1}},
		"hello_response":       &pb.HelloResponse{Protocol: &pb.ProtocolVersion{Major: 1}, HostInstanceId: "主机", Capabilities: []string{"protocol.hello"}, MaxFrameBytes: 1048576},
		"hello_identity":       &pb.HelloResponse{Protocol: &pb.ProtocolVersion{Major: 1, Minor: 1}, HostInstanceId: "新进程", HostId: "0123456789abcdef0123456789abcdef", Capabilities: []string{"protocol.hello.v1", "host.identity.v1"}, MaxFrameBytes: 1048576},
		"error":                &pb.ErrorResponse{Code: "UNSUPPORTED", Message: "尚未实现"},
		"meta_absent":          &pb.CommandMeta{RequestId: "请求"},
		"meta_zero":            &pb.CommandMeta{RequestId: "请求", ExpectedRevision: proto.Uint64(0)},
		"meta_large":           &pb.CommandMeta{RequestId: "请求", Scope: &pb.Scope{HostId: "主机", WorkspaceId: "工作区", ExecutionHostId: "执行主机"}, IdempotencyKey: "唯一", ExpectedRevision: proto.Uint64(math.MaxUint64), DeadlineUnixMs: math.MinInt64},
		"frame_input":          &pb.StreamFrame{StreamId: "流", Sequence: math.MaxUint64, Epoch: "纪元", Payload: &pb.StreamFrame_TerminalInput{TerminalInput: &pb.TerminalInput{Session: &pb.SessionAddress{SessionId: "会话", Generation: 9007199254740993}, InputId: "输入", Data: []byte{0, 255, 27, 10}, WriterLeaseId: "租约"}}},
		"frame_output":         &pb.StreamFrame{Sequence: 9007199254740993, Payload: &pb.StreamFrame_TerminalOutput{TerminalOutput: []byte{0, 255, 27, 10}}},
		"frame_ack":            &pb.StreamFrame{Payload: &pb.StreamFrame_Ack{Ack: &pb.StreamAck{ReceivedThrough: math.MaxUint64, AvailableCreditBytes: 1048576}}},
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
