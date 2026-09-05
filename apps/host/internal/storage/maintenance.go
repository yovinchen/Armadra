package storage

import (
	"context"
	"database/sql"
	"errors"
)

// Maintenance tokens (Go Host 业务所有权迁移 §2.11, step 0).
//
// A maintenance window is what lets write ownership of a domain move, and
// opening one is an action taken at the machine: the token is issued over the
// same-user OS control channel and spent once on an HTTPS switch. That is the
// whole reason it exists — an HTTPS session alone, however well authenticated,
// belongs to a device that may be somewhere else entirely.
//
// Only the hash is stored, exactly as a pairing ticket is. A database someone
// walked off with must not carry the ability to move a domain, and a token that
// is never written down cannot be read back out of a backup.
//
// The record is bound to three things, and all three are checked when it is
// spent: the domain it was asked for, the Host process instance that issued it,
// and its expiry. A token for the canvas cannot open a window on sessions, and
// one issued by a Host that has since restarted is dead — the restart is
// exactly the case where the operator's intent no longer clearly applies.

// MaintenanceToken is the stored side of one issued token. The token itself is
// returned to the caller once and never persisted.
type MaintenanceToken struct {
	Hash                                   []byte
	Domain, InstanceID                     string
	CreatedAtMS, ExpiresAtMS, ConsumedAtMS int64
}

var (
	// ErrMaintenanceToken means the token is unknown, for another domain,
	// from another Host instance, already spent, or expired. The reasons are
	// deliberately one error: telling them apart would tell a caller which
	// half of a guess was right.
	ErrMaintenanceToken = errors.New("maintenance token is not valid for this window")
)

func (t MaintenanceToken) validate() error {
	if len(t.Hash) != 32 || !ValidOwnershipDomain(t.Domain) || !textValid(t.InstanceID, 256, false) {
		return ErrInvalid
	}
	if t.CreatedAtMS <= 0 || t.ExpiresAtMS <= t.CreatedAtMS {
		return ErrInvalid
	}
	return nil
}

// PutMaintenanceToken records one issued token. A hash that already exists is a
// conflict rather than an overwrite: reissuing the same secret would reset an
// expiry the operator is entitled to see run out.
func (s *Store) PutMaintenanceToken(ctx context.Context, token MaintenanceToken) error {
	if err := token.validate(); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var existing int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM maintenance_tokens WHERE token_hash=?", token.Hash).Scan(&existing); err != nil {
		return err
	}
	if existing != 0 {
		return ErrConflict
	}
	if _, err = tx.ExecContext(ctx,
		"INSERT INTO maintenance_tokens(token_hash,domain,instance_id,created_at_ms,expires_at_ms,consumed_at_ms) VALUES(?,?,?,?,?,0)",
		token.Hash, token.Domain, token.InstanceID, token.CreatedAtMS, token.ExpiresAtMS); err != nil {
		return err
	}
	return tx.Commit()
}

// ConsumeMaintenanceToken spends a token for exactly one domain, once. The read
// and the write are one transaction, so two switches racing for the same token
// cannot both find it unspent.
func (s *Store) ConsumeMaintenanceToken(ctx context.Context, hash []byte, domain, instanceID string, nowMS int64) error {
	if len(hash) != 32 || !ValidOwnershipDomain(domain) || instanceID == "" || nowMS <= 0 {
		return ErrInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var stored MaintenanceToken
	err = tx.QueryRowContext(ctx,
		"SELECT domain,instance_id,created_at_ms,expires_at_ms,consumed_at_ms FROM maintenance_tokens WHERE token_hash=?", hash).
		Scan(&stored.Domain, &stored.InstanceID, &stored.CreatedAtMS, &stored.ExpiresAtMS, &stored.ConsumedAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrMaintenanceToken
	}
	if err != nil {
		return err
	}
	if stored.Domain != domain || stored.InstanceID != instanceID || stored.ConsumedAtMS != 0 || stored.ExpiresAtMS <= nowMS {
		return ErrMaintenanceToken
	}
	if err = changed(tx.ExecContext(ctx, "UPDATE maintenance_tokens SET consumed_at_ms=? WHERE token_hash=? AND consumed_at_ms=0", nowMS, hash)); err != nil {
		return err
	}
	return tx.Commit()
}

// PruneMaintenanceTokens drops rows that can no longer be spent. Nothing
// depends on it running: an expired token is refused whether or not its row is
// still there, so this only keeps the table from growing.
func (s *Store) PruneMaintenanceTokens(ctx context.Context, nowMS int64) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM maintenance_tokens WHERE expires_at_ms <= ? OR consumed_at_ms > 0", nowMS)
	return err
}
