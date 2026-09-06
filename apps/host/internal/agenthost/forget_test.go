package agenthost

import (
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
)

// A node's live records go when the node does; its receipts do not. The line is
// the one the Runtime draws in `db::orphans`, and it has to be the same on both
// sides or a rollback would disagree with the database it came from.
func TestForgettingANodeRetiresItsStateAndKeepsItsReceipts(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedNode(nodeOne, "agent")
	f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_WORKING)
	f.seedStatus(nodeTwo, workspaceID, pb.AgentState_AGENT_STATE_DONE)
	f.stageApproval("approval-open", nodeTwo)

	// `nodeTwo` was never seeded as a canvas node, so as far as the board is
	// concerned it has been deleted.
	retired, err := f.service.ForgetNodes(fixtureContext, workspaceID)
	if err != nil {
		t.Fatal(err)
	}
	if retired != 2 {
		t.Fatalf("expected the status and its open question: %d", retired)
	}

	gone, err := f.store.GetAgentStatus(fixtureContext, nodeTwo)
	if err != nil || !gone.Deleted || gone.ReasonCode != "agent.node.deleted" {
		t.Fatalf("the deleted node's status was not retired: %+v %v", gone, err)
	}
	// EXPIRED rather than ANSWERED: nobody decided it, the thing it was asked
	// about stopped existing, and a decision nobody made would be a permission
	// grant in the history.
	approvals, err := f.store.ListApprovals(fixtureContext, nodeTwo, false, 10)
	if err != nil || len(approvals) != 1 {
		t.Fatalf("the question disappeared instead of expiring: %d %v", len(approvals), err)
	}
	if approvals[0].State != int32(pb.ApprovalState_APPROVAL_STATE_EXPIRED) {
		t.Fatalf("an unanswerable question stayed open: %v", pb.ApprovalState(approvals[0].State))
	}

	// The node that is still on the board is untouched.
	kept, err := f.store.GetAgentStatus(fixtureContext, nodeOne)
	if err != nil || kept.Deleted {
		t.Fatalf("a node that is still there was retired: %+v %v", kept, err)
	}

	// And a second pass writes nothing: a canvas save that moved a sticky must
	// not republish a board's worth of agents.
	before := gone.Revision
	if retired, err = f.service.ForgetNodes(fixtureContext, workspaceID); err != nil || retired != 0 {
		t.Fatalf("a second pass rewrote records: %d %v", retired, err)
	}
	after, err := f.store.GetAgentStatus(fixtureContext, nodeTwo)
	if err != nil || after.Revision != before {
		t.Fatalf("an already-retired record moved: %d -> %d %v", before, after.Revision, err)
	}
}

// While the Runtime owns the domain its own tables are the record, and writing
// here as well would be the dual write this migration exists to avoid.
func TestForgettingIsSilentWhileTheRuntimeOwnsTheDomain(t *testing.T) {
	f := newFixture(t)
	f.seedStatus(nodeTwo, workspaceID, pb.AgentState_AGENT_STATE_DONE)
	retired, err := f.service.ForgetNodes(fixtureContext, workspaceID)
	if err != nil || retired != 0 {
		t.Fatalf("the Host wrote agent records it does not own: %d %v", retired, err)
	}
	status, err := f.store.GetAgentStatus(fixtureContext, nodeTwo)
	if err != nil || status.Deleted {
		t.Fatalf("a record was retired under the wrong owner: %+v %v", status, err)
	}
}
