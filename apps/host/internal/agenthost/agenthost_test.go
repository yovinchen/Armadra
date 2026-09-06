package agenthost

import (
	"errors"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// Every write refuses while somebody else owns the domain. There is no
// dual-write mode, so a Host that answered here would be a second writer.
func TestWritesRefuseUntilTheDomainIsOwned(t *testing.T) {
	f := newFixture(t)
	f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_WORKING)
	caller := f.caller(ScopeWrite, workspaceID)
	if _, err := f.service.MarkRead(fixtureContext, caller, &pb.MarkAgentReadRequest{
		OperationId: "read-1", NodeId: nodeOne,
	}); !errors.Is(err, ErrOwnershipMoved) {
		t.Fatalf("a write was accepted before the switch: %v", err)
	}
	// Reads keep answering throughout: a client has to be able to draw the
	// board whichever side writes it.
	if _, err := f.service.ListStatus(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.ListAgentStatusRequest{}); err != nil {
		t.Fatalf("a read was refused before the switch: %v", err)
	}
	f.own()
	status := f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_WORKING)
	answer, err := f.service.MarkRead(fixtureContext, caller, &pb.MarkAgentReadRequest{
		OperationId: "read-2", NodeId: nodeOne, ExpectedRevision: status.Revision,
	})
	if err != nil || answer.GetStatus().GetUnread() != 0 {
		t.Fatalf("the badge did not clear after the switch: %v", err)
	}
}

// A device answers about its own workspace and no other. Answering about
// another one would say which agents somebody else is running, and what they
// were asked to allow.
func TestOneWorkspaceCannotReadAnother(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedStatus(nodeOne, otherID, pb.AgentState_AGENT_STATE_BLOCKED)
	listed, err := f.service.ListStatus(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.ListAgentStatusRequest{})
	if err != nil || len(listed.GetStatuses()) != 0 {
		t.Fatalf("another workspace's agents were listed: %v %d", err, len(listed.GetStatuses()))
	}
	if _, err = f.service.ListApprovals(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.ListApprovalsRequest{NodeId: nodeOne}); !errors.Is(err, ErrAuthorization) {
		t.Fatalf("another workspace's approvals were readable: %v", err)
	}
}

// The answer is recorded before it is delivered, and that order is what makes
// it singular: two devices that both read a pending question produce one answer
// and one refusal, and the machine is asked exactly once.
func TestAnApprovalIsAnsweredOnceAndThenDelivered(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_BLOCKED)
	f.stageApproval("approval-one", nodeOne)
	approval, err := f.service.Approval(fixtureContext, "approval-one")
	if err != nil {
		t.Fatal(err)
	}
	caller := f.caller(ScopeWrite, workspaceID)
	answered, err := f.service.AnswerApproval(fixtureContext, caller, &pb.AnswerApprovalRequest{
		OperationId: "answer-1", ApprovalId: "approval-one", Decision: "allow",
		ExpectedRevision: approval.Revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if answered.GetApproval().GetDecision() != "allow" || answered.GetApproval().GetAnsweredBy() != "principal" {
		t.Fatalf("the decision was not recorded verbatim: %+v", answered.GetApproval())
	}
	if len(f.machine.answers) != 1 || f.machine.answers[0].GetDecision() != "allow" {
		t.Fatalf("the machine was not told exactly once: %d", len(f.machine.answers))
	}
	// The second device read the same revision and is refused before anything
	// reaches the machine a second time.
	_, err = f.service.AnswerApproval(fixtureContext, caller, &pb.AnswerApprovalRequest{
		OperationId: "answer-2", ApprovalId: "approval-one", Decision: "deny",
		ExpectedRevision: approval.Revision,
	})
	if !errors.Is(err, ErrAlreadyAnswered) {
		t.Fatalf("a second answer was accepted: %v", err)
	}
	if len(f.machine.answers) != 1 {
		t.Fatalf("the machine heard a second answer: %d", len(f.machine.answers))
	}
}

// An answer the machine did not hear is still an answer. Somebody decided; what
// failed is the delivery, and the record says so rather than reverting to a
// question that would invite a second decision.
func TestAnUndeliveredAnswerStaysAnswered(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_BLOCKED)
	f.stageApproval("approval-one", nodeOne)
	approval, err := f.service.Approval(fixtureContext, "approval-one")
	if err != nil {
		t.Fatal(err)
	}
	f.unreachable = true
	_, err = f.service.AnswerApproval(fixtureContext, f.caller(ScopeWrite, workspaceID), &pb.AnswerApprovalRequest{
		OperationId: "answer-1", ApprovalId: "approval-one", Decision: "allow",
		ExpectedRevision: approval.Revision,
	})
	if !errors.Is(err, ErrNoWorker) {
		t.Fatalf("an unreachable machine was not reported: %v", err)
	}
	stored, err := f.service.Approval(fixtureContext, "approval-one")
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != int32(pb.ApprovalState_APPROVAL_STATE_ANSWERED) || stored.Decision != "allow" {
		t.Fatalf("the answer was lost when the machine could not be reached: %+v", stored)
	}
	if stored.ReasonCode != "agent.approval.undelivered" {
		t.Fatalf("the record does not say the machine never heard: %q", stored.ReasonCode)
	}
}

// Preparing freezes; accepting delivers. A bundle that could change between the
// two would be a bundle nobody reviewed.
func TestHandoffFreezesThenDelivers(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_IDLE)
	f.seedStatus(nodeTwo, workspaceID, pb.AgentState_AGENT_STATE_WORKING)
	caller := f.caller(ScopeWrite, workspaceID)
	prepared, err := f.service.PrepareHandoff(fixtureContext, caller, &pb.PrepareHandoffRequest{
		OperationId: "prepare-1", HandoffId: "handoff-one",
		SourceNodeId: nodeTwo, TargetNodeId: nodeOne,
		Source: &pb.SessionAddress{SessionId: "session-node-two", Generation: 1},
		Target: &pb.SessionAddress{SessionId: "session-node-one", Generation: 1},
		Bundle: []byte(`{"summary":"迁移到 Host"}`),
	})
	if err != nil || prepared.GetHandoff().GetState() != pb.HandoffState_HANDOFF_STATE_PREPARED {
		t.Fatalf("preparing did not freeze a bundle: %v %+v", err, prepared.GetHandoff())
	}
	if len(f.machine.handoffs) != 0 {
		t.Fatal("preparing sent something")
	}
	accepted, err := f.service.AcceptHandoff(fixtureContext, caller, &pb.AcceptHandoffRequest{
		OperationId: "accept-1", HandoffId: "handoff-one",
		ExpectedRevision: prepared.GetHandoff().GetRevision(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if accepted.GetHandoff().GetState() != pb.HandoffState_HANDOFF_STATE_DELIVERED {
		t.Fatalf("an accepted handoff did not land: %+v", accepted.GetHandoff())
	}
	if accepted.GetHandoff().GetAttempts() != 1 {
		t.Fatalf("the attempt count is wrong: %d", accepted.GetHandoff().GetAttempts())
	}
	if len(f.machine.handoffs) != 1 {
		t.Fatalf("the machine was not asked exactly once: %d", len(f.machine.handoffs))
	}
	// The bundle reached the target's inbox as well as its pane. A bundle that
	// only reached a pane would be gone the moment it scrolled.
	inbox, err := f.service.ListMailbox(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.ListMailboxRequest{TargetNodeId: nodeOne})
	if err != nil || len(inbox.GetMessages()) != 1 {
		t.Fatalf("the bundle never reached the inbox: %v %d", err, len(inbox.GetMessages()))
	}
	// And a delivery receipt says what happened.
	deliveries, err := f.service.ListDeliveries(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.ListDeliveriesRequest{NodeId: nodeOne})
	if err != nil || len(deliveries.GetDeliveries()) != 1 {
		t.Fatalf("no receipt was recorded: %v %d", err, len(deliveries.GetDeliveries()))
	}
}

// A delivery nobody can attribute is UNKNOWN_OUTCOME, and nothing retries from
// it. Resending would be a second copy of somebody's work in front of an agent
// that may already be acting on the first.
func TestAnUnattributableHandoffIsNotRetried(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_IDLE)
	f.seedStatus(nodeTwo, workspaceID, pb.AgentState_AGENT_STATE_WORKING)
	caller := f.caller(ScopeWrite, workspaceID)
	prepared := f.prepare(caller, "handoff-one")
	f.machine.outcome = pb.DeliveryOutcome_DELIVERY_OUTCOME_UNKNOWN
	accepted, err := f.service.AcceptHandoff(fixtureContext, caller, &pb.AcceptHandoffRequest{
		OperationId: "accept-1", HandoffId: "handoff-one", ExpectedRevision: prepared.GetRevision(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if accepted.GetHandoff().GetState() != pb.HandoffState_HANDOFF_STATE_UNKNOWN_OUTCOME {
		t.Fatalf("an unattributable delivery was recorded as something else: %+v", accepted.GetHandoff())
	}
	// And it cannot be accepted again from that state: a person has to resolve
	// it, because nobody can say whether the target already has it.
	if _, err = f.service.AcceptHandoff(fixtureContext, caller, &pb.AcceptHandoffRequest{
		OperationId: "accept-2", HandoffId: "handoff-one",
		ExpectedRevision: accepted.GetHandoff().GetRevision(),
	}); !errors.Is(err, ErrNotDeliverable) {
		t.Fatalf("an unknown outcome was re-dispatched: %v", err)
	}
}

// A dispatch this Host was in the middle of when it stopped becomes
// UNKNOWN_OUTCOME on the next start. It is not resent and it is not failed.
func TestAnInterruptedDispatchIsReconciledToUnknown(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_IDLE)
	f.seedStatus(nodeTwo, workspaceID, pb.AgentState_AGENT_STATE_WORKING)
	prepared := f.prepare(f.caller(ScopeWrite, workspaceID), "handoff-one")
	stored, err := f.service.Handoff(fixtureContext, "handoff-one")
	if err != nil {
		t.Fatal(err)
	}
	// A claim left by a Host that is gone: a different instance id.
	claimed := stored
	claimed.State = int32(pb.HandoffState_HANDOFF_STATE_DISPATCHING)
	claimed.ClaimedAtMS, claimed.ClaimInstanceID = f.clock.UnixMilli(), "host-instance-0"
	claimed.UpdatedAtMS = f.clock.UnixMilli()
	if claimed, err = stampHandoff(claimed); err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.PutHandoff(fixtureContext, "test/claim", claimed, prepared.GetRevision()); err != nil {
		t.Fatal(err)
	}
	settled, err := f.service.ReconcileHandoffs(fixtureContext)
	if err != nil || settled != 1 {
		t.Fatalf("the interrupted dispatch was not settled: %d %v", settled, err)
	}
	final, err := f.service.Handoff(fixtureContext, "handoff-one")
	if err != nil {
		t.Fatal(err)
	}
	if final.State != int32(pb.HandoffState_HANDOFF_STATE_UNKNOWN_OUTCOME) || final.ClaimInstanceID != "" {
		t.Fatalf("the claim survived the reconciliation: %+v", final)
	}
	if len(f.machine.handoffs) != 0 {
		t.Fatal("a reconciliation resent a bundle")
	}
}

// A drain records what the machine observed and moves the cursor only over what
// was stored. Running it twice records nothing new.
func TestDrainIsIdempotentAndMovesTheCursorLast(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.machine.queued = []*pb.DrainedAgentEvents{f.turn(nodeOne, pb.AgentState_AGENT_STATE_BLOCKED, 7)}
	outcome, err := f.service.Drain(fixtureContext, "")
	if err != nil || outcome.Statuses != 1 || outcome.Approvals != 1 {
		t.Fatalf("the drain did not record what the machine reported: %v %+v", err, outcome)
	}
	if outcome.Cursor != 7 {
		t.Fatalf("the cursor did not move to the reported sequence: %d", outcome.Cursor)
	}
	status, err := f.service.Status(fixtureContext, nodeOne)
	if err != nil || status.State != int32(pb.AgentState_AGENT_STATE_BLOCKED) {
		t.Fatalf("the reduced state did not land: %v %+v", err, status)
	}
	// The same report again — which is what a Worker answers until its own
	// cursor passes it — records nothing and does not republish.
	f.machine.queued = []*pb.DrainedAgentEvents{f.turn(nodeOne, pb.AgentState_AGENT_STATE_BLOCKED, 7)}
	repeat, err := f.service.Drain(fixtureContext, "")
	if err != nil || repeat.Statuses != 0 || repeat.Approvals != 0 {
		t.Fatalf("a repeated drain recorded again: %v %+v", err, repeat)
	}
}

// A turn reported for a generation the machine has already replaced describes a
// pane nobody is watching. Applying it would make a recycled node look busy.
func TestAStaleGenerationDoesNotReviveANode(t *testing.T) {
	f := newFixture(t)
	f.own()
	current := f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_IDLE)
	fresh := current
	fresh.Generation = 5
	fresh.UpdatedAtMS = f.clock.UnixMilli() + 1
	stamped, err := stampStatus(fresh)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.PutAgentStatus(fixtureContext, "test/recycle", stamped, current.Revision); err != nil {
		t.Fatal(err)
	}
	stale := f.turn(nodeOne, pb.AgentState_AGENT_STATE_WORKING, 9)
	stale.Events[0].Generation = 2
	f.machine.queued = []*pb.DrainedAgentEvents{stale}
	if _, err = f.service.Drain(fixtureContext, ""); err != nil {
		t.Fatal(err)
	}
	status, err := f.service.Status(fixtureContext, nodeOne)
	if err != nil || status.State != int32(pb.AgentState_AGENT_STATE_IDLE) {
		t.Fatalf("a stale turn revived a replaced pane: %v %+v", err, status)
	}
}

// The projection is derived from the canvas' edges and from nothing else. A
// client cannot write it, so an agent reads a neighbour because somebody drew a
// line — never because a request said so.
func TestContextLinksFollowTheCanvasEdges(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedNode(nodeOne, "agent")
	f.seedNode(nodeTwo, "agent")
	f.seedEdge("edge-one", nodeTwo, nodeOne)
	changed, err := f.service.RefreshContextLinks(fixtureContext, workspaceID)
	if err != nil || changed != 2 {
		t.Fatalf("both ends of the edge were not projected: %d %v", changed, err)
	}
	links, err := f.service.ListContextLinks(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.ListContextLinksRequest{NodeId: nodeOne})
	if err != nil || len(links.GetLinks()) != 1 || len(links.GetLinks()[0].GetLinks()) != 1 {
		t.Fatalf("the target end has no link: %v %+v", err, links.GetLinks())
	}
	if links.GetLinks()[0].GetLinks()[0].GetDirection() != pb.ContextLinkDirection_CONTEXT_LINK_DIRECTION_INCOMING {
		t.Fatalf("the direction is wrong: %+v", links.GetLinks()[0].GetLinks()[0])
	}
	// Recomputing an unchanged board writes nothing, so a canvas save that
	// moved a sticky does not republish every agent's connections.
	if changed, err = f.service.RefreshContextLinks(fixtureContext, workspaceID); err != nil || changed != 0 {
		t.Fatalf("an unchanged projection was rewritten: %d %v", changed, err)
	}
	// Removing the edge leaves a row with an empty list rather than no row:
	// "connected to nothing" and "nobody has looked" are different answers.
	f.deleteEdge("edge-one")
	if changed, err = f.service.RefreshContextLinks(fixtureContext, workspaceID); err != nil || changed != 2 {
		t.Fatalf("removing the edge did not clear both ends: %d %v", changed, err)
	}
	cleared, err := f.store.GetContextLinks(fixtureContext, nodeOne)
	if err != nil || len(cleared.Links) != 0 {
		t.Fatalf("the row was deleted rather than cleared: %v %+v", err, cleared)
	}
}

// Installing a Hook edits a file on the execution host. It is forwarded, and it
// is checked as execution because it makes a CLI on that machine call back.
func TestHooksAreForwardedAndNeedExecution(t *testing.T) {
	f := newFixture(t)
	f.own()
	if _, err := f.service.InstallHooks(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.InstallHooksRequest{AgentId: "claude"}); !errors.Is(err, ErrAuthorization) {
		t.Fatalf("a read grant installed a Hook: %v", err)
	}
	state, err := f.service.InstallHooks(fixtureContext, f.caller(ScopeWrite, workspaceID), &pb.InstallHooksRequest{AgentId: "claude"})
	if err != nil || !state.GetState().GetInstalled() {
		t.Fatalf("the install was not forwarded: %v %+v", err, state.GetState())
	}
	if len(f.machine.installs) != 1 || f.machine.installs[0] != "claude" {
		t.Fatalf("the machine was not asked: %v", f.machine.installs)
	}
}

// The event stream carries six kinds, and an approval carries the priority a
// question a human is waited on has to have.
func TestEveryRecordReachesTheStreamWithItsOwnKind(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_BLOCKED)
	f.stageApproval("approval-one", nodeOne)
	events, err := f.store.GetEvents(fixtureContext, storage.EventQuery{})
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]pb.EventPriority{}
	for _, event := range events.Events {
		envelope, err := (EventProjector{}).Project(event)
		if err != nil {
			t.Fatal(err)
		}
		if envelope == nil {
			continue
		}
		if envelope.GetDomain() != pb.EventDomain_EVENT_DOMAIN_AGENT {
			t.Fatalf("an agent event was published in another domain: %v", envelope.GetDomain())
		}
		seen[envelope.GetKind()] = envelope.GetPriority()
	}
	if seen["status"] != pb.EventPriority_EVENT_PRIORITY_NORMAL {
		t.Fatalf("a status did not travel as an ordinary change: %v", seen)
	}
	if seen["approval"] != pb.EventPriority_EVENT_PRIORITY_HIGH {
		t.Fatalf("an approval did not travel ahead of ordinary changes: %v", seen)
	}
}
