package v1_test

import (
	"bytes"
	"math"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The agent prompt surface is the only executor that writes into a PTY that
// already exists, so its evidence fields have to survive the wire unchanged:
// a NOT_WRITTEN receipt that lost `no_effect_proven` would look retryable, and
// an UNKNOWN one that gained it would authorize a second paste.
func TestAgentPromptEvidenceWire(t *testing.T) {
	for name, message := range map[string]proto.Message{
		"agent_target_status": &pb.AgentTargetStatus{State: pb.AgentTargetState_AGENT_TARGET_STATE_ABSENT, SessionId: "会话-1", Generation: math.MaxUint64, ReasonCode: "SESSION_ABSENT"},
		"agent_target_request": &pb.AgentTargetRequest{
			WorkspaceId: "workspace-1",
			NodeId:      "node-1",
			SessionId:   "session-1",
			Generation:  9007199254740993,
			Expected:    &pb.AgentLaunchSpec{AgentId: "claude", WorkingDirectory: "/项目/仓库", AccountId: "default"},
			ColdStart:   &pb.AgentLaunchSpec{AgentId: "claude", WorkingDirectory: "/项目/仓库", Args: []string{"--flag", "值📦"}, PermissionMode: "acceptEdits", ModelId: "sonnet", AccountId: "default"},
		},
		"agent_prompt_request": &pb.AgentPromptRequest{
			OperationId:   "automation/principal-1/host-0123456789abcdef0123456789abcdef/workspace-1/dispatch/run-1",
			RequestSha256: bytes.Repeat([]byte{5}, 32),
			WorkspaceId:   "workspace-1",
			NodeId:        "node-1",
			SessionId:     "session-1",
			Generation:    9007199254740993,
			Prompt:        []byte("每晚复盘：读取 diff 后写结论\n"),
			Expected:      &pb.AgentLaunchSpec{AgentId: "claude", WorkingDirectory: "/项目/仓库", Args: []string{"--flag", "值📦"}, PermissionMode: "acceptEdits", ModelId: "sonnet", AccountId: "default"},
		},
		"agent_prompt_not_written": &pb.AgentPromptReceipt{OperationId: "operation-1", RequestSha256: bytes.Repeat([]byte{6}, 32), Phase: pb.AgentPromptPhase_AGENT_PROMPT_PHASE_NOT_WRITTEN, Sequence: 1, ObservedAtUnixMs: 1788557000000, ReasonCode: "TARGET_BUSY", SessionId: "session-1", Generation: 3, NoEffectProven: true},
		"agent_prompt_unknown":     &pb.AgentPromptReceipt{OperationId: "operation-1", RequestSha256: bytes.Repeat([]byte{6}, 32), Phase: pb.AgentPromptPhase(999), Sequence: math.MaxUint64, ObservedAtUnixMs: 1788557900000, ReasonCode: "UNATTRIBUTED", SessionId: "session-2", Generation: math.MaxUint64, ColdStarted: true},
		"automation_agent_target": &pb.AutomationTarget{
			ExecutionHostId: "0123456789abcdef0123456789abcdef",
			SessionId:       "session-1",
			Generation:      7,
			Kind:            pb.AutomationTargetKind_AUTOMATION_TARGET_KIND_AGENT_SESSION_PROMPT,
			NodeId:          "node-1",
			ColdStartPolicy: pb.AutomationColdStartPolicy_AUTOMATION_COLD_START_POLICY_LAUNCH_FROZEN,
			AgentLaunch:     &pb.AgentLaunchSpec{AgentId: "codex", WorkingDirectory: "/项目/仓库", AccountId: "default"},
		},
	} {
		wire, err := proto.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		encoded := fixture(t, name, wire)
		decoded := message.ProtoReflect().New().Interface()
		if err = proto.Unmarshal(encoded, decoded); err != nil || !proto.Equal(decoded, message) {
			t.Fatal("agent prompt contract changed")
		}
	}
}

// An unspecified target kind must keep reading as the command executor: plans
// frozen before the field existed cannot silently become PTY writers.
func TestAgentTargetKindDefaultStaysCommand(t *testing.T) {
	wire, err := proto.Marshal(&pb.AutomationTarget{ExecutionHostId: "host-1", SessionId: "session-1", Generation: 1})
	if err != nil {
		t.Fatal(err)
	}
	decoded := new(pb.AutomationTarget)
	if err = proto.Unmarshal(wire, decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Kind != pb.AutomationTargetKind_AUTOMATION_TARGET_KIND_UNSPECIFIED || decoded.NodeId != "" || decoded.AgentLaunch != nil {
		t.Fatal("an old target grew an agent identity")
	}
	if decoded.ColdStartPolicy != pb.AutomationColdStartPolicy_AUTOMATION_COLD_START_POLICY_UNSPECIFIED {
		t.Fatal("an old target grew a cold start policy")
	}
}
