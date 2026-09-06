package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"math"
)

// What nodes say to each other, and what became of it
// (Go Host 业务所有权迁移 §3.1 v9, §2.7).
//
// Two tables that look similar and are not. A mailbox message is a *thing that
// exists* — it sits in an inbox until somebody reads it, and it can be
// withdrawn. A delivery is a *record of an attempt* — it never changes what it
// says about the past, and it carries no body, only how many characters there
// were. A log that carried bodies would be a second copy of every conversation
// in the one database meant to hold decisions rather than content.
//
// The mailbox's `sequence` is its own order and has nothing to do with the
// event stream's. It is what an inbox pages by, and it is allocated here rather
// than by a caller: two nodes posting at the same moment must not be able to
// choose the same position in one inbox.

// MailboxMessage is one message left for a node.
type MailboxMessage struct {
	MessageID    string
	WorkspaceID  string
	SourceNodeID string
	TargetNodeID string
	MessageKey   string
	Body         string
	Sequence     uint64
	Deleted      bool
	Revision     uint64
	CreatedAtMS  int64
	ExpiresAtMS  int64
	AckedAtMS    int64
	Payload      []byte
}

// Delivery is the receipt for one attempt to put something in front of an
// agent. It has no `deleted`: an attempt that happened cannot stop having
// happened, and a delivery log a client could clear would be one nobody could
// use to explain what an agent was told.
type Delivery struct {
	TraceID      string
	WorkspaceID  string
	SourceNodeID string
	TargetNodeID string
	Receipt      string
	BodyChars    uint32
	Outcome      int32
	ReasonCode   string
	Revision     uint64
	CreatedAtMS  int64
	Payload      []byte
}

const (
	// MaxMailboxBody bounds one message. It is generous for anything a person
	// or an agent writes and small enough that an inbox cannot become a file
	// transfer.
	MaxMailboxBody = 64 << 10
)

func validateMailbox(message MailboxMessage) error {
	if !textValid(message.MessageID, agentIdentityLimit, false) || !textValid(message.WorkspaceID, agentIdentityLimit, false) ||
		!textValid(message.SourceNodeID, agentIdentityLimit, false) || !textValid(message.TargetNodeID, agentIdentityLimit, false) ||
		!textValid(message.MessageKey, agentIdentityLimit, true) || !textValid(message.Body, MaxMailboxBody, true) ||
		len(message.Payload) > MaxPayloadBytes {
		return ErrInvalid
	}
	if message.CreatedAtMS <= 0 || message.ExpiresAtMS < 0 || message.AckedAtMS < 0 {
		return ErrInvalid
	}
	// A withdrawn message carries no body. Keeping one would leave what
	// somebody deleted readable in the row that says it is gone.
	if message.Deleted && message.Body != "" {
		return ErrInvalid
	}
	if _, err := signed(message.Sequence); err != nil {
		return err
	}
	if message.Sequence == 0 {
		return ErrInvalid
	}
	return nil
}

func mailboxFingerprint(message MailboxMessage) []byte {
	if message.Deleted {
		return nil
	}
	digest := sha256.New()
	writeDigestPart(digest, []byte("armadra.storage.agent_mailbox.v1"))
	for _, value := range []string{message.WorkspaceID, message.SourceNodeID, message.TargetNodeID, message.MessageKey, message.Body} {
		writeDigestPart(digest, []byte(value))
	}
	// Acknowledgement is part of the request: posting a message and marking one
	// read are two different decisions about the same row, and an operation id
	// reused across them has to be refused rather than replayed as the first.
	if message.AckedAtMS > 0 {
		writeDigestPart(digest, []byte("acknowledged"))
	} else {
		writeDigestPart(digest, []byte("unread"))
	}
	return digest.Sum(nil)
}

const mailboxColumns = "message_id,workspace_id,source_node_id,target_node_id,message_key,body,sequence,deleted,revision,created_at_ms,expires_at_ms,acknowledged_at_ms,payload"

func scanMailbox(row scanner) (MailboxMessage, error) {
	var message MailboxMessage
	var revision, sequence int64
	var deleted int
	err := row.Scan(&message.MessageID, &message.WorkspaceID, &message.SourceNodeID,
		&message.TargetNodeID, &message.MessageKey, &message.Body, &sequence, &deleted,
		&revision, &message.CreatedAtMS, &message.ExpiresAtMS, &message.AckedAtMS, &message.Payload)
	if errors.Is(err, sql.ErrNoRows) {
		return message, ErrNotFound
	}
	if err != nil {
		return message, err
	}
	if revision < 1 || sequence < 1 {
		return MailboxMessage{}, ErrCorrupt
	}
	message.Revision, message.Sequence, message.Deleted = uint64(revision), uint64(sequence), deleted == 1
	if validateMailbox(message) != nil {
		return MailboxMessage{}, ErrCorrupt
	}
	return message, nil
}

func (s *Store) GetMailboxMessage(ctx context.Context, messageID string) (MailboxMessage, error) {
	if !textValid(messageID, agentIdentityLimit, false) {
		return MailboxMessage{}, ErrInvalid
	}
	return scanMailbox(s.db.QueryRowContext(ctx, "SELECT "+mailboxColumns+" FROM agent_mailbox WHERE message_id=?", messageID))
}

// NextMailboxSequence allocates the next position in the whole mailbox.
//
// It is taken from the table's own maximum rather than from a counter, so a
// restored database is consistent with itself: a sequence handed out from a
// counter that had been rolled back would collide with a message already in an
// inbox.
func (s *Store) NextMailboxSequence(ctx context.Context) (uint64, error) {
	var highest sql.NullInt64
	if err := s.db.QueryRowContext(ctx, "SELECT MAX(sequence) FROM agent_mailbox").Scan(&highest); err != nil {
		return 0, err
	}
	if !highest.Valid {
		return 1, nil
	}
	if highest.Int64 < 0 || highest.Int64 == math.MaxInt64 {
		return 0, ErrCounterExhausted
	}
	return uint64(highest.Int64) + 1, nil
}

// ListMailbox answers one node's inbox, oldest first. `unread` narrows to what
// nobody has acknowledged, which is what a badge counts.
func (s *Store) ListMailbox(ctx context.Context, targetNodeID string, unread bool, limit int) ([]MailboxMessage, error) {
	if !textValid(targetNodeID, agentIdentityLimit, false) {
		return nil, ErrInvalid
	}
	size, err := pageSize(limit)
	if err != nil {
		return nil, err
	}
	query := "SELECT " + mailboxColumns + " FROM agent_mailbox WHERE target_node_id=? AND deleted=0"
	if unread {
		query += " AND acknowledged_at_ms=0"
	}
	query += " ORDER BY sequence LIMIT ?"
	rows, err := s.db.QueryContext(ctx, query, targetNodeID, size)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := []MailboxMessage{}
	for rows.Next() {
		message, err := scanMailbox(rows)
		if err != nil {
			return nil, err
		}
		messages = append(messages, message)
	}
	return messages, rows.Err()
}

// AllMailbox reads every message this Host holds, tombstones included, in
// sequence order — which is also the order an inbox restores in.
func (s *Store) AllMailbox(ctx context.Context) ([]MailboxMessage, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+mailboxColumns+" FROM agent_mailbox ORDER BY sequence")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := []MailboxMessage{}
	for rows.Next() {
		message, err := scanMailbox(rows)
		if err != nil {
			return nil, err
		}
		messages = append(messages, message)
	}
	return messages, rows.Err()
}

// PutMailboxMessage stores one message under revision CAS and publishes it.
//
// The unique index over (source, target, key) is what makes a retrying sender
// harmless: a second post of the same thought is a constraint violation rather
// than a second copy in somebody's inbox.
func (s *Store) PutMailboxMessage(ctx context.Context, operationID string, message MailboxMessage, expected uint64) (ApplyResult, error) {
	if err := validateMailbox(message); err != nil {
		return ApplyResult{}, err
	}
	sequence, err := signed(message.Sequence)
	if err != nil {
		return ApplyResult{}, err
	}
	return s.putAgentRecord(ctx, operationID, agentRecord{
		kind:        MailboxKind,
		table:       "agent_mailbox",
		idColumn:    "message_id",
		id:          message.MessageID,
		workspaceID: message.WorkspaceID,
		deleted:     message.Deleted,
		fingerprint: mailboxFingerprint(message),
		payload:     message.Payload,
		insert: func(ctx context.Context, tx *sql.Tx, next int64) error {
			_, err := tx.ExecContext(ctx, "INSERT INTO agent_mailbox("+mailboxColumns+") VALUES("+placeholders(13)+")",
				message.MessageID, message.WorkspaceID, message.SourceNodeID, message.TargetNodeID,
				message.MessageKey, message.Body, sequence, boolean(message.Deleted), next,
				message.CreatedAtMS, message.ExpiresAtMS, message.AckedAtMS, message.Payload)
			return err
		},
		update: func(ctx context.Context, tx *sql.Tx, next, current int64) error {
			return affectedOne(tx.ExecContext(ctx, "UPDATE agent_mailbox SET body=?,deleted=?,revision=?,expires_at_ms=?,acknowledged_at_ms=?,payload=? WHERE message_id=? AND revision=?",
				message.Body, boolean(message.Deleted), next, message.ExpiresAtMS,
				message.AckedAtMS, message.Payload, message.MessageID, current))
		},
	}, expected)
}

/* ------------------------------------------------------------- deliveries */

func validateDelivery(delivery Delivery) error {
	if !textValid(delivery.TraceID, agentIdentityLimit, false) || !textValid(delivery.WorkspaceID, agentIdentityLimit, false) ||
		!textValid(delivery.SourceNodeID, agentIdentityLimit, true) || !textValid(delivery.TargetNodeID, agentIdentityLimit, false) ||
		!textValid(delivery.Receipt, 1024, true) || !textValid(delivery.ReasonCode, 64, true) ||
		len(delivery.Payload) > MaxPayloadBytes {
		return ErrInvalid
	}
	if delivery.Outcome < 0 || delivery.Outcome > 3 || delivery.CreatedAtMS <= 0 {
		return ErrInvalid
	}
	return nil
}

func deliveryFingerprint(delivery Delivery) []byte {
	digest := sha256.New()
	writeDigestPart(digest, []byte("armadra.storage.agent_delivery.v1"))
	for _, value := range []string{delivery.WorkspaceID, delivery.SourceNodeID, delivery.TargetNodeID, delivery.Receipt, delivery.ReasonCode} {
		writeDigestPart(digest, []byte(value))
	}
	digest.Write([]byte{byte(delivery.Outcome)})
	return digest.Sum(nil)
}

const deliveryColumns = "trace_id,workspace_id,source_node_id,target_node_id,receipt,body_chars,outcome,reason_code,revision,created_at_ms,payload"

func scanDelivery(row scanner) (Delivery, error) {
	var delivery Delivery
	var revision, chars int64
	err := row.Scan(&delivery.TraceID, &delivery.WorkspaceID, &delivery.SourceNodeID,
		&delivery.TargetNodeID, &delivery.Receipt, &chars, &delivery.Outcome,
		&delivery.ReasonCode, &revision, &delivery.CreatedAtMS, &delivery.Payload)
	if errors.Is(err, sql.ErrNoRows) {
		return delivery, ErrNotFound
	}
	if err != nil {
		return delivery, err
	}
	if revision < 1 || chars < 0 || chars > math.MaxUint32 {
		return Delivery{}, ErrCorrupt
	}
	delivery.Revision, delivery.BodyChars = uint64(revision), uint32(chars)
	if validateDelivery(delivery) != nil {
		return Delivery{}, ErrCorrupt
	}
	return delivery, nil
}

func (s *Store) GetDelivery(ctx context.Context, traceID string) (Delivery, error) {
	if !textValid(traceID, agentIdentityLimit, false) {
		return Delivery{}, ErrInvalid
	}
	return scanDelivery(s.db.QueryRowContext(ctx, "SELECT "+deliveryColumns+" FROM agent_deliveries WHERE trace_id=?", traceID))
}

// ListDeliveries answers what a node was told, newest first — which is the
// order somebody asking "what just happened here" reads in.
func (s *Store) ListDeliveries(ctx context.Context, targetNodeID string, limit int) ([]Delivery, error) {
	if !textValid(targetNodeID, agentIdentityLimit, false) {
		return nil, ErrInvalid
	}
	size, err := pageSize(limit)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+deliveryColumns+" FROM agent_deliveries WHERE target_node_id=? ORDER BY created_at_ms DESC, trace_id LIMIT ?", targetNodeID, size)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	deliveries := []Delivery{}
	for rows.Next() {
		delivery, err := scanDelivery(rows)
		if err != nil {
			return nil, err
		}
		deliveries = append(deliveries, delivery)
	}
	return deliveries, rows.Err()
}

// AllDeliveries reads every receipt this Host holds, in identifier order.
func (s *Store) AllDeliveries(ctx context.Context) ([]Delivery, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+deliveryColumns+" FROM agent_deliveries ORDER BY trace_id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	deliveries := []Delivery{}
	for rows.Next() {
		delivery, err := scanDelivery(rows)
		if err != nil {
			return nil, err
		}
		deliveries = append(deliveries, delivery)
	}
	return deliveries, rows.Err()
}

// PutDelivery records one attempt under revision CAS and publishes it.
func (s *Store) PutDelivery(ctx context.Context, operationID string, delivery Delivery, expected uint64) (ApplyResult, error) {
	if err := validateDelivery(delivery); err != nil {
		return ApplyResult{}, err
	}
	return s.putAgentRecord(ctx, operationID, agentRecord{
		kind:        DeliveryKind,
		table:       "agent_deliveries",
		idColumn:    "trace_id",
		id:          delivery.TraceID,
		workspaceID: delivery.WorkspaceID,
		fingerprint: deliveryFingerprint(delivery),
		payload:     delivery.Payload,
		insert: func(ctx context.Context, tx *sql.Tx, next int64) error {
			_, err := tx.ExecContext(ctx, "INSERT INTO agent_deliveries("+deliveryColumns+") VALUES("+placeholders(11)+")",
				delivery.TraceID, delivery.WorkspaceID, delivery.SourceNodeID, delivery.TargetNodeID,
				delivery.Receipt, int64(delivery.BodyChars), delivery.Outcome, delivery.ReasonCode,
				next, delivery.CreatedAtMS, delivery.Payload)
			return err
		},
		update: func(ctx context.Context, tx *sql.Tx, next, current int64) error {
			return affectedOne(tx.ExecContext(ctx, "UPDATE agent_deliveries SET receipt=?,body_chars=?,outcome=?,reason_code=?,revision=?,payload=? WHERE trace_id=? AND revision=?",
				delivery.Receipt, int64(delivery.BodyChars), delivery.Outcome, delivery.ReasonCode,
				next, delivery.Payload, delivery.TraceID, current))
		},
	}, expected)
}
