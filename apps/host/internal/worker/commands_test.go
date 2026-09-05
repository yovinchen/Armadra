package worker

import (
	pb "armadra.local/host/gen/armadra/v1"
	"context"
	"errors"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"strings"
	"testing"
)

func TestCommandWireRejectsMultipleNestedResults(t *testing.T) {
	nested := protowire.AppendTag(nil, 10, protowire.BytesType)
	nested = protowire.AppendBytes(nested, nil)
	nested = protowire.AppendTag(nested, 11, protowire.BytesType)
	nested = protowire.AppendBytes(nested, nil)
	wire, _ := proto.Marshal(&pb.WorkerResponse{RequestId: "request", HostId: strings.Repeat("a", 32), InstanceId: strings.Repeat("b", 32)})
	wire = protowire.AppendTag(wire, 20, protowire.BytesType)
	wire = protowire.AppendBytes(wire, nested)
	if _, err := decodeResponse(wire); err == nil {
		t.Fatal("ambiguous command result accepted")
	}
}
func TestCommandReceiptProofAndCorrelation(t *testing.T) {
	zero := int32(0)
	r := &pb.CommandReceipt{OperationId: "owner/workspace/op", SessionId: "session", WorkspaceId: "workspace", Generation: 1, Sequence: 2, UpdatedAtUnixMs: 1, RequestSha256: make([]byte, 32), ExecutionSha256: make([]byte, 32), Phase: pb.CommandPhase_COMMAND_PHASE_SUCCEEDED, ExitCode: &zero, CleanupConfirmed: true}
	if !validReceipt(r) {
		t.Fatal("valid success rejected")
	}
	r.CleanupConfirmed = false
	if validReceipt(r) {
		t.Fatal("unconfirmed cleanup accepted as success")
	}
	r.Phase = pb.CommandPhase_COMMAND_PHASE_NOT_DISPATCHED
	r.CleanupConfirmed = true
	if validReceipt(r) {
		t.Fatal("ND without no-effect proof accepted")
	}
	r.NoEffectProven = true
	if !validReceipt(r) {
		t.Fatal("valid no-effect proof rejected")
	}
	c := &Client{}
	request := &pb.CommandRequest{Action: &pb.CommandRequest_Run{Run: &pb.RunCommandRequest{OperationId: r.OperationId, SessionId: r.SessionId, ExpectedGeneration: 1, RequestSha256: r.RequestSha256}}}
	response := &pb.CommandResponse{Result: &pb.CommandResponse_Receipt{Receipt: r}}
	if !c.validCommand(request, response) {
		t.Fatal("matching receipt rejected")
	}
	request.GetRun().ExpectedGeneration = 2
	if c.validCommand(request, response) {
		t.Fatal("wrong generation accepted")
	}
	request.GetRun().ExpectedGeneration = 1
	request.GetRun().ExpectedNotDispatchedSequence = 2
	if c.validCommand(request, response) {
		t.Fatal("retry received stale sequence")
	}
}
func TestCommandAccountAndRootScopeAreExplicit(t *testing.T) {
	c := &Client{}
	_, err := c.CreateCommandSession(context.Background(), &pb.CreateCommandSessionRequest{Launch: &pb.CommandLaunchSpec{AccountId: "other-user"}})
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != CodeUnsupported {
		t.Fatal("nondefault account not explicitly unsupported", err)
	}
	if commandWithinRoot("/workspace", "/workspace-other") || commandWithinRoot("/workspace", "/workspace/../other") {
		t.Fatal("working directory escaped frozen root")
	}
}
