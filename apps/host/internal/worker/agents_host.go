package worker

import (
	"context"
	"crypto/sha256"
	"slices"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The agent domain over the private Worker channel
// (Go Host 业务所有权迁移 §2.7, §2.9, action 28).
//
// `agents.go` is the other agent frame — action 21 — and it writes a prompt
// into a live PTY. This one carries the *records*: what the execution host has
// observed since a cursor, what it holds right now, and the four things this
// Host asks it to put in front of a CLI. Two frames, two meanings, and a client
// that confused them would answer a listing by typing into somebody's terminal.
//
// Every method here refuses an answer that could not be true rather than
// passing it upstream. That is not defensiveness for its own sake: a drain
// whose cursor went backwards would make this Host re-record events it has
// already published, and a delivery receipt with no outcome would be recorded
// as a success nobody observed.

// AgentCapability is what a Worker must advertise before this client will ask
// it about agent records. A Worker that never opened the Runtime's database
// cannot answer the read, and saying so is what stops a rollback from being
// "verified" against an empty list.
const AgentCapability = "agent.worker.v1"

// SupportsAgents reports whether this Worker said it can answer about agents.
func (c *Client) SupportsAgents() bool {
	return c != nil && c.hello != nil && slices.Contains(c.hello.Capabilities, AgentCapability)
}

func (c *Client) agentHostExchange(ctx context.Context, action *pb.AgentWorkerRequest) (*pb.AgentWorkerResponse, error) {
	if !c.SupportsAgents() {
		return nil, &Error{Code: CodeUnsupported}
	}
	response, err := c.exchange(ctx, &pb.WorkerRequest{Action: &pb.WorkerRequest_AgentHost{AgentHost: action}}, "agentHost")
	if err != nil {
		return nil, err
	}
	result := response.GetAgentHost()
	if result == nil {
		return nil, &Error{Code: CodeProtocol}
	}
	return result, nil
}

// Agents reads the Worker's own agent rows.
//
// An empty list from a Worker that has rows is a protocol failure rather than
// "no agents": the caller compares it against a package it wrote, and a
// silently empty answer would make every comparison trivially pass.
func (c *Client) Agents(ctx context.Context) (*pb.WorkerAgentStates, error) {
	if c == nil || !c.ownershipMode {
		return nil, &Error{Code: CodeUnsupported}
	}
	result, err := c.agentHostExchange(ctx, &pb.AgentWorkerRequest{
		Action: &pb.AgentWorkerRequest_ListAgents{ListAgents: &pb.ListWorkerAgentsRequest{}},
	})
	if err != nil {
		return nil, err
	}
	states := result.GetAgents()
	if states == nil {
		return nil, &Error{Code: CodeProtocol}
	}
	clone, ok := proto.Clone(states).(*pb.WorkerAgentStates)
	if !ok {
		return nil, &Error{Code: CodeProtocol}
	}
	return clone, nil
}

// WorkerAgents is the handback read, under the name the agent projector's
// `AgentReader` role uses. It is the same exchange: the projector asks for the
// Worker's own rows, and the client that answers a switch is the client that
// answers a rollback.
func (c *Client) WorkerAgents(ctx context.Context) (*pb.WorkerAgentStates, error) {
	return c.Agents(ctx)
}

// Drain pulls what has happened on the execution host since `after`.
//
// A cursor that came back at or below the one that was sent is refused. It
// would mean either that the Worker is answering about a window this Host has
// already recorded — which would double every event in it — or that it is not
// tracking a cursor at all, and neither is something to record silently.
func (c *Client) Drain(ctx context.Context, after uint64, limit uint32) (*pb.DrainedAgentEvents, error) {
	result, err := c.agentHostExchange(ctx, &pb.AgentWorkerRequest{
		Action: &pb.AgentWorkerRequest_DrainEvents{DrainEvents: &pb.DrainAgentEventsRequest{
			AfterSequence: after,
			Limit:         limit,
		}},
	})
	if err != nil {
		return nil, err
	}
	drained := result.GetEvents()
	if drained == nil {
		return nil, &Error{Code: CodeProtocol}
	}
	if drained.GetNextSequence() < after {
		return nil, &Error{Code: CodeProtocol}
	}
	// Nothing to report is a legitimate answer and leaves the cursor where it
	// was: the Worker is saying "you are up to date", not "start again".
	if drained.GetNextSequence() == after && len(drained.GetEvents())+len(drained.GetApprovals())+len(drained.GetDeliveries()) > 0 {
		return nil, &Error{Code: CodeProtocol}
	}
	clone, ok := proto.Clone(drained).(*pb.DrainedAgentEvents)
	if !ok {
		return nil, &Error{Code: CodeProtocol}
	}
	return clone, nil
}

// DeliverApproval writes an answer into the file a CLI is blocked on.
func (c *Client) DeliverApproval(ctx context.Context, request *pb.DeliverApprovalAnswerRequest) (*pb.AgentDeliveryReceipt, error) {
	if request.GetApprovalId() == "" || request.GetDecision() == "" {
		return nil, &Error{Code: CodeInvalid}
	}
	result, err := c.agentHostExchange(ctx, &pb.AgentWorkerRequest{
		Action: &pb.AgentWorkerRequest_DeliverApproval{DeliverApproval: request},
	})
	if err != nil {
		return nil, err
	}
	return receipt(result.GetDelivery(), request.GetApprovalId())
}

// DeliverHandoff puts a prepared bundle in front of the target agent.
func (c *Client) DeliverHandoff(ctx context.Context, request *pb.DeliverHandoffRequest) (*pb.AgentDeliveryReceipt, error) {
	if request.GetHandoffId() == "" || len(request.GetBundle()) == 0 {
		return nil, &Error{Code: CodeInvalid}
	}
	result, err := c.agentHostExchange(ctx, &pb.AgentWorkerRequest{
		Action: &pb.AgentWorkerRequest_DeliverHandoff{DeliverHandoff: request},
	})
	if err != nil {
		return nil, err
	}
	return receipt(result.GetDelivery(), request.GetHandoffId())
}

// DeliverMessage puts one message in front of an agent.
func (c *Client) DeliverMessage(ctx context.Context, request *pb.DeliverMessageRequest) (*pb.AgentDeliveryReceipt, error) {
	if request.GetTargetNodeId() == "" {
		return nil, &Error{Code: CodeInvalid}
	}
	result, err := c.agentHostExchange(ctx, &pb.AgentWorkerRequest{
		Action: &pb.AgentWorkerRequest_DeliverMessage{DeliverMessage: request},
	})
	if err != nil {
		return nil, err
	}
	return receipt(result.GetDelivery(), request.GetTraceId())
}

// Hooks installs or removes a CLI's Hook configuration on the execution host.
func (c *Client) Hooks(ctx context.Context, agentID string, install bool) (*pb.HookInstallState, error) {
	if agentID == "" {
		return nil, &Error{Code: CodeInvalid}
	}
	action := &pb.AgentWorkerRequest{
		Action: &pb.AgentWorkerRequest_UninstallHooks{UninstallHooks: &pb.UninstallHooksRequest{AgentId: agentID}},
	}
	if install {
		action = &pb.AgentWorkerRequest{
			Action: &pb.AgentWorkerRequest_InstallHooks{InstallHooks: &pb.InstallHooksRequest{AgentId: agentID}},
		}
	}
	result, err := c.agentHostExchange(ctx, action)
	if err != nil {
		return nil, err
	}
	state := result.GetHooks()
	if state == nil || state.GetAgentId() != agentID {
		// A Worker answering about a different CLI is answering a question
		// nobody asked, and recording it would say a Hook was installed for
		// something else.
		return nil, &Error{Code: CodeProtocol}
	}
	clone, ok := proto.Clone(state).(*pb.HookInstallState)
	if !ok {
		return nil, &Error{Code: CodeProtocol}
	}
	return clone, nil
}

// validAgentResult screens one answer against the action that was sent.
//
// It lives here rather than in `files.go` for the reason the git screening does:
// what makes an agent answer well formed is an agent-domain question, and the
// frame validator should not have to know six of them.
func validAgentResult(input *pb.AgentWorkerRequest, result *pb.AgentWorkerResponse) bool {
	if result == nil {
		return false
	}
	switch {
	case input.GetListAgents() != nil:
		states := result.GetAgents()
		if states == nil {
			return false
		}
		// One entry per node, named once. A duplicate would make a handback
		// comparison read the second copy and never notice the first differed.
		seen := map[string]bool{}
		for _, state := range states.GetAgents() {
			if state == nil || state.GetNodeId() == "" || seen[state.GetNodeId()] {
				return false
			}
			seen[state.GetNodeId()] = true
		}
		for _, approval := range states.GetApprovals() {
			if approval == nil || approval.GetApprovalId() == "" {
				return false
			}
		}
		return true
	case input.GetDrainEvents() != nil:
		drained := result.GetEvents()
		if drained == nil {
			return false
		}
		// Every reported turn has to carry a body that can be checked. One
		// without a digest is a body this Host would have to trust, and a
		// truncated one would then be recorded as a shorter event.
		for _, event := range drained.GetEvents() {
			if event == nil || event.GetNodeId() == "" || event.GetEventId() == "" {
				return false
			}
			if len(event.GetPayload()) > 0 && len(event.GetPayloadSha256()) != sha256.Size {
				return false
			}
		}
		return true
	case input.GetDeliverApproval() != nil, input.GetDeliverHandoff() != nil, input.GetDeliverMessage() != nil:
		return result.GetDelivery() != nil
	case input.GetInstallHooks() != nil:
		return result.GetHooks().GetInstalled()
	case input.GetUninstallHooks() != nil:
		return result.GetHooks() != nil && !result.GetHooks().GetInstalled()
	case input.GetReadTranscript() != nil:
		return result.GetTranscript() != nil
	case input.GetCaptureScreen() != nil:
		return result.GetScreen() != nil
	}
	return false
}

// receipt screens one delivery answer.
//
// An outcome the Worker left unspecified becomes UNKNOWN rather than a success:
// "nothing was said about it" and "it was written" are the two readings, and
// only one of them is safe to record.
func receipt(answer *pb.AgentDeliveryReceipt, fallbackTrace string) (*pb.AgentDeliveryReceipt, error) {
	if answer == nil {
		return nil, &Error{Code: CodeProtocol}
	}
	clone, ok := proto.Clone(answer).(*pb.AgentDeliveryReceipt)
	if !ok {
		return nil, &Error{Code: CodeProtocol}
	}
	if clone.GetTraceId() == "" {
		clone.TraceId = fallbackTrace
	}
	if clone.GetOutcome() == pb.DeliveryOutcome_DELIVERY_OUTCOME_UNSPECIFIED {
		clone.Outcome = pb.DeliveryOutcome_DELIVERY_OUTCOME_UNKNOWN
	}
	return clone, nil
}
