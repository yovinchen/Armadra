package agenthost

import (
	"bytes"
	"context"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// Keeping the turn, not only what it left behind
// (Go Host 业务所有权迁移 §2.7 `HookEvent`, events.proto entity 181).
//
// Until now a Hook event was folded into `agent_status` and discarded. That
// made the *current* state durable and how it got there unrecoverable: an
// approval that appeared and was answered between two drains left no trace, and
// "idle for an hour" and "nothing has ever reported here" were the same row.
//
// So the normalized event is recorded as well, and published. Three properties
// carry the weight:
//
//   - **The event id is the execution host's.** It names the thing that
//     happened — a node and the instant it was observed — so a report that
//     arrives twice (a pull that overlapped a push, a Worker replaying its
//     outbox) writes one row. Recording is idempotent by construction rather
//     than by a lock.
//   - **A body that does not match its digest is refused.** It stays opaque
//     here, so the digest is the only thing that can tell a truncated body from
//     a short one.
//   - **Recording and folding are separate steps in one call.** The history is
//     written even when the reduction is skipped as stale, because "a turn was
//     reported for a pane that has since been replaced" is exactly the kind of
//     thing somebody looks for afterwards.

// ObserveHookEvent records one normalized event and folds it into the node's
// status.
//
// It is the single entry point for both directions §2.7 allows: the Host's own
// drain, which asks, and the Worker's upcall, which tells. They converge here
// so that neither can record something the other would have recorded
// differently.
func (s *Service) ObserveHookEvent(ctx context.Context, event *pb.HookEvent) (bool, error) {
	// The drain checks this before it asks; the upcall arrives unasked, so the
	// check has to be here as well. While the Runtime owns the domain its own
	// tables are the record, and writing here too would be the dual write this
	// migration exists to avoid — with the twist that a push, unlike a pull,
	// would do it without anybody having called anything.
	//
	// Accepting the frame and changing nothing is deliberate. Refusing it would
	// leave it unacknowledged and replayed forever against a Host that will
	// never be allowed to record it.
	owned, err := s.Owned(ctx)
	if err != nil || !owned {
		return false, err
	}
	if err := s.recordHookEvent(ctx, event); err != nil {
		return false, err
	}
	return s.applyHookEvent(ctx, event)
}

// recordHookEvent writes the event itself. A conflict is success: the same
// event id is already on file, which is what a replay is supposed to look like.
func (s *Service) recordHookEvent(ctx context.Context, event *pb.HookEvent) error {
	if event == nil || !validID(event.GetNodeId()) || !validID(event.GetWorkspaceId()) {
		return ErrInvalid
	}
	id := event.GetEventId()
	if !text(id, 256) || id == "" {
		return ErrInvalid
	}
	body := event.GetPayload()
	if len(body) > 0 && !bytes.Equal(digest(body), event.GetPayloadSha256()) {
		return ErrInvalid
	}
	if session := event.GetSessionId(); session != "" && !validID(session) {
		return ErrInvalid
	}
	if !text(event.GetProvider(), 64) {
		return ErrInvalid
	}
	now := s.now()
	record := storage.HookEvent{
		EventID:       id,
		NodeID:        event.GetNodeId(),
		WorkspaceID:   event.GetWorkspaceId(),
		SessionID:     event.GetSessionId(),
		Generation:    event.GetGeneration(),
		Provider:      event.GetProvider(),
		Kind:          int32(event.GetKind()),
		Body:          body,
		BodySHA256:    event.GetPayloadSha256(),
		SchemaVersion: event.GetSchemaVersion(),
		ObservedAtMS:  event.GetObservedAtUnixMs(),
		RecordedAtMS:  now,
	}
	if record.ObservedAtMS <= 0 {
		record.ObservedAtMS = now
	}
	encoded, err := payload(hookEventMessage(record))
	if err != nil {
		return err
	}
	record.Payload = encoded
	_, err = s.store.PutHookEvent(ctx, "agent/hook/"+id, record)
	var conflict *storage.RevisionConflict
	if errors.As(err, &conflict) {
		return nil
	}
	return err
}

// hookEventMessage is the published shape. `observed_at` is the execution
// host's own stamp rather than this Host's clock: when it happened and when it
// was heard about are two different facts, and only the first belongs on the
// event.
func hookEventMessage(event storage.HookEvent) *pb.HookEvent {
	return &pb.HookEvent{
		EventId:          event.EventID,
		NodeId:           event.NodeID,
		SessionId:        event.SessionID,
		Generation:       event.Generation,
		WorkspaceId:      event.WorkspaceID,
		Provider:         event.Provider,
		Payload:          event.Body,
		PayloadSha256:    event.BodySHA256,
		SchemaVersion:    event.SchemaVersion,
		Kind:             pb.HookEventKind(event.Kind),
		ObservedAtUnixMs: event.ObservedAtMS,
	}
}

// ListHookEvents pages one node's history, newest first, within the caller's
// own workspace.
func (s *Service) ListHookEvents(ctx context.Context, caller Caller, nodeID string, before int64, limit int) ([]*pb.HookEvent, bool, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, false, err
	}
	if _, err := s.requireNode(ctx, caller, nodeID); err != nil {
		return nil, false, err
	}
	rows, more, err := s.store.ListHookEvents(ctx, nodeID, before, limit)
	if err != nil {
		return nil, false, err
	}
	events := make([]*pb.HookEvent, 0, len(rows))
	for _, row := range rows {
		events = append(events, hookEventMessage(row))
	}
	return events, more, nil
}
