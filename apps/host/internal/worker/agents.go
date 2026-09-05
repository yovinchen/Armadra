package worker

import (
	"bytes"
	"context"
	"regexp"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// CapabilityAgentPrompt is what a Worker advertises when it can reach a live
// Runtime that owns Agent terminals. Absent means scheduled prompt delivery is
// unsupported on this Host — never that a target simply is not ready.
const CapabilityAgentPrompt = "automation.agent-prompt.v1"

// A node id is a canvas UUID and a workspace id is the Host's own identifier;
// both are echoed back in receipts, so they are constrained before they travel.
var agentIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.:/-]{1,200}$`)

// MaxPromptBytes mirrors the Runtime's own ceiling. A prompt is refused rather
// than truncated: half an instruction is worse than none.
const MaxPromptBytes = 32 << 10

func (c *Client) supportsAgents() bool {
	if c.hello == nil {
		return false
	}
	for _, capability := range c.hello.Capabilities {
		if capability == CapabilityAgentPrompt {
			return true
		}
	}
	return false
}

func (c *Client) agent(ctx context.Context, input *pb.AgentRequest) (*pb.AgentResponse, error) {
	if !c.commandMode || !c.supportsAgents() {
		return nil, &Error{Code: CodeUnsupported}
	}
	response, err := c.exchange(ctx, &pb.WorkerRequest{Action: &pb.WorkerRequest_Agent{Agent: input}}, "agent")
	if err != nil {
		return nil, err
	}
	return proto.Clone(response.GetAgent()).(*pb.AgentResponse), nil
}

func validLaunchSpec(spec *pb.AgentLaunchSpec) bool {
	if spec == nil || !agentIDPattern.MatchString(spec.AgentId) || len(spec.Args) > 64 {
		return false
	}
	// A frozen definition names configuration, never an executable and never a
	// non-default account. Both are refused here, before the Worker sees them.
	if spec.AccountId != "" && spec.AccountId != "default" {
		return false
	}
	for _, arg := range spec.Args {
		if len(arg) > 4096 {
			return false
		}
	}
	return len(spec.WorkingDirectory) <= 32768 && len(spec.PermissionMode) <= 64 && len(spec.ModelId) <= 128
}

// AgentTarget asks whether the node can be written to, and — when the plan
// authorized one — lets the Runtime launch its frozen definition first. It is
// called inside a claimed run, after the run's authorization was re-checked.
func (c *Client) AgentTarget(ctx context.Context, input *pb.AgentTargetRequest) (*pb.AgentTargetStatus, error) {
	// A probe carries no workspace: the Host holds only the target here, and
	// the node's own workspace is what the executor checks permissions against.
	if input == nil || (input.WorkspaceId != "" && !agentIDPattern.MatchString(input.WorkspaceId)) || !agentIDPattern.MatchString(input.NodeId) || !validLaunchSpec(input.Expected) {
		return nil, &Error{Code: CodeInvalid}
	}
	if input.ColdStart != nil && (!validLaunchSpec(input.ColdStart) || input.ColdStart.AgentId != input.Expected.AgentId) {
		return nil, &Error{Code: CodeInvalid}
	}
	response, err := c.agent(ctx, &pb.AgentRequest{Action: &pb.AgentRequest_Target{Target: proto.Clone(input).(*pb.AgentTargetRequest)}})
	if err != nil {
		return nil, err
	}
	return response.GetTarget(), nil
}

// AgentPrompt writes one framed prompt. The operation id makes it idempotent
// at the Runtime, so a repeat of the same operation never pastes twice.
func (c *Client) AgentPrompt(ctx context.Context, input *pb.AgentPromptRequest) (*pb.AgentPromptReceipt, error) {
	if input == nil || !commandIDPattern.MatchString(input.OperationId) || len(input.RequestSha256) != 32 {
		return nil, &Error{Code: CodeInvalid}
	}
	if !agentIDPattern.MatchString(input.WorkspaceId) || !agentIDPattern.MatchString(input.NodeId) || !validLaunchSpec(input.Expected) {
		return nil, &Error{Code: CodeInvalid}
	}
	if len(input.Prompt) == 0 || len(input.Prompt) > MaxPromptBytes {
		return nil, &Error{Code: CodeInvalid}
	}
	response, err := c.agent(ctx, &pb.AgentRequest{Action: &pb.AgentRequest_Prompt{Prompt: proto.Clone(input).(*pb.AgentPromptRequest)}})
	if err != nil {
		return nil, err
	}
	return response.GetReceipt(), nil
}

func (c *Client) AgentPromptLookup(ctx context.Context, operationID string) (*pb.AgentPromptReceipt, error) {
	if !commandIDPattern.MatchString(operationID) {
		return nil, &Error{Code: CodeInvalid}
	}
	response, err := c.agent(ctx, &pb.AgentRequest{Action: &pb.AgentRequest_Lookup{Lookup: &pb.AgentPromptLookupRequest{OperationId: operationID}}})
	if err != nil {
		return nil, err
	}
	return response.GetReceipt(), nil
}

// validAgent rejects an answer that does not belong to the question. The
// no-effect claim is checked hardest: it is the only phase a retry is built on.
func (c *Client) validAgent(input *pb.AgentRequest, response *pb.AgentResponse) bool {
	if response == nil {
		return false
	}
	if input.GetTarget() != nil {
		status := response.GetTarget()
		return status != nil && status.State >= 1 && status.State <= 5 && len(status.ReasonCode) <= 128 && reasonCode(status.ReasonCode) &&
			(status.SessionId == "" || agentIDPattern.MatchString(status.SessionId)) &&
			// READY without a live session would be a target nobody can name.
			(status.State != pb.AgentTargetState_AGENT_TARGET_STATE_READY || (status.SessionId != "" && status.Generation > 0))
	}
	receipt := response.GetReceipt()
	if receipt == nil || receipt.Sequence == 0 || receipt.ObservedAtUnixMs <= 0 || len(receipt.ReasonCode) > 128 || !reasonCode(receipt.ReasonCode) {
		return false
	}
	if receipt.NoEffectProven && receipt.Phase != pb.AgentPromptPhase_AGENT_PROMPT_PHASE_NOT_WRITTEN {
		return false
	}
	if request := input.GetPrompt(); request != nil {
		return receipt.OperationId == request.OperationId && bytes.Equal(receipt.RequestSha256, request.RequestSha256)
	}
	if request := input.GetLookup(); request != nil {
		return receipt.OperationId == request.OperationId
	}
	return false
}

// Reason codes are machine tokens a run history shows verbatim. Anything else
// could put raw terminal output or a path into the Host's own records.
func reasonCode(value string) bool {
	for _, character := range value {
		if (character < 'A' || character > 'Z') && (character < '0' || character > '9') && character != '_' {
			return false
		}
	}
	return true
}
