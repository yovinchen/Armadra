package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"math"
	"strings"
)

// Handing work between agents, and the links that decide who may read whom
// (Go Host 业务所有权迁移 §3.1 v9, §2.7).
//
// # The bundle is frozen twice
//
// A handoff's bundle, its digest and both endpoints are written once and never
// rewritten. The database enforces it with a trigger and this package enforces
// it before the update is issued, and the duplication is on purpose: a handoff
// whose bundle could change after it was accepted would be a handoff where what
// the target read is not what the source sent. That is not a property to leave
// to one layer's care, and the layer most likely to be wrong is the one being
// changed today.
//
// # The outbox is folded in
//
// §3.1 v9 names `agent_handoffs` and `agent_handoff_outbox` separately, as the
// Runtime has them. They are one row here. The whole reason `HandoffState`
// exists is that a client asking "did this land?" could never answer from
// either table alone, and two rows that must be read together and can disagree
// are a worse record than one that cannot. What the outbox actually held —
// which process is dispatching this right now — is `claimed_at_ms` and
// `claim_instance_id`, on the row they describe.
//
// A claim is persisted *before* any terminal write, and a claimed row is never
// automatically re-dispatched after a crash: it becomes UNKNOWN_OUTCOME, which
// is the honest reading and the one a person has to resolve.
//
// # Context links are a projection
//
// `agent_context_links` has no client write path. It is derived from the
// canvas' own edges, and a client that could write it directly could make a
// node read a transcript it is not connected to — which is the one thing the
// "context follows the connection" rule exists to prevent.

// Handoff is one node handing its work to another.
type Handoff struct {
	HandoffID       string
	WorkspaceID     string
	SourceNodeID    string
	TargetNodeID    string
	SourceSessionID string
	SourceGen       uint64
	TargetSessionID string
	TargetGen       uint64
	Bundle          []byte
	BundleSHA256    []byte
	MailboxID       string
	TraceID         string
	Attempts        uint32
	State           int32
	ErrorCode       string
	ClaimedAtMS     int64
	ClaimInstanceID string
	Revision        uint64
	CreatedAtMS     int64
	AcceptedAtMS    int64
	UpdatedAtMS     int64
	Payload         []byte
}

// ContextLinks is one node's connections, as the canvas' edges imply them.
// `Links` is the encoded projection; it is opaque here, because what a link
// means belongs to the domain service and decoding it to store it would put a
// Protobuf parse inside the transaction.
type ContextLinks struct {
	NodeID      string
	WorkspaceID string
	Links       []byte
	Revision    uint64
	UpdatedAtMS int64
	Payload     []byte
}

// ErrHandoffFrozen is the refusal a change to a prepared bundle gets. It is a
// distinct error rather than a conflict: reloading and trying again would not
// help, because the record is not stale — it is settled.
var ErrHandoffFrozen = errors.New("a prepared handoff's bundle is immutable")

// MaxBundleBytes bounds one handoff bundle. It is a conversation snapshot, not
// an archive; anything larger belongs in the workspace, referenced by path.
const MaxBundleBytes = 4 << 20

func validateHandoff(handoff Handoff) error {
	if !textValid(handoff.HandoffID, agentIdentityLimit, false) || !textValid(handoff.WorkspaceID, agentIdentityLimit, false) ||
		!textValid(handoff.SourceNodeID, agentIdentityLimit, false) || !textValid(handoff.TargetNodeID, agentIdentityLimit, false) ||
		!textValid(handoff.SourceSessionID, agentIdentityLimit, true) || !textValid(handoff.TargetSessionID, agentIdentityLimit, true) ||
		!textValid(handoff.MailboxID, agentIdentityLimit, true) || !textValid(handoff.TraceID, agentIdentityLimit, true) ||
		!textValid(handoff.ErrorCode, 64, true) || !textValid(handoff.ClaimInstanceID, agentIdentityLimit, true) ||
		len(handoff.Bundle) > MaxBundleBytes || len(handoff.Payload) > MaxPayloadBytes ||
		(len(handoff.BundleSHA256) != 0 && len(handoff.BundleSHA256) != 32) {
		return ErrInvalid
	}
	if handoff.State < 0 || handoff.State > 8 || handoff.CreatedAtMS <= 0 || handoff.UpdatedAtMS <= 0 ||
		handoff.AcceptedAtMS < 0 || handoff.ClaimedAtMS < 0 {
		return ErrInvalid
	}
	// A handoff without a bundle is not a handoff. The digest has to be there
	// too: it is what makes the freeze checkable rather than merely declared.
	if len(handoff.Bundle) == 0 || len(handoff.BundleSHA256) != 32 {
		return ErrInvalid
	}
	if _, err := signed(handoff.SourceGen); err != nil {
		return err
	}
	_, err := signed(handoff.TargetGen)
	return err
}

func handoffFingerprint(handoff Handoff) []byte {
	digest := sha256.New()
	writeDigestPart(digest, []byte("armadra.storage.agent_handoff.v1"))
	for _, value := range []string{
		handoff.WorkspaceID, handoff.SourceNodeID, handoff.TargetNodeID,
		handoff.SourceSessionID, handoff.TargetSessionID, handoff.MailboxID,
		handoff.TraceID, handoff.ErrorCode, handoff.ClaimInstanceID,
	} {
		writeDigestPart(digest, []byte(value))
	}
	writeDigestPart(digest, handoff.BundleSHA256)
	digest.Write([]byte{byte(handoff.State), byte(handoff.Attempts)})
	return digest.Sum(nil)
}

const handoffColumns = "handoff_id,workspace_id,source_node_id,target_node_id,source_session_id,source_generation,target_session_id,target_generation,bundle,bundle_sha256,mailbox_id,trace_id,attempts,state,error_code,claimed_at_ms,claim_instance_id,revision,created_at_ms,accepted_at_ms,updated_at_ms,payload"

func scanHandoff(row scanner) (Handoff, error) {
	var handoff Handoff
	var revision, sourceGen, targetGen, attempts int64
	err := row.Scan(&handoff.HandoffID, &handoff.WorkspaceID, &handoff.SourceNodeID,
		&handoff.TargetNodeID, &handoff.SourceSessionID, &sourceGen, &handoff.TargetSessionID,
		&targetGen, &handoff.Bundle, &handoff.BundleSHA256, &handoff.MailboxID, &handoff.TraceID,
		&attempts, &handoff.State, &handoff.ErrorCode, &handoff.ClaimedAtMS,
		&handoff.ClaimInstanceID, &revision, &handoff.CreatedAtMS, &handoff.AcceptedAtMS,
		&handoff.UpdatedAtMS, &handoff.Payload)
	if errors.Is(err, sql.ErrNoRows) {
		return handoff, ErrNotFound
	}
	if err != nil {
		return handoff, err
	}
	if revision < 1 || sourceGen < 0 || targetGen < 0 || attempts < 0 || attempts > math.MaxUint32 {
		return Handoff{}, ErrCorrupt
	}
	handoff.Revision, handoff.SourceGen, handoff.TargetGen = uint64(revision), uint64(sourceGen), uint64(targetGen)
	handoff.Attempts = uint32(attempts)
	if validateHandoff(handoff) != nil {
		return Handoff{}, ErrCorrupt
	}
	return handoff, nil
}

func (s *Store) GetHandoff(ctx context.Context, handoffID string) (Handoff, error) {
	if !textValid(handoffID, agentIdentityLimit, false) {
		return Handoff{}, ErrInvalid
	}
	return scanHandoff(s.db.QueryRowContext(ctx, "SELECT "+handoffColumns+" FROM agent_handoffs WHERE handoff_id=?", handoffID))
}

// ListHandoffs answers the handoffs one node is either side of, newest first.
// Both directions are one listing because a handoff card shows both: what this
// node was handed, and what it handed on.
func (s *Store) ListHandoffs(ctx context.Context, nodeID string, limit int) ([]Handoff, error) {
	if !textValid(nodeID, agentIdentityLimit, false) {
		return nil, ErrInvalid
	}
	size, err := pageSize(limit)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+handoffColumns+" FROM agent_handoffs WHERE source_node_id=? OR target_node_id=? ORDER BY created_at_ms DESC, handoff_id LIMIT ?", nodeID, nodeID, size)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	handoffs := []Handoff{}
	for rows.Next() {
		handoff, err := scanHandoff(rows)
		if err != nil {
			return nil, err
		}
		handoffs = append(handoffs, handoff)
	}
	return handoffs, rows.Err()
}

// AllHandoffs reads every handoff this Host holds, in identifier order.
func (s *Store) AllHandoffs(ctx context.Context) ([]Handoff, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+handoffColumns+" FROM agent_handoffs ORDER BY handoff_id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	handoffs := []Handoff{}
	for rows.Next() {
		handoff, err := scanHandoff(rows)
		if err != nil {
			return nil, err
		}
		handoffs = append(handoffs, handoff)
	}
	return handoffs, rows.Err()
}

// PutHandoff stores one handoff under revision CAS and publishes it.
//
// An update that would change the frozen half is refused here before it reaches
// the trigger, so the caller gets a named error rather than an opaque SQLite
// abort. The trigger stays underneath it as the thing that is true even when
// this function is not the one writing.
func (s *Store) PutHandoff(ctx context.Context, operationID string, handoff Handoff, expected uint64) (ApplyResult, error) {
	if err := validateHandoff(handoff); err != nil {
		return ApplyResult{}, err
	}
	if expected > 0 {
		current, err := s.GetHandoff(ctx, handoff.HandoffID)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return ApplyResult{}, err
		}
		if err == nil && !sameFrozenHalf(current, handoff) {
			return ApplyResult{}, ErrHandoffFrozen
		}
	}
	sourceGen, err := signed(handoff.SourceGen)
	if err != nil {
		return ApplyResult{}, err
	}
	targetGen, err := signed(handoff.TargetGen)
	if err != nil {
		return ApplyResult{}, err
	}
	return s.putAgentRecord(ctx, operationID, agentRecord{
		kind:        HandoffKind,
		table:       "agent_handoffs",
		idColumn:    "handoff_id",
		id:          handoff.HandoffID,
		workspaceID: handoff.WorkspaceID,
		fingerprint: handoffFingerprint(handoff),
		payload:     handoff.Payload,
		insert: func(ctx context.Context, tx *sql.Tx, next int64) error {
			_, err := tx.ExecContext(ctx, "INSERT INTO agent_handoffs("+handoffColumns+") VALUES("+placeholders(22)+")",
				handoff.HandoffID, handoff.WorkspaceID, handoff.SourceNodeID, handoff.TargetNodeID,
				handoff.SourceSessionID, sourceGen, handoff.TargetSessionID, targetGen,
				blob(handoff.Bundle), blob(handoff.BundleSHA256), handoff.MailboxID, handoff.TraceID,
				int64(handoff.Attempts), handoff.State, handoff.ErrorCode, handoff.ClaimedAtMS,
				handoff.ClaimInstanceID, next, handoff.CreatedAtMS, handoff.AcceptedAtMS,
				handoff.UpdatedAtMS, blob(handoff.Payload))
			return err
		},
		// The frozen columns are absent from this statement, which is why the
		// trigger never fires on a write this package makes: it fires on one
		// somebody else makes.
		update: func(ctx context.Context, tx *sql.Tx, next, current int64) error {
			return affectedOne(tx.ExecContext(ctx, "UPDATE agent_handoffs SET mailbox_id=?,trace_id=?,attempts=?,state=?,error_code=?,claimed_at_ms=?,claim_instance_id=?,revision=?,accepted_at_ms=?,updated_at_ms=?,payload=? WHERE handoff_id=? AND revision=?",
				handoff.MailboxID, handoff.TraceID, int64(handoff.Attempts), handoff.State,
				handoff.ErrorCode, handoff.ClaimedAtMS, handoff.ClaimInstanceID, next,
				handoff.AcceptedAtMS, handoff.UpdatedAtMS, blob(handoff.Payload),
				handoff.HandoffID, current))
		},
	}, expected)
}

// sameFrozenHalf reports whether a change leaves the prepared definition alone.
func sameFrozenHalf(current, next Handoff) bool {
	return current.WorkspaceID == next.WorkspaceID &&
		current.SourceNodeID == next.SourceNodeID && current.TargetNodeID == next.TargetNodeID &&
		current.SourceSessionID == next.SourceSessionID && current.SourceGen == next.SourceGen &&
		current.TargetSessionID == next.TargetSessionID && current.TargetGen == next.TargetGen &&
		string(current.Bundle) == string(next.Bundle) &&
		string(current.BundleSHA256) == string(next.BundleSHA256) &&
		current.CreatedAtMS == next.CreatedAtMS
}

/* ---------------------------------------------------------- context links */

func validateContextLinks(links ContextLinks) error {
	if !textValid(links.NodeID, agentIdentityLimit, false) || !textValid(links.WorkspaceID, agentIdentityLimit, false) ||
		len(links.Links) > MaxPayloadBytes || len(links.Payload) > MaxPayloadBytes {
		return ErrInvalid
	}
	if links.UpdatedAtMS <= 0 {
		return ErrInvalid
	}
	return nil
}

const contextLinksColumns = "node_id,workspace_id,links,revision,updated_at_ms,payload"

func scanContextLinks(row scanner) (ContextLinks, error) {
	var links ContextLinks
	var revision int64
	err := row.Scan(&links.NodeID, &links.WorkspaceID, &links.Links, &revision, &links.UpdatedAtMS, &links.Payload)
	if errors.Is(err, sql.ErrNoRows) {
		return links, ErrNotFound
	}
	if err != nil {
		return links, err
	}
	if revision < 1 {
		return ContextLinks{}, ErrCorrupt
	}
	links.Revision = uint64(revision)
	if validateContextLinks(links) != nil {
		return ContextLinks{}, ErrCorrupt
	}
	return links, nil
}

func (s *Store) GetContextLinks(ctx context.Context, nodeID string) (ContextLinks, error) {
	if !textValid(nodeID, agentIdentityLimit, false) {
		return ContextLinks{}, ErrInvalid
	}
	return scanContextLinks(s.db.QueryRowContext(ctx, "SELECT "+contextLinksColumns+" FROM agent_context_links WHERE node_id=?", nodeID))
}

// ListContextLinks answers one workspace's whole projection, in node order.
func (s *Store) ListContextLinks(ctx context.Context, workspaceID string) ([]ContextLinks, error) {
	if !textValid(workspaceID, agentIdentityLimit, false) {
		return nil, ErrInvalid
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+contextLinksColumns+" FROM agent_context_links WHERE workspace_id=? ORDER BY node_id", workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	links := []ContextLinks{}
	for rows.Next() {
		record, err := scanContextLinks(rows)
		if err != nil {
			return nil, err
		}
		links = append(links, record)
	}
	return links, rows.Err()
}

// AllContextLinks reads every projection this Host holds, in node order.
func (s *Store) AllContextLinks(ctx context.Context) ([]ContextLinks, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+contextLinksColumns+" FROM agent_context_links ORDER BY node_id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	links := []ContextLinks{}
	for rows.Next() {
		record, err := scanContextLinks(rows)
		if err != nil {
			return nil, err
		}
		links = append(links, record)
	}
	return links, rows.Err()
}

// PutContextLinks stores one node's projection under revision CAS.
//
// A node whose last edge was removed keeps a row with an empty list rather than
// losing one: "this node is connected to nothing" and "nobody has looked" are
// different answers, and only the first can be drawn.
func (s *Store) PutContextLinks(ctx context.Context, operationID string, links ContextLinks, expected uint64) (ApplyResult, error) {
	if err := validateContextLinks(links); err != nil {
		return ApplyResult{}, err
	}
	digest := sha256.New()
	writeDigestPart(digest, []byte("armadra.storage.agent_context_links.v1"))
	writeDigestPart(digest, []byte(links.WorkspaceID))
	writeDigestPart(digest, links.Links)
	return s.putAgentRecord(ctx, operationID, agentRecord{
		kind:        ContextLinksKind,
		table:       "agent_context_links",
		idColumn:    "node_id",
		id:          links.NodeID,
		workspaceID: links.WorkspaceID,
		fingerprint: digest.Sum(nil),
		payload:     links.Payload,
		insert: func(ctx context.Context, tx *sql.Tx, next int64) error {
			_, err := tx.ExecContext(ctx, "INSERT INTO agent_context_links("+contextLinksColumns+") VALUES("+placeholders(6)+")",
				links.NodeID, links.WorkspaceID, blob(links.Links), next, links.UpdatedAtMS, blob(links.Payload))
			return err
		},
		update: func(ctx context.Context, tx *sql.Tx, next, current int64) error {
			return affectedOne(tx.ExecContext(ctx, "UPDATE agent_context_links SET workspace_id=?,links=?,revision=?,updated_at_ms=?,payload=? WHERE node_id=? AND revision=?",
				links.WorkspaceID, blob(links.Links), next, links.UpdatedAtMS, blob(links.Payload), links.NodeID, current))
		},
	}, expected)
}

/* ----------------------------------------------------------- drain cursor */

// AgentDrainCursor reports how far this Host has read one execution host's
// report of what happened there.
//
// It is stored rather than kept in memory because the whole point of a cursor
// is that a Host restart does not re-import a thousand turns it has already
// recorded — nor skip the ones it had not.
func (s *Store) AgentDrainCursor(ctx context.Context, executionHostID string) (uint64, error) {
	if !textValid(executionHostID, agentIdentityLimit, true) {
		return 0, ErrInvalid
	}
	var sequence int64
	err := s.db.QueryRowContext(ctx, "SELECT last_sequence FROM agent_drain_cursor WHERE execution_host_id=?", executionHostID).Scan(&sequence)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if sequence < 0 {
		return 0, ErrCorrupt
	}
	return uint64(sequence), nil
}

// SetAgentDrainCursor moves the cursor forward. It never moves backwards: a
// lower value is a request to re-read events this Host has already recorded,
// and recording them twice is what the cursor exists to prevent.
func (s *Store) SetAgentDrainCursor(ctx context.Context, executionHostID string, sequence uint64, nowMS int64) error {
	if !textValid(executionHostID, agentIdentityLimit, true) || nowMS <= 0 {
		return ErrInvalid
	}
	value, err := signed(sequence)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, strings.Join([]string{
		"INSERT INTO agent_drain_cursor(execution_host_id,last_sequence,updated_at_ms) VALUES(?,?,?)",
		"ON CONFLICT(execution_host_id) DO UPDATE SET last_sequence=MAX(last_sequence,excluded.last_sequence),updated_at_ms=excluded.updated_at_ms",
	}, " "), executionHostID, value, nowMS)
	return err
}
