package storage

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func status(node string) AgentStatus {
	return AgentStatus{
		NodeID:        node,
		WorkspaceID:   "w-1",
		SessionID:     "s-1",
		Generation:    3,
		AgentID:       "claude",
		Unread:        2,
		Verified:      true,
		TranscriptRef: []byte("claude/" + node),
		State:         2,
		SessionPhase:  "turn",
		LastEventMS:   1788560523000,
		UpdatedAtMS:   1788560523004,
		Payload:       []byte("status-" + node),
	}
}

func approval(id, node string) Approval {
	return Approval{
		ApprovalID:    id,
		NodeID:        node,
		WorkspaceID:   "w-1",
		SessionID:     "s-1",
		Generation:    3,
		Request:       []byte(`{"tool":"Bash"}`),
		RequestSHA256: bytes.Repeat([]byte{9}, 32),
		State:         1,
		CreatedAtMS:   1788560523004,
		Payload:       []byte("approval-" + id),
	}
}

func message(id, key string) MailboxMessage {
	return MailboxMessage{
		MessageID:    id,
		WorkspaceID:  "w-1",
		SourceNodeID: "node-1",
		TargetNodeID: "node-2",
		MessageKey:   key,
		Body:         "接手 agent 域",
		Sequence:     1,
		CreatedAtMS:  1788560523004,
		Payload:      []byte("message-" + id),
	}
}

func handoff(id string) Handoff {
	return Handoff{
		HandoffID:       id,
		WorkspaceID:     "w-1",
		SourceNodeID:    "node-1",
		TargetNodeID:    "node-2",
		SourceSessionID: "s-1",
		SourceGen:       3,
		TargetSessionID: "s-2",
		TargetGen:       1,
		Bundle:          []byte(`{"summary":"迁移"}`),
		BundleSHA256:    bytes.Repeat([]byte{4}, 32),
		State:           1,
		CreatedAtMS:     1788560523004,
		UpdatedAtMS:     1788560523004,
		Payload:         []byte("handoff-" + id),
	}
}

// Every agent record is CAS'd, and the refusal names the revision that is
// actually current. Two devices that both read a pending approval and both
// decided to allow it produce one answer and one refusal — not two answers a
// CLI would have to choose between.
func TestAgentRecordsShareOneRevisionRule(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	if _, err := store.PutAgentStatus(ctx, "agent/node-1/first", status("node-1"), 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("a first record accepted a revision that cannot exist yet: %v", err)
	}
	if _, err := store.PutAgentStatus(ctx, "agent/node-1/first", status("node-1"), 0); err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetAgentStatus(ctx, "node-1")
	if err != nil || stored.Revision != 1 || stored.State != 2 || stored.Unread != 2 {
		t.Fatalf("the stored status is not the one recorded: %v %+v", err, stored)
	}

	if _, err = store.PutApproval(ctx, "agent/a-1/appear", approval("a-1", "node-1"), 0); err != nil {
		t.Fatal(err)
	}
	answered := approval("a-1", "node-1")
	answered.Decision, answered.AnsweredBy, answered.State, answered.AnsweredAtMS = "allow", "owner-1", 2, 1788560524000
	if _, err = store.PutApproval(ctx, "agent/a-1/answer", answered, 1); err != nil {
		t.Fatal(err)
	}
	// The second device read revision 1 too and is refused, with the number it
	// would have to have read to win.
	second := approval("a-1", "node-1")
	second.Decision, second.AnsweredBy, second.State, second.AnsweredAtMS = "deny", "owner-2", 2, 1788560524500
	_, err = store.PutApproval(ctx, "agent/a-1/answer-2", second, 1)
	conflict := new(RevisionConflict)
	if !errors.As(err, &conflict) || conflict.Actual != 2 || conflict.Expected != 1 {
		t.Fatalf("a second answer was not refused with the current revision: %v", err)
	}
	final, err := store.GetApproval(ctx, "a-1")
	if err != nil || final.Decision != "allow" || final.AnsweredBy != "owner-1" {
		t.Fatalf("the losing answer changed the record: %v %+v", err, final)
	}
}

// A flag reported false and a flag nobody reported are different statements: a
// node that ran cleanly and a node nobody has heard from. Storing them as one
// would make every node that has never run look like one that succeeded.
func TestAgentStatusKeepsAbsentFlagsAbsent(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	no := false
	reported := status("node-1")
	reported.Errored = &no
	if _, err := store.PutAgentStatus(ctx, "agent/node-1/reported", reported, 0); err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetAgentStatus(ctx, "node-1")
	if err != nil || stored.Errored == nil || *stored.Errored {
		t.Fatalf("a reported false did not survive: %v %+v", err, stored)
	}
	silent := status("node-2")
	if _, err = store.PutAgentStatus(ctx, "agent/node-2/silent", silent, 0); err != nil {
		t.Fatal(err)
	}
	quiet, err := store.GetAgentStatus(ctx, "node-2")
	if err != nil || quiet.Errored != nil {
		t.Fatalf("an absent flag came back as a value: %v %+v", err, quiet)
	}
	// The two are also different *requests*: an operation id reused between
	// them has to be refused rather than replayed as the first.
	third := status("node-3")
	third.Errored = &no
	if _, err = store.PutAgentStatus(ctx, "agent/node-3/shared", third, 0); err != nil {
		t.Fatal(err)
	}
	third.Errored = nil
	if _, err = store.PutAgentStatus(ctx, "agent/node-3/shared", third, 0); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("two different statuses shared one operation id: %v", err)
	}
}

// One inbox, one order. Two nodes posting at the same moment must not be able
// to claim one position, so the sequence comes from the table rather than from
// a caller.
func TestMailboxSequenceAndDuplicateKey(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	first, err := store.NextMailboxSequence(ctx)
	if err != nil || first != 1 {
		t.Fatalf("the first sequence is not 1: %d %v", first, err)
	}
	if _, err = store.PutMailboxMessage(ctx, "agent/m-1/post", message("m-1", "k-1"), 0); err != nil {
		t.Fatal(err)
	}
	next, err := store.NextMailboxSequence(ctx)
	if err != nil || next != 2 {
		t.Fatalf("the sequence did not advance past the stored message: %d %v", next, err)
	}
	// The same thought posted twice is one row, not two copies in an inbox.
	duplicate := message("m-2", "k-1")
	duplicate.Sequence = next
	if _, err = store.PutMailboxMessage(ctx, "agent/m-2/post", duplicate, 0); err == nil {
		t.Fatal("a second message under the same key was accepted")
	}
	unread, err := store.ListMailbox(ctx, "node-2", true, 0)
	if err != nil || len(unread) != 1 {
		t.Fatalf("the inbox is not the one message that was posted: %v %d", err, len(unread))
	}
	acknowledged := message("m-1", "k-1")
	acknowledged.AckedAtMS = 1788560524000
	if _, err = store.PutMailboxMessage(ctx, "agent/m-1/ack", acknowledged, 1); err != nil {
		t.Fatal(err)
	}
	if unread, err = store.ListMailbox(ctx, "node-2", true, 0); err != nil || len(unread) != 0 {
		t.Fatalf("an acknowledged message still counts as unread: %v %d", err, len(unread))
	}
	if all, err := store.ListMailbox(ctx, "node-2", false, 0); err != nil || len(all) != 1 {
		t.Fatalf("acknowledging removed the message: %v %d", err, len(all))
	}
}

// The bundle is frozen on both sides. This package refuses a change to it with
// a named error, and the trigger underneath refuses one from anywhere else —
// because a handoff whose bundle could change after it was accepted would be a
// handoff where what the target read is not what the source sent.
func TestHandoffBundleIsFrozenByCodeAndByTrigger(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	if _, err := store.PutHandoff(ctx, "agent/h-1/prepare", handoff("h-1"), 0); err != nil {
		t.Fatal(err)
	}
	rewritten := handoff("h-1")
	rewritten.Bundle = []byte(`{"summary":"别的"}`)
	rewritten.State = 2
	if _, err := store.PutHandoff(ctx, "agent/h-1/rewrite", rewritten, 1); !errors.Is(err, ErrHandoffFrozen) {
		t.Fatalf("a rewritten bundle was not refused: %v", err)
	}
	// The state, the attempt count and the claim are the mutable half.
	queued := handoff("h-1")
	queued.State, queued.Attempts = 2, 1
	queued.ClaimedAtMS, queued.ClaimInstanceID = 1788560524000, "instance-1"
	queued.AcceptedAtMS, queued.UpdatedAtMS = 1788560524000, 1788560524000
	if _, err := store.PutHandoff(ctx, "agent/h-1/accept", queued, 1); err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetHandoff(ctx, "h-1")
	if err != nil || stored.State != 2 || stored.Attempts != 1 || stored.ClaimInstanceID != "instance-1" {
		t.Fatalf("the mutable half did not move: %v %+v", err, stored)
	}
	if !bytes.Equal(stored.Bundle, handoff("h-1").Bundle) {
		t.Fatal("the frozen bundle changed under a state transition")
	}
	// And the database itself refuses, for a writer that is not this package.
	_, err = store.db.ExecContext(ctx, "UPDATE agent_handoffs SET bundle=? WHERE handoff_id=?", []byte("其他"), "h-1")
	if err == nil {
		t.Fatal("the trigger allowed a direct rewrite of a frozen bundle")
	}
}

// A cursor only moves forward. A lower value is a request to re-read events
// this Host has already recorded, and recording them twice is the one thing the
// cursor exists to prevent.
func TestDrainCursorNeverMovesBackwards(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	sequence, err := store.AgentDrainCursor(ctx, "")
	if err != nil || sequence != 0 {
		t.Fatalf("an unread execution host did not start at zero: %d %v", sequence, err)
	}
	if err = store.SetAgentDrainCursor(ctx, "", 12, 1788560523004); err != nil {
		t.Fatal(err)
	}
	if err = store.SetAgentDrainCursor(ctx, "", 4, 1788560524000); err != nil {
		t.Fatal(err)
	}
	if sequence, err = store.AgentDrainCursor(ctx, ""); err != nil || sequence != 12 {
		t.Fatalf("the cursor moved backwards: %d %v", sequence, err)
	}
}

// A change reaches the table and the outbox together or not at all. A record
// that reached only the table would leave every connected client drawing a node
// that has already moved on.
func TestAgentChangesPublishOnTheSharedSequence(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)
	before, watermark, err := store.Watermark(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_ = before
	for _, write := range []func() error{
		func() error {
			_, err := store.PutAgentStatus(ctx, "agent/node-1/first", status("node-1"), 0)
			return err
		},
		func() error {
			_, err := store.PutApproval(ctx, "agent/a-1/appear", approval("a-1", "node-1"), 0)
			return err
		},
		func() error {
			_, err := store.PutMailboxMessage(ctx, "agent/m-1/post", message("m-1", "k-1"), 0)
			return err
		},
		func() error {
			_, err := store.PutDelivery(ctx, "agent/t-1/receipt", Delivery{
				TraceID: "t-1", WorkspaceID: "w-1", SourceNodeID: "node-1", TargetNodeID: "node-2",
				Receipt: "pane:0", BodyChars: 12, Outcome: 1, CreatedAtMS: 1788560523004,
				Payload: []byte("delivery-t-1"),
			}, 0)
			return err
		},
		func() error {
			_, err := store.PutHandoff(ctx, "agent/h-1/prepare", handoff("h-1"), 0)
			return err
		},
		func() error {
			_, err := store.PutContextLinks(ctx, "agent/node-1/links", ContextLinks{
				NodeID: "node-1", WorkspaceID: "w-1", Links: []byte("links"),
				UpdatedAtMS: 1788560523004, Payload: []byte("context-node-1"),
			}, 0)
			return err
		},
	} {
		if err = write(); err != nil {
			t.Fatal(err)
		}
	}
	_, after, err := store.Watermark(ctx)
	if err != nil || after != watermark+6 {
		t.Fatalf("six changes did not publish six events: %d -> %d %v", watermark, after, err)
	}
	events, err := store.GetEvents(ctx, EventQuery{})
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]bool{}
	for _, event := range events.Events {
		kinds[event.Kind] = true
	}
	for _, kind := range []string{AgentStatusKind, ApprovalKind, MailboxKind, DeliveryKind, HandoffKind, ContextLinksKind} {
		if !kinds[kind] {
			t.Fatalf("%s never reached the outbox", kind)
		}
	}
}
