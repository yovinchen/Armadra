package commanddispatch

import (
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
)

// Delivering input is not doing work. If SUBMITTED ever mapped onto SUCCEEDED,
// a run history would show a scheduled prompt as finished the instant it was
// typed, and a loop plan would immediately queue the next one.
func TestSubmittedPromptIsDeliveredNotSucceeded(t *testing.T) {
	receipt := mapPromptReceipt(&pb.AgentPromptReceipt{Phase: pb.AgentPromptPhase_AGENT_PROMPT_PHASE_SUBMITTED, Sequence: 1})
	if receipt.Outcome != pb.AutomationOutcome_AUTOMATION_OUTCOME_DELIVERED {
		t.Fatal("a written prompt was reported as work done:", receipt.Outcome)
	}
	completed := mapPromptReceipt(&pb.AgentPromptReceipt{Phase: pb.AgentPromptPhase_AGENT_PROMPT_PHASE_COMPLETED, Sequence: 2})
	if completed.Outcome != pb.AutomationOutcome_AUTOMATION_OUTCOME_SUCCEEDED {
		t.Fatal("an attributed turn was not a success:", completed.Outcome)
	}
}

// Only an affirmative no-effect proof may become the outcome a retry is built
// on. Everything else — including a NOT_WRITTEN receipt that forgot to prove
// it — has to stay UNKNOWN, or the Host would paste the same prompt twice.
func TestOnlyProvenNonDeliveryIsRetryable(t *testing.T) {
	for _, phase := range []pb.AgentPromptPhase{
		pb.AgentPromptPhase_AGENT_PROMPT_PHASE_UNSPECIFIED,
		pb.AgentPromptPhase_AGENT_PROMPT_PHASE_SUBMITTED,
		pb.AgentPromptPhase_AGENT_PROMPT_PHASE_UNKNOWN,
		pb.AgentPromptPhase(999),
	} {
		receipt := mapPromptReceipt(&pb.AgentPromptReceipt{Phase: phase, NoEffectProven: true, Sequence: 1})
		if receipt.Outcome == pb.AutomationOutcome_AUTOMATION_OUTCOME_NOT_DISPATCHED {
			t.Fatal("an unproven phase claimed no effect:", phase)
		}
	}
	unproven := mapPromptReceipt(&pb.AgentPromptReceipt{Phase: pb.AgentPromptPhase_AGENT_PROMPT_PHASE_NOT_WRITTEN, Sequence: 1})
	if unproven.Outcome != pb.AutomationOutcome_AUTOMATION_OUTCOME_UNKNOWN {
		t.Fatal("a NOT_WRITTEN receipt without proof was treated as safe")
	}
	proven := mapPromptReceipt(&pb.AgentPromptReceipt{Phase: pb.AgentPromptPhase_AGENT_PROMPT_PHASE_NOT_WRITTEN, NoEffectProven: true, Sequence: 1})
	if proven.Outcome != pb.AutomationOutcome_AUTOMATION_OUTCOME_NOT_DISPATCHED {
		t.Fatal("a proven preflight refusal was not retryable")
	}
}

// A session that ended before the turn finished is a failure, never a silent
// success and never something a later receipt could upgrade.
func TestAbandonedDeliveryIsAFailure(t *testing.T) {
	receipt := mapPromptReceipt(&pb.AgentPromptReceipt{Phase: pb.AgentPromptPhase_AGENT_PROMPT_PHASE_ABANDONED, Sequence: 2, ReasonCode: "SESSION_ENDED"})
	if receipt.Outcome != pb.AutomationOutcome_AUTOMATION_OUTCOME_FAILED || receipt.ReasonCode != "SESSION_ENDED" {
		t.Fatalf("abandoned delivery mapped to %v %q", receipt.Outcome, receipt.ReasonCode)
	}
}

// A plan frozen before the target kind existed keeps the command executor, and
// an agent target that cannot name what it writes to is not an agent target.
func TestAgentKindNeedsANodeAndAFrozenDefinition(t *testing.T) {
	if AgentKind(&pb.AutomationTarget{SessionId: "session"}) {
		t.Fatal("an unspecified kind became a terminal writer")
	}
	agent := &pb.AutomationTarget{Kind: pb.AutomationTargetKind_AUTOMATION_TARGET_KIND_AGENT_SESSION_PROMPT}
	if validAgentTarget(agent) {
		t.Fatal("an agent target with no node was accepted")
	}
	agent.NodeId = "node-1"
	if validAgentTarget(agent) {
		t.Fatal("an agent target with no frozen definition was accepted")
	}
	agent.AgentLaunch = &pb.AgentLaunchSpec{AgentId: "claude"}
	if !validAgentTarget(agent) {
		t.Fatal("a complete agent target was refused")
	}
}
