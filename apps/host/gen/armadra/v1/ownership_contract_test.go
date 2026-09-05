package v1_test

import (
	"bytes"
	"math"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// Multi-domain write ownership (Go Host 业务所有权迁移 §2.2).
//
// The three shapes below are the ones a switch is decided from, so each is
// pinned as a shared fixture the Rust and TypeScript sides decode independently:
// a record in a transitional phase, the plan that names the window it belongs
// to, and a report that refused. A report whose `matched` is false is as much
// part of the contract as one that passed — the refusal has to survive the wire
// with the differing identifiers intact, or an operator cannot see what blocked
// the switch.
func TestOwnershipRecordWire(t *testing.T) {
	for name, message := range map[string]proto.Message{
		"ownership_domain_record": &pb.WriteOwnership{
			Domain:          pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_AGENT,
			Owner:           pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST,
			Epoch:           9007199254740993,
			Phase:           pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_SWITCHING,
			ImportId:        "0123456789abcdef0123456789abcdef",
			EventSequence:   math.MaxUint64,
			ReasonCode:      "ownership.switch.pending",
			UpdatedAtUnixMs: 1788557900000,
			Revision:        3,
		},
		"ownership_switch_plan": &pb.OwnershipSwitchPlan{
			Domain:        pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_SESSION,
			TargetOwner:   pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST,
			ExpectedEpoch: 9007199254740993,
			ImportId:      "0123456789abcdef0123456789abcdef",
			Dependencies: []*pb.WriteOwnership{
				{Domain: pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_CANVAS, Owner: pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST, Epoch: 2, Phase: pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_SETTLED, Revision: 1},
				{Domain: pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_FILESYSTEM, Owner: pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST, Epoch: 4, Phase: pb.CanvasOwnershipPhase_CANVAS_OWNERSHIP_PHASE_SETTLED, Revision: 2},
			},
			MaintenanceToken: "fixture-not-a-secret",
		},
		"ownership_report_refused": &pb.OwnershipReport{
			Domain:         pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_CANVAS,
			ImportId:       "0123456789abcdef0123456789abcdef",
			ExportId:       "导出-1",
			ManifestSha256: bytes.Repeat([]byte{2}, 32),
			Checks: []*pb.ConsistencyCheck{
				{Check: "canvas.nodes", ExpectedCount: 2, ActualCount: 2, Matched: true},
				{Check: "canvas.assets", ExpectedCount: 1, ActualCount: 0, Differences: []string{"asset-1"}},
			},
			EntityCount:      9007199254740993,
			VerifiedAtUnixMs: 1788557900000,
		},
		// The maintenance window is opened over the same-user control channel,
		// never over HTTPS, so the request that asks for a token is part of the
		// control contract rather than the ownership service's own surface.
		"ownership_maintenance_ticket": &pb.HostControlRequest{
			RequestId: "maintenance-1",
			Action: &pb.HostControlRequest_Maintenance{Maintenance: &pb.MaintenanceTicketRequest{
				ExpectedHostId:     "0123456789abcdef0123456789abcdef",
				ExpectedInstanceId: "abcdef0123456789abcdef0123456789",
				Domain:             "canvas",
			}},
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

// An unspecified domain must stay unspecified. The switch state machine refuses
// it, and a decoder that quietly read zero as "canvas" would hand the busiest
// domain to whichever side asked with an empty field.
func TestOwnershipDomainZeroIsNotCanvas(t *testing.T) {
	record := new(pb.WriteOwnership)
	if record.GetDomain() != pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_UNSPECIFIED {
		t.Fatal("the zero domain is not unspecified")
	}
	data, err := proto.Marshal(&pb.GetOwnershipRequest{Domain: pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_UNSPECIFIED})
	if err != nil || len(data) != 0 {
		t.Fatal("an unspecified domain is not the empty encoding")
	}
	// A domain this build has never heard of survives a round trip as its own
	// number instead of collapsing onto a known one.
	future := &pb.ListOwnershipResponse{Ownership: []*pb.WriteOwnership{{Domain: pb.WriteOwnershipDomain(99), Epoch: 1}}}
	wire, err := proto.Marshal(future)
	if err != nil {
		t.Fatal(err)
	}
	decoded := new(pb.ListOwnershipResponse)
	if err = proto.Unmarshal(wire, decoded); err != nil || decoded.Ownership[0].GetDomain() != pb.WriteOwnershipDomain(99) {
		t.Fatal("an unknown domain was not preserved")
	}
}

// The switch and rollback envelopes differ only in the flag that accepts an
// export-only rollback, and the response is one message for both.
func TestOwnershipSwitchEnvelopes(t *testing.T) {
	plan := &pb.OwnershipSwitchPlan{Domain: pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_CANVAS, TargetOwner: pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME, ExpectedEpoch: 2, MaintenanceToken: "fixture-not-a-secret"}
	rollback := &pb.RollbackOwnershipRequest{Meta: &pb.CommandMeta{RequestId: "rollback-1"}, Plan: plan, AcceptExportOnly: true}
	data, err := proto.Marshal(rollback)
	if err != nil {
		t.Fatal(err)
	}
	decoded := new(pb.RollbackOwnershipRequest)
	if err = proto.Unmarshal(data, decoded); err != nil || !decoded.GetAcceptExportOnly() || decoded.GetPlan().GetMaintenanceToken() != "fixture-not-a-secret" {
		t.Fatal("the rollback envelope changed")
	}
	// A switch request carries no accept-export-only flag at all: the field
	// numbers must not be interchangeable between the two envelopes.
	switchRequest := new(pb.SwitchOwnershipRequest)
	if err = proto.Unmarshal(data, switchRequest); err != nil {
		t.Fatal(err)
	}
	if switchRequest.GetPlan().GetExpectedEpoch() != 2 || len(switchRequest.ProtoReflect().GetUnknown()) == 0 {
		t.Fatal("the accept-export-only flag is not an unknown field to a switch")
	}
	response := &pb.OwnershipSwitchResponse{Ownership: &pb.WriteOwnership{Domain: pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_CANVAS, Epoch: 3, Revision: 4}, Plan: plan}
	if wire, err := proto.Marshal(response); err != nil || len(wire) == 0 {
		t.Fatal("the switch response does not encode")
	}
}
