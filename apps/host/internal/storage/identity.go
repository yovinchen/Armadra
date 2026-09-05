package storage

import (
	"context"
	"database/sql"
	"errors"
	"math"
)

// IdentityTx is a private, trusted-host repository. It exposes no raw SQL or
// generic entity access. Do not retain it outside IdentityTransaction or call
// Store methods from its callback (the connection is already acquired).
// Authorization and credential hashing belong to internal/identity; this layer
// only persists typed records, enforces CAS and keeps them out of the outbox.
type IdentityTx struct {
	tx  *sql.Tx
	ctx context.Context
}

type IdentityOwner struct {
	PrincipalID string
	CreatedAtMS int64
}
type IdentityDevice struct {
	ID, PrincipalID, Name, Role string
	Epoch                       uint64
	CreatedAtMS, RevokedAtMS    int64
}
type IdentitySession struct {
	ID, DeviceID, Origin                                     string
	DeviceEpoch, Rotation                                    uint64
	Scopes                                                   []byte
	AccessHash, RefreshHash, CSRFHash                        [32]byte
	CreatedAtMS, AccessExpiresAtMS, ExpiresAtMS, RevokedAtMS int64
}
type IdentityTicket struct {
	ID, HostID, InstanceID, Origin, DeviceName string
	Hash                                       [32]byte
	Scopes                                     []byte
	CreatedAtMS, ExpiresAtMS, ConsumedAtMS     int64
}

func (s *Store) IdentityTransaction(ctx context.Context, action func(*IdentityTx) error) error {
	if action == nil {
		return ErrInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = action(&IdentityTx{tx: tx, ctx: ctx}); err != nil {
		return err
	}
	return tx.Commit()
}
func identityError(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
func (t *IdentityTx) Owner() (IdentityOwner, error) {
	var v IdentityOwner
	err := t.tx.QueryRowContext(t.ctx, "SELECT principal_id,created_at_ms FROM identity_owner WHERE singleton=1").Scan(&v.PrincipalID, &v.CreatedAtMS)
	return v, identityError(err)
}
func (t *IdentityTx) CreateOwner(v IdentityOwner) error {
	if !hostPattern.MatchString(v.PrincipalID) || v.CreatedAtMS <= 0 {
		return ErrInvalid
	}
	_, err := t.tx.ExecContext(t.ctx, "INSERT INTO identity_owner(singleton,principal_id,created_at_ms) VALUES(1,?,?)", v.PrincipalID, v.CreatedAtMS)
	return err
}
func (t *IdentityTx) Device(id string) (IdentityDevice, error) {
	var v IdentityDevice
	err := t.tx.QueryRowContext(t.ctx, "SELECT device_id,principal_id,name,role,epoch,created_at_ms,revoked_at_ms FROM identity_devices WHERE device_id=?", id).Scan(&v.ID, &v.PrincipalID, &v.Name, &v.Role, &v.Epoch, &v.CreatedAtMS, &v.RevokedAtMS)
	return v, identityError(err)
}
func (t *IdentityTx) CreateDevice(v IdentityDevice) error {
	if !hostPattern.MatchString(v.ID) || !hostPattern.MatchString(v.PrincipalID) || v.Role != "owner" || v.Epoch != 1 || v.RevokedAtMS != 0 {
		return ErrInvalid
	}
	_, err := t.tx.ExecContext(t.ctx, "INSERT INTO identity_devices(device_id,principal_id,name,role,epoch,created_at_ms,revoked_at_ms) VALUES(?,?,?,?,?,?,0)", v.ID, v.PrincipalID, v.Name, v.Role, v.Epoch, v.CreatedAtMS)
	return err
}
func (t *IdentityTx) Devices(afterID string, limit int) ([]IdentityDevice, error) {
	if limit < 1 || limit > 1000 {
		return nil, ErrInvalid
	}
	rows, err := t.tx.QueryContext(t.ctx, "SELECT device_id,principal_id,name,role,epoch,created_at_ms,revoked_at_ms FROM identity_devices WHERE device_id>? ORDER BY device_id LIMIT ?", afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []IdentityDevice{}
	for rows.Next() {
		var v IdentityDevice
		if err = rows.Scan(&v.ID, &v.PrincipalID, &v.Name, &v.Role, &v.Epoch, &v.CreatedAtMS, &v.RevokedAtMS); err != nil {
			return nil, err
		}
		values = append(values, v)
	}
	return values, rows.Err()
}
func changed(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return ErrConflict
	}
	return nil
}
func (t *IdentityTx) RevokeDevice(id string, epoch uint64, atMS int64) error {
	if epoch >= math.MaxInt64 {
		return ErrCounterExhausted
	}
	if epoch == 0 || atMS <= 0 {
		return ErrInvalid
	}
	return changed(t.tx.ExecContext(t.ctx, "UPDATE identity_devices SET epoch=epoch+1,revoked_at_ms=? WHERE device_id=? AND epoch=? AND revoked_at_ms=0", atMS, id, epoch))
}
func (t *IdentityTx) Ticket(id string) (IdentityTicket, error) {
	var v IdentityTicket
	var digest []byte
	err := t.tx.QueryRowContext(t.ctx, "SELECT ticket_id,ticket_hash,host_id,instance_id,origin,device_name,scopes,created_at_ms,expires_at_ms,consumed_at_ms FROM identity_bootstrap_tickets WHERE ticket_id=?", id).Scan(&v.ID, &digest, &v.HostID, &v.InstanceID, &v.Origin, &v.DeviceName, &v.Scopes, &v.CreatedAtMS, &v.ExpiresAtMS, &v.ConsumedAtMS)
	if err == nil {
		if len(digest) != 32 {
			return v, ErrCorrupt
		}
		copy(v.Hash[:], digest)
	}
	return v, identityError(err)
}
func (t *IdentityTx) CreateTicket(v IdentityTicket) error {
	if !hostPattern.MatchString(v.ID) || !hostPattern.MatchString(v.HostID) || v.ConsumedAtMS != 0 {
		return ErrInvalid
	}
	_, err := t.tx.ExecContext(t.ctx, "INSERT INTO identity_bootstrap_tickets(ticket_id,ticket_hash,host_id,instance_id,origin,device_name,scopes,created_at_ms,expires_at_ms,consumed_at_ms) VALUES(?,?,?,?,?,?,?,?,?,0)", v.ID, v.Hash[:], v.HostID, v.InstanceID, v.Origin, v.DeviceName, v.Scopes, v.CreatedAtMS, v.ExpiresAtMS)
	return err
}
func (t *IdentityTx) ConsumeTicket(id string, atMS int64) error {
	if atMS <= 0 {
		return ErrInvalid
	}
	return changed(t.tx.ExecContext(t.ctx, "UPDATE identity_bootstrap_tickets SET consumed_at_ms=? WHERE ticket_id=? AND consumed_at_ms=0 AND created_at_ms<=? AND expires_at_ms>?", atMS, id, atMS, atMS))
}
func (t *IdentityTx) Session(id string) (IdentitySession, error) {
	var v IdentitySession
	var access, refresh, csrf []byte
	err := t.tx.QueryRowContext(t.ctx, "SELECT session_id,device_id,device_epoch,origin,scopes,access_hash,refresh_hash,csrf_hash,rotation,created_at_ms,access_expires_at_ms,expires_at_ms,revoked_at_ms FROM identity_sessions WHERE session_id=?", id).Scan(&v.ID, &v.DeviceID, &v.DeviceEpoch, &v.Origin, &v.Scopes, &access, &refresh, &csrf, &v.Rotation, &v.CreatedAtMS, &v.AccessExpiresAtMS, &v.ExpiresAtMS, &v.RevokedAtMS)
	if err == nil {
		if len(access) != 32 || len(refresh) != 32 || len(csrf) != 32 {
			return v, ErrCorrupt
		}
		copy(v.AccessHash[:], access)
		copy(v.RefreshHash[:], refresh)
		copy(v.CSRFHash[:], csrf)
	}
	return v, identityError(err)
}
func (t *IdentityTx) CreateSession(v IdentitySession) error {
	if !hostPattern.MatchString(v.ID) || !hostPattern.MatchString(v.DeviceID) || v.Rotation != 1 || v.DeviceEpoch < 1 || v.DeviceEpoch > math.MaxInt64 || v.RevokedAtMS != 0 {
		return ErrInvalid
	}
	_, err := t.tx.ExecContext(t.ctx, "INSERT INTO identity_sessions(session_id,device_id,device_epoch,origin,scopes,access_hash,refresh_hash,csrf_hash,rotation,created_at_ms,access_expires_at_ms,expires_at_ms,revoked_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)", v.ID, v.DeviceID, v.DeviceEpoch, v.Origin, v.Scopes, v.AccessHash[:], v.RefreshHash[:], v.CSRFHash[:], v.Rotation, v.CreatedAtMS, v.AccessExpiresAtMS, v.ExpiresAtMS)
	return err
}

// Rotation cannot change grants, device ownership, origin or absolute expiry.
func (t *IdentityTx) RotateSession(id string, expected uint64, access, refresh, csrf [32]byte, accessExpiryMS int64) error {
	if expected >= math.MaxInt64 {
		return ErrCounterExhausted
	}
	if expected < 1 {
		return ErrInvalid
	}
	return changed(t.tx.ExecContext(t.ctx, "UPDATE identity_sessions SET access_hash=?,refresh_hash=?,csrf_hash=?,access_expires_at_ms=?,rotation=rotation+1 WHERE session_id=? AND rotation=? AND revoked_at_ms=0", access[:], refresh[:], csrf[:], accessExpiryMS, id, expected))
}
func (t *IdentityTx) RevokeSession(id string, atMS int64) error {
	if atMS <= 0 {
		return ErrInvalid
	}
	return changed(t.tx.ExecContext(t.ctx, "UPDATE identity_sessions SET revoked_at_ms=? WHERE session_id=? AND revoked_at_ms=0", atMS, id))
}
func (t *IdentityTx) RenewSessionCSRF(id string, expected uint64, csrf [32]byte) error {
	if expected >= math.MaxInt64 {
		return ErrCounterExhausted
	}
	if expected < 1 {
		return ErrInvalid
	}
	return changed(t.tx.ExecContext(t.ctx, "UPDATE identity_sessions SET csrf_hash=?,rotation=rotation+1 WHERE session_id=? AND rotation=? AND revoked_at_ms=0", csrf[:], id, expected))
}
