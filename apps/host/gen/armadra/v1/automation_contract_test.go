package v1_test

import (
	pb "armadra.local/host/gen/armadra/v1"
	"bytes"
	"google.golang.org/protobuf/proto"
	"math"
	"testing"
)

func TestAutomationWireEvidenceAndUnknownOutcome(t *testing.T) {
	for name, message := range map[string]proto.Message{
		"automation_unknown_receipt":   &pb.AutomationReceipt{OperationId: "operation-1", RequestSha256: bytes.Repeat([]byte{7}, 32), Outcome: pb.AutomationOutcome(999), Sequence: math.MaxUint64, ObservedAtUnixMs: 1788557900000},
		"automation_delivery_evidence": &pb.AutomationRun{Id: "run-1", PlanId: "plan-1", WorkspaceId: "workspace-1", ConfigVersion: 9007199254740993, State: pb.AutomationRunState_AUTOMATION_RUN_STATE_UNKNOWN, DeliveryObserved: true},
	} {
		wire, err := proto.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		encoded := fixture(t, name, wire)
		decoded := message.ProtoReflect().New().Interface()
		if err = proto.Unmarshal(encoded, decoded); err != nil || !proto.Equal(decoded, message) {
			t.Fatal("automation contract changed")
		}
	}
}
