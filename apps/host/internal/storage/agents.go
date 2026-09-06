package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"math"
	"strings"
)

// The agent domain's tables (Go Host 业务所有权迁移 §3.1 v9).
//
// Six records, one rule. Every one of them is stored under revision CAS and
// publishes its change on the Host's durable sequence inside the same
// transaction, for the reason the session and root tables do: a record that
// reached the table but not the outbox would leave every connected client
// drawing a node that has already moved on — a badge that never clears, an
// approval that has been answered still asking.
//
// Because the rule is one rule, the CAS-and-publish machinery is written once
// here as [agentRecord] and reused by all six, rather than copied six times
// with six chances to differ. What each record supplies is only what is
// genuinely its own: the columns, and the fingerprint that decides whether two
// requests under one operation id are the same request.
//
// The fingerprints deliberately exclude the published payload, exactly as the
// root and session tables do. A payload is derived from the columns plus the
// moment the request arrived, so hashing it would make every retry a different
// request — which is the case idempotency exists to make harmless.

const (
	// The stored event kinds. They are the domain's name and the entity's,
	// joined the way §3.1 spells it, and they are what the agent event
	// projector claims off the shared stream.
	AgentStatusKind    = "agent.status"
	ApprovalKind       = "agent.approval"
	MailboxKind        = "agent.mailbox"
	DeliveryKind       = "agent.delivery"
	HandoffKind        = "agent.handoff"
	ContextLinksKind   = "agent.contextLinks"
	agentIdentityLimit = 256
)

// AgentStatus is one node's reduced state as the Host records it.
//
// `Errored` and `Interrupted` are pointers because an absent flag and a flag
// reported false are different statements: the first is a node nobody has heard
// from, the second is a node that ran cleanly, and a client draws them
// differently. Collapsing them into a bool would make every node that has never
// run look like one that succeeded.
type AgentStatus struct {
	NodeID        string
	WorkspaceID   string
	SessionID     string
	Generation    uint64
	AgentID       string
	Unread        uint32
	Verified      bool
	Restored      bool
	Errored       *bool
	Interrupted   *bool
	TranscriptRef []byte
	State         int32
	SessionPhase  string
	ReasonCode    string
	Deleted       bool
	Revision      uint64
	LastEventMS   int64
	UpdatedAtMS   int64
	Payload       []byte
}

// Approval is one permission question a CLI is blocked on. `Request` is the
// provider's own body and is opaque here; the digest beside it is what makes
// storing a body this package cannot parse safe.
type Approval struct {
	ApprovalID    string
	NodeID        string
	WorkspaceID   string
	SessionID     string
	Generation    uint64
	Request       []byte
	RequestSHA256 []byte
	Decision      string
	AnsweredBy    string
	State         int32
	ReasonCode    string
	Revision      uint64
	CreatedAtMS   int64
	AnsweredAtMS  int64
	Payload       []byte
}

// agentRecord is one row's worth of "check the revision, write it, publish it".
//
// It exists because the six agent tables differ only in their columns. The
// alternative — six copies of the same forty lines — is six places for the CAS
// and the outbox to drift apart, and the one property this package exists to
// guarantee is that they never do.
type agentRecord struct {
	kind        string
	table       string
	idColumn    string
	id          string
	workspaceID string
	deleted     bool
	// fingerprint is the request as the idempotency digest sees it. Nil means
	// "this request is a withdrawal", which is nothing but the key and the
	// revision it names.
	fingerprint []byte
	payload     []byte
	// insert writes the first version of the row; update rewrites it under the
	// revision it read. They are closures rather than column lists because a
	// row's shape is the one thing that is genuinely per-table.
	insert func(context.Context, *sql.Tx, int64) error
	update func(context.Context, *sql.Tx, int64, int64) error
}

// putAgentRecord is the single write path for every agent record.
func (s *Store) putAgentRecord(ctx context.Context, operationID string, record agentRecord, expected uint64) (ApplyResult, error) {
	var result ApplyResult
	if !textValid(operationID, 512, false) || !textValid(record.id, agentIdentityLimit, false) {
		return result, ErrInvalid
	}
	if len(record.payload) > MaxPayloadBytes {
		return result, ErrInvalid
	}
	if _, err := signed(expected); err != nil {
		return result, err
	}
	key := Key{Kind: record.kind, ID: record.id, WorkspaceID: record.workspaceID}
	digest, err := OperationDigest([]Change{{
		Key:              key,
		ExpectedRevision: expected,
		Payload:          record.fingerprint,
		Delete:           record.deleted,
	}})
	if err != nil {
		return result, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	result, transactionID, replayed, err := openOperation(ctx, tx, operationID, digest[:], 1)
	if err != nil || replayed {
		return result, err
	}
	var current int64
	err = tx.QueryRowContext(ctx, "SELECT revision FROM "+record.table+" WHERE "+record.idColumn+"=?", record.id).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		current = 0
	} else if err != nil {
		return ApplyResult{}, err
	}
	if current < 0 {
		return ApplyResult{}, ErrCorrupt
	}
	if uint64(current) != expected {
		return ApplyResult{}, &RevisionConflict{Key: key, Expected: expected, Actual: uint64(current)}
	}
	if current == math.MaxInt64 {
		return ApplyResult{}, ErrCounterExhausted
	}
	next := current + 1
	if current == 0 {
		err = record.insert(ctx, tx, next)
	} else {
		err = record.update(ctx, tx, next, current)
	}
	if err != nil {
		return ApplyResult{}, err
	}
	revision := Revision{Key: key, Revision: uint64(next), Deleted: record.deleted}
	if err = appendChange(ctx, tx, &result, transactionID, 0, 1, revision, record.payload); err != nil {
		return ApplyResult{}, err
	}
	if err = closeOperation(ctx, tx, result); err != nil {
		return ApplyResult{}, err
	}
	if err = tx.Commit(); err != nil {
		return ApplyResult{}, err
	}
	// Only after the commit, exactly as Apply does: a subscriber woken earlier
	// could read a sequence a rollback would have taken back.
	s.committed(result.LastSequence)
	return result, nil
}

// affectedOne turns "the UPDATE matched no row" into a conflict rather than a
// silent success. Under CAS that can only mean somebody else moved the revision
// between the read and the write.
func affectedOne(updated sql.Result, err error) error {
	if err != nil {
		return err
	}
	count, err := updated.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return ErrConflict
	}
	return nil
}

// blob binds a possibly-nil slice as an empty blob rather than as NULL.
//
// Every BLOB column in the agent tables is NOT NULL, because "no transcript
// reference" and "nobody has said" are the same thing here and a nullable
// column would invite a third state. Go's nil slice binds as NULL, so it is
// normalised once, at the boundary, rather than by a COALESCE repeated in
// every statement.
func blob(value []byte) []byte {
	if value == nil {
		return []byte{}
	}
	return value
}

func optionalBool(value *bool) any {
	if value == nil {
		return nil
	}
	return boolean(*value)
}

func scanOptionalBool(value sql.NullInt64) *bool {
	if !value.Valid {
		return nil
	}
	flag := value.Int64 == 1
	return &flag
}

/* ---------------------------------------------------------------- status */

func validateAgentStatus(status AgentStatus) error {
	if !textValid(status.NodeID, agentIdentityLimit, false) || !textValid(status.WorkspaceID, agentIdentityLimit, false) ||
		!textValid(status.SessionID, agentIdentityLimit, true) || !textValid(status.AgentID, agentIdentityLimit, true) ||
		!textValid(status.SessionPhase, 64, true) || !textValid(status.ReasonCode, 64, true) ||
		len(status.TranscriptRef) > 4096 || len(status.Payload) > MaxPayloadBytes {
		return ErrInvalid
	}
	if status.State < 0 || status.State > 5 || status.UpdatedAtMS <= 0 || status.LastEventMS < 0 {
		return ErrInvalid
	}
	// A tombstone is the withdrawal of a node's status, so it carries none. One
	// that still named a session and a transcript would read like a node that
	// is merely hidden, which is the one thing it is not.
	if status.Deleted && (status.SessionID != "" || len(status.TranscriptRef) != 0 || status.Unread != 0) {
		return ErrInvalid
	}
	_, err := signed(status.Generation)
	return err
}

func agentStatusFingerprint(status AgentStatus) []byte {
	if status.Deleted {
		return nil
	}
	digest := sha256.New()
	writeDigestPart(digest, []byte("armadra.storage.agent_status.v1"))
	for _, value := range []string{status.WorkspaceID, status.SessionID, status.AgentID, status.SessionPhase, status.ReasonCode} {
		writeDigestPart(digest, []byte(value))
	}
	writeDigestPart(digest, status.TranscriptRef)
	writeDigestPart(digest, []byte(flagText(status.Errored)+"/"+flagText(status.Interrupted)))
	digest.Write([]byte{byte(status.State), byte(boolean(status.Verified)), byte(boolean(status.Restored))})
	return digest.Sum(nil)
}

// flagText spells an optional bool so that "reported false" and "nobody said"
// hash differently. They are a green badge and a grey one.
func flagText(value *bool) string {
	switch {
	case value == nil:
		return "absent"
	case *value:
		return "true"
	default:
		return "false"
	}
}

const agentStatusColumns = "node_id,workspace_id,session_id,generation,agent_id,unread,verified,restored,errored,interrupted,transcript_ref,state,session_phase,reason_code,deleted,revision,last_event_at_ms,updated_at_ms,payload"

func scanAgentStatus(row scanner) (AgentStatus, error) {
	var status AgentStatus
	var revision, generation, unread int64
	var verified, restored, deleted int
	var errored, interrupted sql.NullInt64
	err := row.Scan(&status.NodeID, &status.WorkspaceID, &status.SessionID, &generation,
		&status.AgentID, &unread, &verified, &restored, &errored, &interrupted,
		&status.TranscriptRef, &status.State, &status.SessionPhase, &status.ReasonCode,
		&deleted, &revision, &status.LastEventMS, &status.UpdatedAtMS, &status.Payload)
	if errors.Is(err, sql.ErrNoRows) {
		return status, ErrNotFound
	}
	if err != nil {
		return status, err
	}
	if revision < 1 || generation < 0 || unread < 0 || unread > math.MaxUint32 {
		return AgentStatus{}, ErrCorrupt
	}
	status.Revision, status.Generation, status.Unread = uint64(revision), uint64(generation), uint32(unread)
	status.Verified, status.Restored, status.Deleted = verified == 1, restored == 1, deleted == 1
	status.Errored, status.Interrupted = scanOptionalBool(errored), scanOptionalBool(interrupted)
	if validateAgentStatus(status) != nil {
		return AgentStatus{}, ErrCorrupt
	}
	return status, nil
}

// GetAgentStatus reads one node's status, tombstones included.
func (s *Store) GetAgentStatus(ctx context.Context, nodeID string) (AgentStatus, error) {
	if !textValid(nodeID, agentIdentityLimit, false) {
		return AgentStatus{}, ErrInvalid
	}
	return scanAgentStatus(s.db.QueryRowContext(ctx, "SELECT "+agentStatusColumns+" FROM agent_status WHERE node_id=?", nodeID))
}

// ListAgentStatus pages one workspace's live statuses by node identifier.
func (s *Store) ListAgentStatus(ctx context.Context, workspaceID, after string, limit int) ([]AgentStatus, bool, error) {
	if !textValid(workspaceID, agentIdentityLimit, false) || !textValid(after, agentIdentityLimit, true) {
		return nil, false, ErrInvalid
	}
	size, err := pageSize(limit)
	if err != nil {
		return nil, false, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+agentStatusColumns+" FROM agent_status WHERE workspace_id=? AND node_id>? AND deleted=0 ORDER BY node_id LIMIT ?", workspaceID, after, size+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	statuses := []AgentStatus{}
	for rows.Next() {
		status, err := scanAgentStatus(rows)
		if err != nil {
			return nil, false, err
		}
		statuses = append(statuses, status)
	}
	if err = rows.Err(); err != nil {
		return nil, false, err
	}
	if len(statuses) > size {
		return statuses[:size], true, nil
	}
	return statuses, false, nil
}

// AllAgentStatus reads every status this Host holds, tombstones included, in
// node order. It is what a reverse export walks, and it is complete on purpose:
// a partial package would be a rollback that quietly dropped a node.
func (s *Store) AllAgentStatus(ctx context.Context) ([]AgentStatus, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+agentStatusColumns+" FROM agent_status ORDER BY node_id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	statuses := []AgentStatus{}
	for rows.Next() {
		status, err := scanAgentStatus(rows)
		if err != nil {
			return nil, err
		}
		statuses = append(statuses, status)
	}
	return statuses, rows.Err()
}

// PutAgentStatus stores one node's status under revision CAS and publishes it.
func (s *Store) PutAgentStatus(ctx context.Context, operationID string, status AgentStatus, expected uint64) (ApplyResult, error) {
	if err := validateAgentStatus(status); err != nil {
		return ApplyResult{}, err
	}
	generation, err := signed(status.Generation)
	if err != nil {
		return ApplyResult{}, err
	}
	values := []any{
		status.NodeID, status.WorkspaceID, status.SessionID, generation, status.AgentID,
		int64(status.Unread), boolean(status.Verified), boolean(status.Restored),
		optionalBool(status.Errored), optionalBool(status.Interrupted), blob(status.TranscriptRef),
		status.State, status.SessionPhase, status.ReasonCode, boolean(status.Deleted),
	}
	return s.putAgentRecord(ctx, operationID, agentRecord{
		kind:        AgentStatusKind,
		table:       "agent_status",
		idColumn:    "node_id",
		id:          status.NodeID,
		workspaceID: status.WorkspaceID,
		deleted:     status.Deleted,
		fingerprint: agentStatusFingerprint(status),
		payload:     status.Payload,
		insert: func(ctx context.Context, tx *sql.Tx, next int64) error {
			_, err := tx.ExecContext(ctx, "INSERT INTO agent_status("+agentStatusColumns+") VALUES("+placeholders(19)+")",
				append(append([]any{}, values...), next, status.LastEventMS, status.UpdatedAtMS, blob(status.Payload))...)
			return err
		},
		update: func(ctx context.Context, tx *sql.Tx, next, current int64) error {
			return affectedOne(tx.ExecContext(ctx, "UPDATE agent_status SET workspace_id=?,session_id=?,generation=?,agent_id=?,unread=?,verified=?,restored=?,errored=?,interrupted=?,transcript_ref=?,state=?,session_phase=?,reason_code=?,deleted=?,revision=?,last_event_at_ms=?,updated_at_ms=?,payload=? WHERE node_id=? AND revision=?",
				append(append([]any{}, values[1:]...), next, status.LastEventMS, status.UpdatedAtMS, blob(status.Payload), status.NodeID, current)...))
		},
	}, expected)
}

// placeholders builds `?,?,…` for a fixed column count. The counts here are
// compile-time constants of the schema above; a mismatch fails loudly at the
// first insert rather than silently shifting a column.
func placeholders(count int) string {
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
}

/* -------------------------------------------------------------- approvals */

func validateApproval(approval Approval) error {
	if !textValid(approval.ApprovalID, agentIdentityLimit, false) || !textValid(approval.NodeID, agentIdentityLimit, false) ||
		!textValid(approval.WorkspaceID, agentIdentityLimit, false) || !textValid(approval.SessionID, agentIdentityLimit, true) ||
		!textValid(approval.Decision, 128, true) || !textValid(approval.AnsweredBy, agentIdentityLimit, true) ||
		!textValid(approval.ReasonCode, 64, true) || len(approval.Request) > MaxPayloadBytes ||
		len(approval.Payload) > MaxPayloadBytes ||
		(len(approval.RequestSHA256) != 0 && len(approval.RequestSHA256) != 32) {
		return ErrInvalid
	}
	if approval.State < 0 || approval.State > 3 || approval.CreatedAtMS <= 0 || approval.AnsweredAtMS < 0 {
		return ErrInvalid
	}
	// An answered approval names the answer and when it was given; a pending one
	// names neither. A row with a decision and no moment would be an audit entry
	// that cannot say when somebody allowed something.
	if (approval.Decision != "") != (approval.AnsweredAtMS > 0) {
		return ErrInvalid
	}
	_, err := signed(approval.Generation)
	return err
}

func approvalFingerprint(approval Approval) []byte {
	digest := sha256.New()
	writeDigestPart(digest, []byte("armadra.storage.agent_approval.v1"))
	for _, value := range []string{approval.NodeID, approval.WorkspaceID, approval.SessionID, approval.Decision, approval.AnsweredBy, approval.ReasonCode} {
		writeDigestPart(digest, []byte(value))
	}
	writeDigestPart(digest, approval.RequestSHA256)
	digest.Write([]byte{byte(approval.State)})
	return digest.Sum(nil)
}

const approvalColumns = "approval_id,node_id,workspace_id,session_id,generation,request,request_sha256,decision,answered_by,state,reason_code,revision,created_at_ms,answered_at_ms,payload"

func scanApproval(row scanner) (Approval, error) {
	var approval Approval
	var revision, generation int64
	err := row.Scan(&approval.ApprovalID, &approval.NodeID, &approval.WorkspaceID, &approval.SessionID,
		&generation, &approval.Request, &approval.RequestSHA256, &approval.Decision,
		&approval.AnsweredBy, &approval.State, &approval.ReasonCode, &revision,
		&approval.CreatedAtMS, &approval.AnsweredAtMS, &approval.Payload)
	if errors.Is(err, sql.ErrNoRows) {
		return approval, ErrNotFound
	}
	if err != nil {
		return approval, err
	}
	if revision < 1 || generation < 0 {
		return Approval{}, ErrCorrupt
	}
	approval.Revision, approval.Generation = uint64(revision), uint64(generation)
	if validateApproval(approval) != nil {
		return Approval{}, ErrCorrupt
	}
	return approval, nil
}

func (s *Store) GetApproval(ctx context.Context, approvalID string) (Approval, error) {
	if !textValid(approvalID, agentIdentityLimit, false) {
		return Approval{}, ErrInvalid
	}
	return scanApproval(s.db.QueryRowContext(ctx, "SELECT "+approvalColumns+" FROM agent_approvals WHERE approval_id=?", approvalID))
}

// ListApprovals answers one node's questions, oldest first. `pending` narrows to
// the ones still open, which is what a node header asks for: an answered
// approval is history and a person acting on the board is not being asked
// anything by it.
func (s *Store) ListApprovals(ctx context.Context, nodeID string, pending bool, limit int) ([]Approval, error) {
	if !textValid(nodeID, agentIdentityLimit, false) {
		return nil, ErrInvalid
	}
	size, err := pageSize(limit)
	if err != nil {
		return nil, err
	}
	query := "SELECT " + approvalColumns + " FROM agent_approvals WHERE node_id=?"
	arguments := []any{nodeID}
	if pending {
		query += " AND state=?"
		arguments = append(arguments, 1)
	}
	query += " ORDER BY created_at_ms, approval_id LIMIT ?"
	rows, err := s.db.QueryContext(ctx, query, append(arguments, size)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	approvals := []Approval{}
	for rows.Next() {
		approval, err := scanApproval(rows)
		if err != nil {
			return nil, err
		}
		approvals = append(approvals, approval)
	}
	return approvals, rows.Err()
}

// AllApprovals reads every approval this Host holds, in identifier order.
func (s *Store) AllApprovals(ctx context.Context) ([]Approval, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+approvalColumns+" FROM agent_approvals ORDER BY approval_id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	approvals := []Approval{}
	for rows.Next() {
		approval, err := scanApproval(rows)
		if err != nil {
			return nil, err
		}
		approvals = append(approvals, approval)
	}
	return approvals, rows.Err()
}

// PutApproval stores one approval under revision CAS and publishes it.
//
// The request body is written once, by the insert, and never rewritten: the
// question a person answers has to be the question that was asked, and an
// update that could restate it would make an audit entry meaningless.
func (s *Store) PutApproval(ctx context.Context, operationID string, approval Approval, expected uint64) (ApplyResult, error) {
	if err := validateApproval(approval); err != nil {
		return ApplyResult{}, err
	}
	generation, err := signed(approval.Generation)
	if err != nil {
		return ApplyResult{}, err
	}
	return s.putAgentRecord(ctx, operationID, agentRecord{
		kind:        ApprovalKind,
		table:       "agent_approvals",
		idColumn:    "approval_id",
		id:          approval.ApprovalID,
		workspaceID: approval.WorkspaceID,
		fingerprint: approvalFingerprint(approval),
		payload:     approval.Payload,
		insert: func(ctx context.Context, tx *sql.Tx, next int64) error {
			_, err := tx.ExecContext(ctx, "INSERT INTO agent_approvals("+approvalColumns+") VALUES("+placeholders(15)+")",
				approval.ApprovalID, approval.NodeID, approval.WorkspaceID, approval.SessionID,
				generation, blob(approval.Request), blob(approval.RequestSHA256), approval.Decision,
				approval.AnsweredBy, approval.State, approval.ReasonCode, next,
				approval.CreatedAtMS, approval.AnsweredAtMS, blob(approval.Payload))
			return err
		},
		update: func(ctx context.Context, tx *sql.Tx, next, current int64) error {
			return affectedOne(tx.ExecContext(ctx, "UPDATE agent_approvals SET decision=?,answered_by=?,state=?,reason_code=?,revision=?,answered_at_ms=?,payload=? WHERE approval_id=? AND revision=?",
				approval.Decision, approval.AnsweredBy, approval.State, approval.ReasonCode,
				next, approval.AnsweredAtMS, blob(approval.Payload), approval.ApprovalID, current))
		},
	}, expected)
}
