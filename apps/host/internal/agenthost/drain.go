package agenthost

import (
	"context"
	"errors"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// Learning what happened on the execution host
// (Go Host 业务所有权迁移 §2.7 Worker 通道).
//
// §2.7 has the Worker push: a Hook turn, an approval appearing, a delivery
// receipt all travel upward on the resident channel. This Host pulls instead,
// and the reason is structural rather than a shortcut.
//
// The process a Hook actually reaches is the resident Runtime — the one holding
// the PTYs and the endpoint file. That process binds no upward channel; only a
// Worker the Host itself started does, and the Host does not start the resident
// Runtime. So there is no wire on which a Hook turn could arrive unasked, and
// building one would mean the resident Runtime dialling the Host, which is a
// second authorization surface this migration has been careful not to create.
//
// What makes a pull as safe as a push is the cursor. Every drain names the
// sequence this Host has already recorded; the Worker answers what follows it;
// the cursor moves only after the records are stored. A drain that was
// interrupted is one the Host asks for again, and every record is idempotent by
// identifier, so asking again costs a re-read rather than a duplicate. The
// visible cost is latency — an approval is seen at the next drain rather than
// the moment it appears — and that is what [Service.Poll] exists to keep small.

// DrainOutcome reports what one drain recorded. It is returned rather than
// logged because the e2e check asserts on it and because an operator watching a
// Host start wants to know whether anything was waiting.
type DrainOutcome struct {
	Statuses   int
	Approvals  int
	Messages   int
	Deliveries int
	Cursor     uint64
	// More is true when the Worker had more to say than one drain carried. A
	// caller loops until it is false rather than waiting for the next tick,
	// because a backlog after a restart should not take a minute to apply.
	More bool
}

// MaxDrainBatch bounds one drain. It is large enough that an ordinary backlog
// clears in one exchange and small enough that a Worker that has been running
// for a week does not answer with a frame nobody can hold.
const MaxDrainBatch = 256

// Drain reads what the execution host has observed since the stored cursor and
// records it.
//
// Nothing here is interpreted. A Hook event's reduction into a state was done
// on the machine that saw it; an approval is recorded as the question it is; a
// delivery receipt's outcome is the Worker's reading of its own input gate. The
// Host's contribution is that these become durable, revisioned and published.
func (s *Service) Drain(ctx context.Context, executionHostID string) (DrainOutcome, error) {
	outcome := DrainOutcome{}
	owned, err := s.Owned(ctx)
	if err != nil {
		return outcome, err
	}
	if !owned {
		// While the Runtime owns the domain its own tables are the record.
		// Draining into this Host's tables as well would be a dual write.
		return outcome, nil
	}
	cursor, err := s.store.AgentDrainCursor(ctx, executionHostID)
	if err != nil {
		return outcome, err
	}
	outcome.Cursor = cursor
	executor, done, err := s.open(ctx, executionHostID)
	if err != nil {
		return outcome, err
	}
	defer done()
	drained, err := executor.Drain(ctx, cursor, MaxDrainBatch)
	if err != nil {
		return outcome, err
	}
	if drained == nil {
		return outcome, nil
	}
	for _, event := range drained.GetEvents() {
		applied, err := s.applyHookEvent(ctx, event)
		if err != nil {
			return outcome, err
		}
		if applied {
			outcome.Statuses++
		}
	}
	for _, approval := range drained.GetApprovals() {
		recorded, err := s.recordApproval(ctx, approval)
		if err != nil {
			return outcome, err
		}
		if recorded {
			outcome.Approvals++
		}
	}
	for _, delivery := range drained.GetDeliveries() {
		recorded, err := s.recordDelivery(ctx, delivery)
		if err != nil {
			return outcome, err
		}
		if recorded {
			outcome.Deliveries++
		}
	}
	// The cursor moves last, and only over what was stored. A Host that moved
	// it first and then failed would have skipped exactly the events it could
	// not record.
	if next := drained.GetNextSequence(); next > cursor {
		if err = s.store.SetAgentDrainCursor(ctx, executionHostID, next, s.now()); err != nil {
			return outcome, err
		}
		outcome.Cursor = next
	}
	outcome.More = drained.GetHasMore()
	return outcome, nil
}

// applyHookEvent folds one normalized turn into the node's status.
//
// The reduction is the Worker's: `state` arrived already computed by the side
// that saw the raw event. What this decides is only whether the report is still
// about the pane it names — a turn reported for a generation that has been
// replaced describes a session nobody is looking at, and applying it would
// bring a dead pane's node back to life.
func (s *Service) applyHookEvent(ctx context.Context, event *pb.HookEvent) (bool, error) {
	if event == nil || !validID(event.GetNodeId()) {
		return false, ErrInvalid
	}
	if body := event.GetPayload(); len(body) > 0 {
		// A body that does not match its digest was truncated or rewritten in
		// flight. It is refused rather than stored as a shorter event.
		if string(digest(body)) != string(event.GetPayloadSha256()) {
			return false, ErrInvalid
		}
	}
	status := new(pb.AgentStatus)
	if len(event.GetPayload()) > 0 {
		if err := unmarshalStatus(event.GetPayload(), status); err != nil {
			return false, err
		}
	}
	status.NodeId = event.GetNodeId()
	if status.GetWorkspaceId() == "" {
		status.WorkspaceId = event.GetWorkspaceId()
	}
	if status.GetSessionId() == "" {
		status.SessionId = event.GetSessionId()
	}
	if status.GetGeneration() == 0 {
		status.Generation = event.GetGeneration()
	}
	if status.GetLastEventAtUnixMs() == 0 {
		status.LastEventAtUnixMs = event.GetObservedAtUnixMs()
	}
	if !validID(status.GetWorkspaceId()) {
		return false, ErrInvalid
	}
	current, err := s.store.GetAgentStatus(ctx, status.GetNodeId())
	expected := uint64(0)
	switch {
	case err == nil:
		expected = current.Revision
		// A report about a generation the machine has already replaced is
		// stale. Recording it would make a node that has been recycled look
		// busy in a pane nobody is watching.
		if status.GetGeneration() != 0 && current.Generation > status.GetGeneration() {
			return false, nil
		}
		if sameStatus(current, status) {
			return false, nil
		}
	case errors.Is(err, storage.ErrNotFound):
	default:
		return false, err
	}
	record, err := statusRecord(status, s.now())
	if err != nil {
		return false, err
	}
	if _, err = s.store.PutAgentStatus(ctx, "agent/status/"+event.GetEventId(), record, expected); err != nil {
		return false, err
	}
	return true, nil
}

// sameStatus compares what a report says about a node. Timestamps and the
// revision are excluded: they are how the record was reached, not what it says,
// and comparing them would republish every node on every drain.
func sameStatus(current storage.AgentStatus, next *pb.AgentStatus) bool {
	if (current.Errored == nil) != (next.Errored == nil) || (current.Interrupted == nil) != (next.Interrupted == nil) {
		return false
	}
	if current.Errored != nil && *current.Errored != next.GetErrored() {
		return false
	}
	if current.Interrupted != nil && *current.Interrupted != next.GetInterrupted() {
		return false
	}
	return current.WorkspaceID == next.GetWorkspaceId() && current.SessionID == next.GetSessionId() &&
		current.Generation == next.GetGeneration() && current.AgentID == next.GetAgentId() &&
		current.Unread == next.GetUnread() && current.Verified == next.GetVerified() &&
		current.Restored == next.GetRestored() && current.State == int32(next.GetState()) &&
		current.SessionPhase == next.GetSessionPhase() &&
		string(current.TranscriptRef) == string(next.GetTranscriptRef())
}

// unmarshalStatus decodes the Worker's normalized body. A body this build
// cannot read blocks the event rather than becoming a status with defaults in
// it: a node recorded IDLE because a payload could not be parsed is a node
// somebody will assume is finished.
func unmarshalStatus(body []byte, status *pb.AgentStatus) error {
	if err := proto.Unmarshal(body, status); err != nil {
		return ErrInvalid
	}
	return nil
}
