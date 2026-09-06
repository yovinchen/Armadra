package agenthost

import (
	"context"

	pb "armadra.local/host/gen/armadra/v1"
)

// What has to go when a node really goes (Go Host 业务所有权迁移 §2.7).
//
// The canvas domain already tells this one when a board was saved — that is
// what recomputes the context-link projection. The same moment is the only one
// at which "this node no longer exists" becomes true on the Host, so the same
// callback is where the rest of a deleted node's records are retired.
//
// The line is the one `db::orphans` draws on the Runtime side, and for the same
// reasons:
//
//   - **Live rows go.** A status is the node's own state and an open approval is
//     a question nobody can answer. Both still answer a question about a node
//     nothing on the board can reach, which is exactly the kind of record that
//     is only noticed by whoever finds a way to ask.
//   - **Receipts stay.** A delivery, a handoff and an answered approval are
//     records of things that happened. Deleting them would make the history of
//     a workspace depend on whether somebody has since tidied the board.
//   - **Sessions stay.** `sessions.owner_node_id` names a process on a machine.
//     Closing it here would be this Host deciding to end somebody's shell
//     because a sticky was deleted; the reclaim already reports such a session,
//     and a person decides what happens to it.
//
// Everything written here is a tombstone or a state change rather than a row
// removal, because that is what this store is: a revisioned entity that
// disappeared without a tombstone would be a record a client could never learn
// had gone.

// ForgetNodes retires the live agent records of nodes the canvas no longer has.
//
// It returns how many records changed, and it is idempotent: a second pass over
// the same workspace finds nothing left to retire and writes nothing, so a
// canvas save that moved a sticky does not republish a board's worth of agents.
func (s *Service) ForgetNodes(ctx context.Context, workspaceID string) (int, error) {
	if s == nil {
		return 0, nil
	}
	if !validID(workspaceID) {
		return 0, ErrInvalid
	}
	owned, err := s.Owned(ctx)
	if err != nil || !owned {
		// While the Runtime owns the domain its own tables are the record.
		return 0, err
	}
	kinds, err := s.nodeTypes(ctx, workspaceID)
	if err != nil {
		return 0, err
	}
	retired := 0
	statuses, _, err := s.store.ListAgentStatus(ctx, workspaceID, "", MaxPage)
	if err != nil {
		return 0, err
	}
	for _, status := range statuses {
		if _, still := kinds[status.NodeID]; still {
			continue
		}
		// A tombstone is the withdrawal of a node's status, so it carries none:
		// the store refuses one that still names a session or a transcript,
		// because that would read like a node that is merely hidden — which is
		// the one thing it is not.
		gone := status
		gone.Deleted = true
		gone.SessionID = ""
		gone.TranscriptRef = nil
		gone.Unread = 0
		gone.ReasonCode = "agent.node.deleted"
		gone.UpdatedAtMS = s.now()
		stamped, err := stampStatus(gone)
		if err != nil {
			return retired, err
		}
		if _, err = s.store.PutAgentStatus(ctx, "agent/status/"+status.NodeID+"/forget/"+revisionKey(status.Revision), stamped, status.Revision); err != nil {
			return retired, err
		}
		retired++
	}
	// Approvals are listed per node, so the nodes to ask about are exactly the
	// ones the statuses just named as gone. A node that never reported has no
	// status and therefore no approvals either.
	for _, status := range statuses {
		if _, still := kinds[status.NodeID]; still {
			continue
		}
		open, err := s.store.ListApprovals(ctx, status.NodeID, true, MaxPage)
		if err != nil {
			return retired, err
		}
		for _, approval := range open {
			if approval.State != int32(pb.ApprovalState_APPROVAL_STATE_PENDING) {
				// An answered question is a receipt: somebody did answer it.
				continue
			}
			// EXPIRED rather than ANSWERED. Nobody decided this one; the thing it
			// was asked about stopped existing, and recording a decision nobody
			// made would put a permission grant in the history.
			expired := approval
			expired.State = int32(pb.ApprovalState_APPROVAL_STATE_EXPIRED)
			expired.ReasonCode = "agent.node.deleted"
			stamped, err := stampApproval(expired)
			if err != nil {
				return retired, err
			}
			if _, err = s.store.PutApproval(ctx, "agent/approval/"+approval.ApprovalID+"/forget/"+revisionKey(approval.Revision), stamped, approval.Revision); err != nil {
				return retired, err
			}
			retired++
		}
	}
	return retired, nil
}
