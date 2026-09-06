package agenthost

import (
	"context"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// Permission questions, and the one place they are answered
// (Go Host 业务所有权迁移 §2.7, §6.2 agent 行).
//
// A CLI that asks for permission stops. It is blocked on a read of a file the
// Worker will write; everything here exists so that the answer can be given
// from somewhere other than the machine — a phone, a second laptop — and given
// exactly once.
//
// The order is the whole design, and it is the opposite of the session
// domain's. A session asks the Worker and records the answer, because the
// Worker's answer is the fact. An approval records the decision *first*, under
// CAS, and only then asks the Worker to write it into the file:
//
//   - Recording first is what makes "answered exactly once" true. Two devices
//     that both read a pending approval both try to write revision 1, and the
//     second is refused before any file is touched. Asking the machine first
//     would let both writes land and leave the record to describe whichever
//     returned last.
//   - A failure after the record is honest rather than lost. Somebody did
//     answer; what failed is that the machine did not hear, and that is a state
//     a person can act on — the client shows the answer as recorded and the
//     delivery as unreached, and a retry re-sends the same decision rather than
//     asking the question again.
//
// The `decision` is the CLI's own word and travels unchanged. Mapping `allow`,
// `deny` and `allow_always` onto an enum would be this Host deciding what a
// provider meant, and a provider it has never heard of would lose its answer.

// ListApprovals answers the questions open on one node, oldest first.
func (s *Service) ListApprovals(ctx context.Context, caller Caller, request *pb.ListApprovalsRequest) (*pb.ListApprovalsResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	if _, err := s.requireNode(ctx, caller, request.GetNodeId()); err != nil {
		return nil, err
	}
	approvals, err := s.store.ListApprovals(ctx, request.GetNodeId(), !request.GetIncludeAnswered(), pageSize(request.GetLimit()))
	if err != nil {
		return nil, err
	}
	result := &pb.ListApprovalsResponse{}
	for _, approval := range approvals {
		result.Approvals = append(result.Approvals, approvalMessage(approval))
	}
	return result, nil
}

// Approval reads one question.
func (s *Service) Approval(ctx context.Context, approvalID string) (storage.Approval, error) {
	if !validID(approvalID) {
		return storage.Approval{}, ErrInvalid
	}
	approval, err := s.store.GetApproval(ctx, approvalID)
	if errors.Is(err, storage.ErrNotFound) {
		return storage.Approval{}, ErrNotFound
	}
	return approval, err
}

// AnswerApproval records a decision and then delivers it.
//
// The CAS is what makes the answer singular. The delivery is what unblocks the
// CLI, and it is deliberately not inside the same transaction: a database
// transaction that waited on another machine's filesystem would hold the row
// for as long as that machine took to answer.
func (s *Service) AnswerApproval(ctx context.Context, caller Caller, request *pb.AnswerApprovalRequest) (*pb.AnswerApprovalResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	decision := request.GetDecision()
	if decision == "" || !text(decision, 128) {
		return nil, ErrInvalid
	}
	approval, err := s.Approval(ctx, request.GetApprovalId())
	if err != nil {
		return nil, err
	}
	if approval.WorkspaceID != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	// A question somebody has already decided is not one to decide again.
	// Reloading would not produce a state in which answering is right, so this
	// is its own refusal rather than a revision conflict.
	if approval.State == int32(pb.ApprovalState_APPROVAL_STATE_ANSWERED) {
		return nil, ErrAlreadyAnswered
	}
	answered := approval
	answered.Decision = decision
	answered.AnsweredBy = caller.PrincipalID
	answered.State = int32(pb.ApprovalState_APPROVAL_STATE_ANSWERED)
	answered.AnsweredAtMS = s.now()
	answered.ReasonCode = ""
	if answered, err = stampApproval(answered); err != nil {
		return nil, err
	}
	result, err := s.store.PutApproval(ctx, request.GetOperationId(), answered, request.GetExpectedRevision())
	if err != nil {
		return nil, err
	}
	stored, err := s.store.GetApproval(ctx, approval.ApprovalID)
	if err != nil {
		return nil, err
	}
	// The decision is recorded. Telling the machine is a separate step, and its
	// failure is reported as itself: the answer stands, and what could not
	// happen is the CLI hearing it.
	if !result.Replayed {
		if err = s.deliverAnswer(ctx, stored); err != nil {
			return nil, errors.Join(err, s.markUndelivered(ctx, stored))
		}
	}
	if stored, err = s.store.GetApproval(ctx, approval.ApprovalID); err != nil {
		return nil, err
	}
	return &pb.AnswerApprovalResponse{Approval: approvalMessage(stored), Receipt: receipt(result)}, nil
}

// deliverAnswer writes the decision into the file the CLI is blocked on.
func (s *Service) deliverAnswer(ctx context.Context, approval storage.Approval) error {
	executor, done, err := s.open(ctx, "")
	if err != nil {
		return err
	}
	defer done()
	_, err = executor.DeliverApproval(ctx, &pb.DeliverApprovalAnswerRequest{
		ApprovalId: approval.ApprovalID,
		NodeId:     approval.NodeID,
		SessionId:  approval.SessionID,
		Generation: approval.Generation,
		Decision:   approval.Decision,
		AnsweredBy: approval.AnsweredBy,
	})
	return err
}

// markUndelivered records that the machine did not hear an answer that was
// given. The state stays ANSWERED — it was answered — and the reason code is
// what a client draws as "waiting for the machine" rather than as a question
// still open, which would invite a second answer.
func (s *Service) markUndelivered(ctx context.Context, approval storage.Approval) error {
	stale := approval
	stale.ReasonCode = "agent.approval.undelivered"
	stamped, err := stampApproval(stale)
	if err != nil {
		return err
	}
	_, err = s.store.PutApproval(ctx, "agent/approval/"+approval.ApprovalID+"/undelivered", stamped, approval.Revision)
	return err
}

// recordApproval stores a question the execution host reported.
//
// A question that is already recorded is left alone rather than rewritten: the
// Worker reports whatever it is currently blocked on every time it is drained,
// and rewriting would republish an unchanged approval on every poll — and, for
// one that has since been answered, would take the answer back.
func (s *Service) recordApproval(ctx context.Context, value *pb.Approval) (bool, error) {
	next, err := approvalRecord(value, s.now())
	if err != nil {
		return false, err
	}
	if next.CreatedAtMS <= 0 {
		next.CreatedAtMS = s.now()
	}
	if _, err = s.store.GetApproval(ctx, next.ApprovalID); err == nil {
		return false, nil
	} else if !errors.Is(err, storage.ErrNotFound) {
		return false, err
	}
	if next, err = stampApproval(next); err != nil {
		return false, err
	}
	if _, err = s.store.PutApproval(ctx, "agent/approval/"+next.ApprovalID+"/observed", next, 0); err != nil {
		return false, err
	}
	return true, nil
}
