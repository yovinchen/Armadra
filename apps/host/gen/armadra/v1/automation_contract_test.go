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
		"automation_command_session":   &pb.AutomationCommandSession{SessionId: "session/夜间", WorkspaceId: "workspace-1", ExecutionHostId: "0123456789abcdef0123456789abcdef", RootPath: "/项目/仓库", Launch: &pb.CommandLaunchSpec{Executable: "/bin/echo", Args: []string{"--flag", "值📦"}, WorkingDirectory: ".", AccountId: "default", TimeoutMs: 86400000}, Generation: math.MaxUint64, LaunchSha256: bytes.Repeat([]byte{9}, 32), State: pb.AutomationCommandSessionState_AUTOMATION_COMMAND_SESSION_STATE_UNREBUILDABLE, ReasonCode: "GENERATION_CHANGED", Revision: 9007199254740993, CreatedAtUnixMs: 1788557000000, UpdatedAtUnixMs: 1788557900000},
		"automation_define_request":    &pb.DefineAutomationRequest{Meta: &pb.CommandMeta{RequestId: "define-1", Scope: &pb.Scope{HostId: "0123456789abcdef0123456789abcdef", WorkspaceId: "workspace-1", ExecutionHostId: "0123456789abcdef0123456789abcdef"}}, PlanId: "plan-1", Config: &pb.AutomationPlanConfig{WorkspaceId: "workspace-1", Title: "每晚构建", Target: &pb.AutomationTarget{ExecutionHostId: "0123456789abcdef0123456789abcdef", SessionId: "session-1", Generation: 1}, Schedule: &pb.AutomationSchedule{Kind: &pb.AutomationSchedule_Cron{Cron: &pb.AutomationCron{Expression: "0 3 * * *", Timezone: "Asia/Shanghai"}}}}, Payload: []byte{0x00, 0x9f, 0x99, 0x82}, ExpectedRevision: 9007199254740993},
		"automation_plan_snapshot":     &pb.AutomationPlanSnapshot{Plan: &pb.AutomationPlan{Id: "plan-1", ConfigVersion: 2, State: pb.AutomationPlanState_AUTOMATION_PLAN_STATE_ACTIVE}, Revision: math.MaxUint64, ConfigSha256: bytes.Repeat([]byte{3}, 32)},
		"automation_needs_attention":   &pb.AutomationPlanSnapshot{Plan: &pb.AutomationPlan{Id: "plan-1", ConfigVersion: 2, State: pb.AutomationPlanState_AUTOMATION_PLAN_STATE_ACTIVE, NeedsAttention: true, AttentionReasonCode: "TARGET_UNSUPPORTED", AttentionStreak: math.MaxUint32}, Revision: math.MaxUint64, ConfigSha256: bytes.Repeat([]byte{3}, 32)},
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
