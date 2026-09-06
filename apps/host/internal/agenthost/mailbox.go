package agenthost

import (
	"context"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// Inboxes and receipts (Go Host 业务所有权迁移 §2.7).
//
// A mailbox message is a thing that exists until somebody reads it. A delivery
// is a record of an attempt that cannot stop having happened. They look similar
// and behave oppositely, which is why they are separate here as they are in the
// schema: a message can be acknowledged and withdrawn, a receipt can only ever
// be added to.
//
// Both arrive from two directions and that is the interesting part. A client
// can list them over HTTPS, and the execution host reports them upward when a
// Hook's own verbs are used — an agent that wrote `canvas post` did not go
// through this Host at all. Recording those is idempotent by identifier, so a
// drain the Host did not finish is one it asks for again rather than one that
// doubles an inbox.

// ListMailbox answers one node's inbox, oldest first.
func (s *Service) ListMailbox(ctx context.Context, caller Caller, request *pb.ListMailboxRequest) (*pb.ListMailboxResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	if _, err := s.requireNode(ctx, caller, request.GetTargetNodeId()); err != nil {
		return nil, err
	}
	messages, err := s.store.ListMailbox(ctx, request.GetTargetNodeId(), !request.GetIncludeAcknowledged(), pageSize(request.GetLimit()))
	if err != nil {
		return nil, err
	}
	result := &pb.ListMailboxResponse{}
	for _, message := range messages {
		result.Messages = append(result.Messages, mailboxMessage(message))
	}
	return result, nil
}

// ListDeliveries answers what a node was told, newest first.
func (s *Service) ListDeliveries(ctx context.Context, caller Caller, request *pb.ListDeliveriesRequest) (*pb.ListDeliveriesResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	if _, err := s.requireNode(ctx, caller, request.GetNodeId()); err != nil {
		return nil, err
	}
	deliveries, err := s.store.ListDeliveries(ctx, request.GetNodeId(), pageSize(request.GetLimit()))
	if err != nil {
		return nil, err
	}
	result := &pb.ListDeliveriesResponse{}
	for _, delivery := range deliveries {
		result.Deliveries = append(result.Deliveries, deliveryMessage(delivery))
	}
	return result, nil
}

// post records one message and allocates its place in the target's inbox.
//
// The sequence comes from the table rather than from the caller, so two nodes
// posting at the same moment cannot claim one position. The unique key over
// (source, target, key) is what makes a retrying sender harmless: the second
// post of one thought is refused by the database rather than added as a second
// copy somebody has to read twice.
func (s *Service) post(ctx context.Context, operationID string, message storage.MailboxMessage) (storage.MailboxMessage, error) {
	existing, err := s.store.GetMailboxMessage(ctx, message.MessageID)
	switch {
	case err == nil:
		return existing, nil
	case errors.Is(err, storage.ErrNotFound):
	default:
		return storage.MailboxMessage{}, err
	}
	if message.Sequence == 0 {
		if message.Sequence, err = s.store.NextMailboxSequence(ctx); err != nil {
			return storage.MailboxMessage{}, err
		}
	}
	if message, err = stampMailbox(message); err != nil {
		return storage.MailboxMessage{}, err
	}
	if _, err = s.store.PutMailboxMessage(ctx, operationID, message, 0); err != nil {
		return storage.MailboxMessage{}, err
	}
	return s.store.GetMailboxMessage(ctx, message.MessageID)
}

// acknowledge marks one message read. An already-acknowledged message is left
// alone rather than restamped, so a replayed acknowledgement does not move the
// moment somebody actually read it.
func (s *Service) acknowledge(ctx context.Context, operationID, messageID string) error {
	message, err := s.store.GetMailboxMessage(ctx, messageID)
	if errors.Is(err, storage.ErrNotFound) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if message.AckedAtMS > 0 || message.Deleted {
		return nil
	}
	message.AckedAtMS = s.now()
	if message, err = stampMailbox(message); err != nil {
		return err
	}
	_, err = s.store.PutMailboxMessage(ctx, operationID, message, message.Revision)
	return err
}

// recordMessage stores a message the execution host reported, by identifier.
//
// A message already recorded is left alone. The Hook's own `post` verb reached
// the machine, not this Host, so the same message can be reported on every
// drain until the cursor passes it; recording it twice would put two copies in
// one inbox.
func (s *Service) recordMessage(ctx context.Context, message storage.MailboxMessage) (bool, error) {
	if !validID(message.MessageID) || !validID(message.WorkspaceID) ||
		!validID(message.SourceNodeID) || !validID(message.TargetNodeID) ||
		!text(message.Body, MaxBodyChars) || !text(message.MessageKey, 256) {
		return false, ErrInvalid
	}
	if _, err := s.store.GetMailboxMessage(ctx, message.MessageID); err == nil {
		return false, nil
	} else if !errors.Is(err, storage.ErrNotFound) {
		return false, err
	}
	if message.CreatedAtMS <= 0 {
		message.CreatedAtMS = s.now()
	}
	stored, err := s.post(ctx, "agent/mailbox/"+message.MessageID+"/observed", message)
	if err != nil {
		return false, err
	}
	return stored.MessageID != "", nil
}

// recordDelivery stores one receipt the execution host reported.
//
// A receipt already recorded is left alone for the reason a message is: it
// describes something that happened once, and a second row would make a
// delivery log say an agent was told the same thing twice.
func (s *Service) recordDelivery(ctx context.Context, value *pb.Delivery) (bool, error) {
	if value == nil || !validID(value.GetTraceId()) || !validID(value.GetWorkspaceId()) || !validID(value.GetTargetNodeId()) {
		return false, ErrInvalid
	}
	if source := value.GetSourceNodeId(); source != "" && !validID(source) {
		return false, ErrInvalid
	}
	if !text(value.GetReceipt(), 1024) || !text(value.GetReasonCode(), 64) {
		return false, ErrInvalid
	}
	if _, err := s.store.GetDelivery(ctx, value.GetTraceId()); err == nil {
		return false, nil
	} else if !errors.Is(err, storage.ErrNotFound) {
		return false, err
	}
	created := value.GetCreatedAtUnixMs()
	if created <= 0 {
		created = s.now()
	}
	delivery := storage.Delivery{
		TraceID:      value.GetTraceId(),
		WorkspaceID:  value.GetWorkspaceId(),
		SourceNodeID: value.GetSourceNodeId(),
		TargetNodeID: value.GetTargetNodeId(),
		Receipt:      value.GetReceipt(),
		BodyChars:    value.GetBodyChars(),
		Outcome:      int32(value.GetOutcome()),
		ReasonCode:   value.GetReasonCode(),
		CreatedAtMS:  created,
	}
	stamped, err := stampDelivery(delivery)
	if err != nil {
		return false, err
	}
	if _, err = s.store.PutDelivery(ctx, "agent/delivery/"+delivery.TraceID+"/observed", stamped, 0); err != nil {
		return false, err
	}
	return true, nil
}

// deliveryFrom turns a Worker receipt into the record for one attempt this Host
// asked for. It never invents an outcome: an answer this build cannot read is
// UNKNOWN, which is the one outcome nothing retries from automatically.
func (s *Service) deliveryFrom(receipt *pb.AgentDeliveryReceipt, workspaceID, source, target string) storage.Delivery {
	outcome := receipt.GetOutcome()
	if outcome == pb.DeliveryOutcome_DELIVERY_OUTCOME_UNSPECIFIED {
		outcome = pb.DeliveryOutcome_DELIVERY_OUTCOME_UNKNOWN
	}
	created := receipt.GetObservedAtUnixMs()
	if created <= 0 {
		created = s.now()
	}
	return storage.Delivery{
		TraceID:      receipt.GetTraceId(),
		WorkspaceID:  workspaceID,
		SourceNodeID: source,
		TargetNodeID: target,
		Receipt:      receipt.GetReceipt(),
		BodyChars:    receipt.GetBodyChars(),
		Outcome:      int32(outcome),
		ReasonCode:   receipt.GetReasonCode(),
		CreatedAtMS:  created,
	}
}
