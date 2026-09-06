package storage

import (
	"context"
	"database/sql"
	"errors"
	"math"
)

// The Hook events themselves (Go Host 业务所有权迁移 §2.7, schema v10).
//
// Every other agent table holds a *current* value that changes. This one holds
// what happened, and rows never change after they land: `event_id` is the
// execution host's own identifier for the observation, so a replayed frame
// writes the same row rather than a second one. That is why every write goes in
// at `expected = 0` and a revision conflict is read as "already recorded"
// rather than as a lost race — nothing ever contends for one of these rows.
//
// The body is the *normalized* event, not the CLI's own, and it stays opaque
// here with its digest beside it. Recording a body this Host cannot parse is
// only safe because the digest makes a truncated or rewritten one visible.

// HookEventKind is the stored event kind, claimed by the agent projector and
// published as `events.proto` entity 181.
const HookEventKind = "agent.hookEvent"

// HookEvent is one normalized report from a CLI's hooks.
type HookEvent struct {
	EventID       string
	NodeID        string
	WorkspaceID   string
	SessionID     string
	Generation    uint64
	Provider      string
	Kind          int32
	// Body is the *normalized* event as the execution host rendered it, with
	// its own digest beside it. It stays opaque here: the shape is the
	// Worker's, and recording a body this Host cannot parse is only safe
	// because a truncated or rewritten one is visible against the digest.
	Body          []byte
	BodySHA256    []byte
	SchemaVersion uint32
	Revision      uint64
	ObservedAtMS  int64
	RecordedAtMS  int64
	// Payload is the published HookEvent proto, which a subscriber receives as
	// entity 181. Every other agent table carries the same pair for the same
	// reason: the columns are what this Host queries, the payload is what it
	// hands out.
	Payload []byte
}

const hookEventColumns = "event_id,node_id,workspace_id,session_id,generation,provider,kind,body,body_sha256,schema_version,revision,observed_at_ms,recorded_at_ms,payload"

func validateHookEvent(event HookEvent) error {
	if !textValid(event.EventID, agentIdentityLimit, false) || !textValid(event.NodeID, agentIdentityLimit, false) {
		return ErrInvalid
	}
	if !textValid(event.WorkspaceID, agentIdentityLimit, false) || !textValid(event.SessionID, agentIdentityLimit, true) {
		return ErrInvalid
	}
	if !textValid(event.Provider, 64, true) || event.Kind < 0 {
		return ErrInvalid
	}
	if len(event.BodySHA256) != 0 && len(event.BodySHA256) != 32 {
		return ErrInvalid
	}
	if event.ObservedAtMS < 0 || event.RecordedAtMS <= 0 {
		return ErrInvalid
	}
	return nil
}

// PutHookEvent records one event. A conflict means the same event id is already
// on file, which the caller reads as success: the report is durable either way.
func (s *Store) PutHookEvent(ctx context.Context, operationID string, event HookEvent) (ApplyResult, error) {
	if err := validateHookEvent(event); err != nil {
		return ApplyResult{}, err
	}
	generation, err := signed(event.Generation)
	if err != nil {
		return ApplyResult{}, err
	}
	values := []any{
		event.EventID, event.NodeID, event.WorkspaceID, event.SessionID, generation,
		event.Provider, int64(event.Kind), blob(event.Body), blob(event.BodySHA256),
		int64(event.SchemaVersion),
	}
	return s.putAgentRecord(ctx, operationID, agentRecord{
		kind:        HookEventKind,
		table:       "agent_hook_events",
		idColumn:    "event_id",
		id:          event.EventID,
		workspaceID: event.WorkspaceID,
		fingerprint: append([]byte(event.EventID+"\x00"), event.BodySHA256...),
		payload:     event.Payload,
		insert: func(ctx context.Context, tx *sql.Tx, next int64) error {
			_, err := tx.ExecContext(ctx, "INSERT INTO agent_hook_events("+hookEventColumns+") VALUES("+placeholders(14)+")",
				append(append([]any{}, values...), next, event.ObservedAtMS, event.RecordedAtMS, blob(event.Payload))...)
			return err
		},
		update: func(context.Context, *sql.Tx, int64, int64) error {
			// Unreachable: every write is at expected 0, so an existing row is
			// a conflict before this is called. Refusing rather than silently
			// rewriting keeps that true if a caller ever passes a revision.
			return ErrInvalid
		},
	}, 0)
}

func scanHookEvent(row scanner) (HookEvent, error) {
	var event HookEvent
	var revision, generation, kind, schemaVersion int64
	err := row.Scan(&event.EventID, &event.NodeID, &event.WorkspaceID, &event.SessionID,
		&generation, &event.Provider, &kind, &event.Body, &event.BodySHA256,
		&schemaVersion, &revision, &event.ObservedAtMS, &event.RecordedAtMS, &event.Payload)
	if errors.Is(err, sql.ErrNoRows) {
		return event, ErrNotFound
	}
	if err != nil {
		return event, err
	}
	if revision < 1 || generation < 0 || kind < 0 || kind > math.MaxInt32 || schemaVersion < 0 || schemaVersion > math.MaxUint32 {
		return HookEvent{}, ErrCorrupt
	}
	event.Revision, event.Generation = uint64(revision), uint64(generation)
	event.Kind, event.SchemaVersion = int32(kind), uint32(schemaVersion)
	if validateHookEvent(event) != nil {
		return HookEvent{}, ErrCorrupt
	}
	return event, nil
}

// GetHookEvent reads one recorded event.
func (s *Store) GetHookEvent(ctx context.Context, eventID string) (HookEvent, error) {
	if !textValid(eventID, agentIdentityLimit, false) {
		return HookEvent{}, ErrInvalid
	}
	return scanHookEvent(s.db.QueryRowContext(ctx, "SELECT "+hookEventColumns+" FROM agent_hook_events WHERE event_id=?", eventID))
}

// ListHookEvents pages one node's history, newest first. Newest first because
// the question a client asks of this table is "what just happened", and paging
// from the far end of a week of turns to reach it would be the wrong shape.
func (s *Store) ListHookEvents(ctx context.Context, nodeID string, before int64, limit int) ([]HookEvent, bool, error) {
	if !textValid(nodeID, agentIdentityLimit, false) {
		return nil, false, ErrInvalid
	}
	size, err := pageSize(limit)
	if err != nil {
		return nil, false, err
	}
	if before <= 0 {
		before = math.MaxInt64
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+hookEventColumns+" FROM agent_hook_events WHERE node_id=? AND observed_at_ms<? ORDER BY observed_at_ms DESC, event_id DESC LIMIT ?", nodeID, before, size+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	events := []HookEvent{}
	for rows.Next() {
		event, err := scanHookEvent(rows)
		if err != nil {
			return nil, false, err
		}
		events = append(events, event)
	}
	if err = rows.Err(); err != nil {
		return nil, false, err
	}
	if len(events) > size {
		return events[:size], true, nil
	}
	return events, false, nil
}
