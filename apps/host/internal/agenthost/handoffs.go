package agenthost

import (
	"context"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// Handing work from one agent to another (Go Host 业务所有权迁移 §2.7, §6.2).
//
// Four steps, and they are four because each is a different decision somebody
// takes at a different moment:
//
//	Prepare   freeze what would be sent. Nothing is sent.
//	Accept    decide it should be. This is where a message enters an inbox and
//	          the bundle is put in front of the target.
//	Cancel    withdraw it, at any point before it lands.
//	Get/List  read where it stands.
//
// Preparing and accepting are separate because a bundle that could change
// between being reviewed and being delivered is a bundle nobody reviewed. The
// digest is what makes the freeze checkable, and both the database (a trigger)
// and this package refuse a change to it.
//
// The dispatch is claimed before the write and never automatically re-claimed
// after a crash. A handoff found still DISPATCHING by a later Host becomes
// UNKNOWN_OUTCOME, because "the write may or may not have reached the terminal"
// is the honest reading and a resend would be a second copy of somebody's work
// in front of an agent that may already be acting on the first.

// Handoff reads one record.
func (s *Service) Handoff(ctx context.Context, handoffID string) (storage.Handoff, error) {
	if !validID(handoffID) {
		return storage.Handoff{}, ErrInvalid
	}
	handoff, err := s.store.GetHandoff(ctx, handoffID)
	if errors.Is(err, storage.ErrNotFound) {
		return storage.Handoff{}, ErrNotFound
	}
	return handoff, err
}

// GetHandoff answers one handoff to a caller in its workspace.
func (s *Service) GetHandoff(ctx context.Context, caller Caller, request *pb.GetHandoffRequest) (*pb.GetHandoffResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	handoff, err := s.Handoff(ctx, request.GetHandoffId())
	if err != nil {
		return nil, err
	}
	if handoff.WorkspaceID != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	return &pb.GetHandoffResponse{Handoff: handoffMessage(handoff)}, nil
}

// ListHandoffs answers both directions for one node: what it was handed, and
// what it handed on. A card shows both, so one listing answers both.
func (s *Service) ListHandoffs(ctx context.Context, caller Caller, request *pb.ListHandoffsRequest) (*pb.ListHandoffsResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	if _, err := s.requireNode(ctx, caller, request.GetNodeId()); err != nil {
		return nil, err
	}
	handoffs, err := s.store.ListHandoffs(ctx, request.GetNodeId(), pageSize(request.GetLimit()))
	if err != nil {
		return nil, err
	}
	result := &pb.ListHandoffsResponse{}
	for _, handoff := range handoffs {
		if handoff.WorkspaceID != caller.WorkspaceID {
			continue
		}
		result.Handoffs = append(result.Handoffs, handoffMessage(handoff))
	}
	return result, nil
}

// PrepareHandoff freezes a bundle and records that it exists. Nothing is sent.
func (s *Service) PrepareHandoff(ctx context.Context, caller Caller, request *pb.PrepareHandoffRequest) (*pb.PrepareHandoffResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	if !validID(request.GetHandoffId()) || !validID(request.GetSourceNodeId()) || !validID(request.GetTargetNodeId()) {
		return nil, ErrInvalid
	}
	bundle := request.GetBundle()
	if len(bundle) == 0 || len(bundle) > MaxBundleBytes {
		return nil, ErrInvalid
	}
	// Both endpoints have to be nodes in this caller's workspace. A handoff
	// whose target is somewhere else would put one workspace's work in front of
	// another's agent.
	if _, err := s.requireNode(ctx, caller, request.GetSourceNodeId()); err != nil {
		return nil, err
	}
	if _, err := s.requireNode(ctx, caller, request.GetTargetNodeId()); err != nil {
		return nil, err
	}
	now := s.now()
	handoff := storage.Handoff{
		HandoffID:       request.GetHandoffId(),
		WorkspaceID:     caller.WorkspaceID,
		SourceNodeID:    request.GetSourceNodeId(),
		TargetNodeID:    request.GetTargetNodeId(),
		SourceSessionID: request.GetSource().GetSessionId(),
		SourceGen:       request.GetSource().GetGeneration(),
		TargetSessionID: request.GetTarget().GetSessionId(),
		TargetGen:       request.GetTarget().GetGeneration(),
		Bundle:          bundle,
		BundleSHA256:    digest(bundle),
		State:           int32(pb.HandoffState_HANDOFF_STATE_PREPARED),
		CreatedAtMS:     now,
		UpdatedAtMS:     now,
	}
	stamped, err := stampHandoff(handoff)
	if err != nil {
		return nil, err
	}
	result, err := s.store.PutHandoff(ctx, request.GetOperationId(), stamped, request.GetExpectedRevision())
	if errors.Is(err, storage.ErrHandoffFrozen) {
		return nil, ErrFrozen
	}
	if err != nil {
		return nil, err
	}
	stored, err := s.store.GetHandoff(ctx, handoff.HandoffID)
	if err != nil {
		return nil, err
	}
	return &pb.PrepareHandoffResponse{Handoff: handoffMessage(stored), Receipt: receipt(result)}, nil
}

// AcceptHandoff queues the bundle, puts it in the target's inbox, and asks the
// machine to put it in front of the agent.
//
// The claim is written before the machine is asked. That order is what makes a
// crash mid-dispatch decidable: a row left claimed says somebody was in the
// middle of delivering, which is the difference between "resend it" and "a
// person has to look".
func (s *Service) AcceptHandoff(ctx context.Context, caller Caller, request *pb.AcceptHandoffRequest) (*pb.AcceptHandoffResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	handoff, err := s.Handoff(ctx, request.GetHandoffId())
	if err != nil {
		return nil, err
	}
	if handoff.WorkspaceID != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	switch pb.HandoffState(handoff.State) {
	case pb.HandoffState_HANDOFF_STATE_PREPARED, pb.HandoffState_HANDOFF_STATE_QUEUED, pb.HandoffState_HANDOFF_STATE_FAILED:
	default:
		return nil, ErrNotDeliverable
	}
	now := s.now()
	claimed := handoff
	claimed.State = int32(pb.HandoffState_HANDOFF_STATE_DISPATCHING)
	claimed.Attempts = handoff.Attempts + 1
	claimed.ClaimedAtMS = now
	claimed.ClaimInstanceID = s.options.InstanceID
	claimed.AcceptedAtMS = now
	claimed.UpdatedAtMS = now
	claimed.ErrorCode = ""
	if claimed, err = stampHandoff(claimed); err != nil {
		return nil, err
	}
	result, err := s.store.PutHandoff(ctx, request.GetOperationId(), claimed, request.GetExpectedRevision())
	if err != nil {
		return nil, err
	}
	if result.Replayed {
		stored, err := s.store.GetHandoff(ctx, handoff.HandoffID)
		if err != nil {
			return nil, err
		}
		return &pb.AcceptHandoffResponse{Handoff: handoffMessage(stored), Receipt: receipt(result)}, nil
	}
	final, err := s.dispatch(ctx, claimed)
	if err != nil {
		return nil, err
	}
	return &pb.AcceptHandoffResponse{Handoff: handoffMessage(final), Receipt: receipt(result)}, nil
}

// dispatch puts the bundle in the target's inbox and in front of the agent.
//
// The mailbox message is written first and on purpose: it is the durable half.
// A bundle that reached an inbox but not a pane is one the target can still
// read; a bundle that reached a pane but nothing else would be gone the moment
// the pane scrolled.
func (s *Service) dispatch(ctx context.Context, handoff storage.Handoff) (storage.Handoff, error) {
	message := storage.MailboxMessage{
		MessageID:    handoff.HandoffID + ".bundle",
		WorkspaceID:  handoff.WorkspaceID,
		SourceNodeID: handoff.SourceNodeID,
		TargetNodeID: handoff.TargetNodeID,
		MessageKey:   "handoff/" + handoff.HandoffID,
		Body:         string(handoff.Bundle),
		CreatedAtMS:  s.now(),
	}
	if len(message.Body) > MaxBodyChars {
		// A bundle too large for an inbox still travels to the pane; what the
		// message carries instead is the identifier, so the target can ask for
		// it rather than being handed a truncated copy of somebody's work.
		message.Body = "handoff:" + handoff.HandoffID
	}
	stored, err := s.post(ctx, "agent/handoff/"+handoff.HandoffID+"/mailbox", message)
	if err != nil {
		return storage.Handoff{}, err
	}
	executor, done, openErr := s.open(ctx, "")
	if openErr != nil {
		// Nothing was put in front of the agent. The bundle is in the inbox and
		// the state says so, which is a state a person can act on: the target
		// can read it, and a later accept can try the pane again.
		return s.settle(ctx, handoff, stored.MessageID, "", pb.HandoffState_HANDOFF_STATE_QUEUED, "agent.handoff.unreachable")
	}
	defer done()
	answer, err := executor.DeliverHandoff(ctx, &pb.DeliverHandoffRequest{
		HandoffId:    handoff.HandoffID,
		WorkspaceId:  handoff.WorkspaceID,
		SourceNodeId: handoff.SourceNodeID,
		TargetNodeId: handoff.TargetNodeID,
		Target:       &pb.SessionAddress{SessionId: handoff.TargetSessionID, Generation: handoff.TargetGen},
		Bundle:       handoff.Bundle,
		BundleSha256: handoff.BundleSHA256,
	})
	if err != nil {
		// The machine was reached and the write failed mid-flight, or the
		// answer never came. Neither says whether anything was written, and
		// nothing here retries out of that.
		return s.settle(ctx, handoff, stored.MessageID, "", pb.HandoffState_HANDOFF_STATE_UNKNOWN_OUTCOME, "agent.handoff.unattributable")
	}
	delivery := s.deliveryFrom(answer, handoff.WorkspaceID, handoff.SourceNodeID, handoff.TargetNodeID)
	if delivery.TraceID == "" {
		delivery.TraceID = handoff.HandoffID + ".delivery"
	}
	stamped, err := stampDelivery(delivery)
	if err != nil {
		return storage.Handoff{}, err
	}
	if _, err = s.store.PutDelivery(ctx, "agent/handoff/"+handoff.HandoffID+"/delivery", stamped, 0); err != nil && !errors.Is(err, storage.ErrIdempotencyConflict) {
		return storage.Handoff{}, err
	}
	state, reason := pb.HandoffState_HANDOFF_STATE_DELIVERED, ""
	switch pb.DeliveryOutcome(delivery.Outcome) {
	case pb.DeliveryOutcome_DELIVERY_OUTCOME_NOT_WRITTEN:
		// Affirmative proof that nothing was written, which is the one failure
		// somebody may safely try again.
		state, reason = pb.HandoffState_HANDOFF_STATE_FAILED, "agent.handoff.not_written"
	case pb.DeliveryOutcome_DELIVERY_OUTCOME_SUBMITTED:
	default:
		state, reason = pb.HandoffState_HANDOFF_STATE_UNKNOWN_OUTCOME, "agent.handoff.unattributable"
	}
	return s.settle(ctx, handoff, stored.MessageID, delivery.TraceID, state, reason)
}

// settle writes the outcome of one dispatch and releases the claim.
func (s *Service) settle(ctx context.Context, handoff storage.Handoff, mailboxID, traceID string, state pb.HandoffState, reason string) (storage.Handoff, error) {
	current, err := s.store.GetHandoff(ctx, handoff.HandoffID)
	if err != nil {
		return storage.Handoff{}, err
	}
	settled := current
	settled.MailboxID = mailboxID
	settled.TraceID = traceID
	settled.State = int32(state)
	settled.ErrorCode = reason
	settled.ClaimedAtMS, settled.ClaimInstanceID = 0, ""
	settled.UpdatedAtMS = s.now()
	if settled, err = stampHandoff(settled); err != nil {
		return storage.Handoff{}, err
	}
	if _, err = s.store.PutHandoff(ctx, "agent/handoff/"+handoff.HandoffID+"/settle/"+reasonKey(state, reason), settled, current.Revision); err != nil {
		return storage.Handoff{}, err
	}
	return s.store.GetHandoff(ctx, handoff.HandoffID)
}

// reasonKey makes the settling write's operation id specific to the outcome, so
// two dispatches that ended differently are two operations rather than one
// replay of the other.
func reasonKey(state pb.HandoffState, reason string) string {
	if reason == "" {
		return state.String()
	}
	return state.String() + "/" + reason
}

// CancelHandoff withdraws one before it lands.
//
// A delivered or acknowledged handoff cannot be cancelled: the target has it,
// and a record that said otherwise would be a record that lied about what an
// agent was given.
func (s *Service) CancelHandoff(ctx context.Context, caller Caller, request *pb.CancelHandoffRequest) (*pb.CancelHandoffResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	handoff, err := s.Handoff(ctx, request.GetHandoffId())
	if err != nil {
		return nil, err
	}
	if handoff.WorkspaceID != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	switch pb.HandoffState(handoff.State) {
	case pb.HandoffState_HANDOFF_STATE_PREPARED, pb.HandoffState_HANDOFF_STATE_QUEUED, pb.HandoffState_HANDOFF_STATE_FAILED:
	default:
		return nil, ErrNotDeliverable
	}
	reason := request.GetReasonCode()
	if reason == "" {
		reason = "agent.handoff.cancelled"
	}
	if !text(reason, 64) {
		return nil, ErrInvalid
	}
	cancelled := handoff
	cancelled.State = int32(pb.HandoffState_HANDOFF_STATE_CANCELLED)
	cancelled.ErrorCode = reason
	cancelled.ClaimedAtMS, cancelled.ClaimInstanceID = 0, ""
	cancelled.UpdatedAtMS = s.now()
	if cancelled, err = stampHandoff(cancelled); err != nil {
		return nil, err
	}
	result, err := s.store.PutHandoff(ctx, request.GetOperationId(), cancelled, request.GetExpectedRevision())
	if err != nil {
		return nil, err
	}
	stored, err := s.store.GetHandoff(ctx, handoff.HandoffID)
	if err != nil {
		return nil, err
	}
	return &pb.CancelHandoffResponse{Handoff: handoffMessage(stored), Receipt: receipt(result)}, nil
}

// ReconcileHandoffs settles what this Host left in flight when it stopped.
//
// A row still DISPATCHING is one whose write may or may not have reached a
// terminal. It becomes UNKNOWN_OUTCOME and stays there until a person decides:
// re-dispatching would be a second copy of somebody's work in front of an agent
// that may already be acting on the first, and marking it failed would tell a
// user nothing happened when something may well have.
func (s *Service) ReconcileHandoffs(ctx context.Context) (int, error) {
	handoffs, err := s.store.AllHandoffs(ctx)
	if err != nil {
		return 0, err
	}
	settled := 0
	for _, handoff := range handoffs {
		if pb.HandoffState(handoff.State) != pb.HandoffState_HANDOFF_STATE_DISPATCHING {
			continue
		}
		// A claim this very process still holds is a dispatch in flight right
		// now, not a leftover.
		if handoff.ClaimInstanceID == s.options.InstanceID && s.options.InstanceID != "" {
			continue
		}
		unknown := handoff
		unknown.State = int32(pb.HandoffState_HANDOFF_STATE_UNKNOWN_OUTCOME)
		unknown.ErrorCode = "agent.handoff.interrupted"
		unknown.ClaimedAtMS, unknown.ClaimInstanceID = 0, ""
		unknown.UpdatedAtMS = s.now()
		if unknown, err = stampHandoff(unknown); err != nil {
			return settled, err
		}
		if _, err = s.store.PutHandoff(ctx, "agent/handoff/"+handoff.HandoffID+"/reconcile", unknown, handoff.Revision); err != nil {
			return settled, err
		}
		settled++
	}
	return settled, nil
}
