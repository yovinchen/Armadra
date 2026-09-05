package storage

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"math"
)

// CommandSessionState is durable Host knowledge, not a Worker liveness probe.
// Unrebuildable is terminal for that definition: the Host refuses to dispatch
// to it and reports the reason instead of leaving a plan waiting forever.
type CommandSessionState uint8

const (
	CommandSessionReady         CommandSessionState = 1
	CommandSessionUnrebuildable CommandSessionState = 2
	MaxCommandLaunchBytes                           = 128 << 10
	MaxAutomationPayloadBytes                       = 256 << 10
	MaxCommandRoots                                 = 1024
)

// CommandRoot is the frozen absolute directory a command session is confined
// to. Path is stored exactly as the Worker canonicalized it.
type CommandRoot struct {
	RootID, WorkspaceID, Path string
	CreatedAtMS               int64
}

// CommandSession is the Host's own copy of a frozen non-interactive command
// definition, sufficient to recreate it on a replaced Worker. Launch holds the
// serialized launch specification; this package never interprets it.
type CommandSession struct {
	SessionID, RootID, WorkspaceID, ExecutionHostID string
	Launch                                          []byte
	LaunchSHA256                                    [32]byte
	Generation, Revision                            uint64
	State                                           CommandSessionState
	ReasonCode                                      string
	CreatedAtMS, UpdatedAtMS                        int64
}

// AutomationPayload is private immutable content addressed by its own digest.
// It is never part of the entity/event surface and never holds a credential.
type AutomationPayload struct {
	WorkspaceID, Ref string
	Payload          []byte
	SHA256           [32]byte
	CreatedAtMS      int64
}

// AutomationGrant records the scopes a device held when it authorized a plan.
// Dispatch re-reads it; a revoked or re-keyed device no longer authorizes work.
type AutomationGrant struct {
	AuthorizationID, PrincipalID, DeviceID string
	DeviceEpoch                            uint64
	Scopes                                 []byte
	CreatedAtMS, UpdatedAtMS               int64
}

func validCommandID(value string) bool { return textValid(value, 256, false) }

func (r CommandRoot) validate() error {
	if !validCommandID(r.RootID) || !validCommandID(r.WorkspaceID) || !textValid(r.Path, 4096, false) || r.CreatedAtMS <= 0 {
		return ErrInvalid
	}
	return nil
}
func (v CommandSession) validate() error {
	if !validCommandID(v.SessionID) || !validCommandID(v.RootID) || !validCommandID(v.WorkspaceID) || !validCommandID(v.ExecutionHostID) {
		return ErrInvalid
	}
	if len(v.Launch) == 0 || len(v.Launch) > MaxCommandLaunchBytes || v.Generation == 0 || v.Generation > math.MaxInt64 {
		return ErrInvalid
	}
	if v.State != CommandSessionReady && v.State != CommandSessionUnrebuildable {
		return ErrInvalid
	}
	if !textValid(v.ReasonCode, 64, true) || v.CreatedAtMS <= 0 || v.UpdatedAtMS <= 0 {
		return ErrInvalid
	}
	return nil
}

func scanCommandSession(row scanner) (CommandSession, error) {
	var v CommandSession
	var digest []byte
	var generation, revision, state int64
	err := row.Scan(&v.SessionID, &v.RootID, &v.WorkspaceID, &v.ExecutionHostID, &v.Launch, &digest, &generation, &state, &v.ReasonCode, &revision, &v.CreatedAtMS, &v.UpdatedAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return CommandSession{}, ErrNotFound
	}
	if err != nil {
		return CommandSession{}, err
	}
	if len(digest) != 32 || generation < 1 || revision < 1 || state < 1 || state > 2 {
		return CommandSession{}, ErrCorrupt
	}
	copy(v.LaunchSHA256[:], digest)
	v.Generation, v.Revision, v.State = uint64(generation), uint64(revision), CommandSessionState(state)
	if v.validate() != nil {
		return CommandSession{}, ErrCorrupt
	}
	return v, nil
}

// PutCommandRoot is create-or-verify. An identical binding is idempotent; a
// different path for the same identifier is a conflict, never an overwrite.
func (s *Store) PutCommandRoot(ctx context.Context, record CommandRoot) (CommandRoot, error) {
	if err := record.validate(); err != nil {
		return CommandRoot{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return CommandRoot{}, err
	}
	defer tx.Rollback()
	existing := CommandRoot{}
	err = tx.QueryRowContext(ctx, "SELECT root_id,workspace_id,path,created_at_ms FROM command_roots WHERE root_id=?", record.RootID).Scan(&existing.RootID, &existing.WorkspaceID, &existing.Path, &existing.CreatedAtMS)
	if err == nil {
		if existing.WorkspaceID != record.WorkspaceID || existing.Path != record.Path {
			return CommandRoot{}, ErrConflict
		}
		return existing, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return CommandRoot{}, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM command_roots").Scan(&count); err != nil {
		return CommandRoot{}, err
	}
	if count >= MaxCommandRoots {
		return CommandRoot{}, ErrInvalid
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO command_roots(root_id,workspace_id,path,created_at_ms) VALUES(?,?,?,?)", record.RootID, record.WorkspaceID, record.Path, record.CreatedAtMS); err != nil {
		return CommandRoot{}, err
	}
	return record, tx.Commit()
}

func (s *Store) CommandRoots(ctx context.Context) ([]CommandRoot, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT root_id,workspace_id,path,created_at_ms FROM command_roots ORDER BY root_id LIMIT ?", MaxCommandRoots)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []CommandRoot{}
	for rows.Next() {
		var v CommandRoot
		if err = rows.Scan(&v.RootID, &v.WorkspaceID, &v.Path, &v.CreatedAtMS); err != nil {
			return nil, err
		}
		if v.validate() != nil {
			return nil, ErrCorrupt
		}
		values = append(values, v)
	}
	return values, rows.Err()
}

// PutCommandSession creates a frozen definition. Re-defining the same
// identifier with a different root, workspace or launch specification is a
// conflict: a plan's target must never change meaning underneath it.
func (s *Store) PutCommandSession(ctx context.Context, record CommandSession) (CommandSession, error) {
	if err := record.validate(); err != nil {
		return CommandSession{}, err
	}
	if record.State != CommandSessionReady || record.ReasonCode != "" {
		return CommandSession{}, ErrInvalid
	}
	generation, err := signed(record.Generation)
	if err != nil {
		return CommandSession{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return CommandSession{}, err
	}
	defer tx.Rollback()
	existing, err := scanCommandSession(tx.QueryRowContext(ctx, commandSessionColumns+" WHERE session_id=?", record.SessionID))
	if err == nil {
		if existing.RootID != record.RootID || existing.WorkspaceID != record.WorkspaceID || existing.ExecutionHostID != record.ExecutionHostID || !bytes.Equal(existing.Launch, record.Launch) || existing.LaunchSHA256 != record.LaunchSHA256 || existing.Generation != record.Generation {
			return CommandSession{}, ErrConflict
		}
		return existing, tx.Commit()
	}
	if !errors.Is(err, ErrNotFound) {
		return CommandSession{}, err
	}
	record.Revision = 1
	if _, err = tx.ExecContext(ctx, "INSERT INTO command_sessions(session_id,root_id,workspace_id,execution_host_id,launch,launch_sha256,generation,state,reason_code,revision,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)",
		record.SessionID, record.RootID, record.WorkspaceID, record.ExecutionHostID, record.Launch, record.LaunchSHA256[:], generation, int64(record.State), record.ReasonCode, record.CreatedAtMS, record.UpdatedAtMS); err != nil {
		return CommandSession{}, err
	}
	return record, tx.Commit()
}

const commandSessionColumns = "SELECT session_id,root_id,workspace_id,execution_host_id,launch,launch_sha256,generation,state,reason_code,revision,created_at_ms,updated_at_ms FROM command_sessions"

func (s *Store) CommandSession(ctx context.Context, id string) (CommandSession, error) {
	if !validCommandID(id) {
		return CommandSession{}, ErrInvalid
	}
	return scanCommandSession(s.db.QueryRowContext(ctx, commandSessionColumns+" WHERE session_id=?", id))
}

// CommandSessions lists every stored definition, or one workspace's. An empty
// workspace is a host-wide read used by rebuild, never an implicit match.
func (s *Store) CommandSessions(ctx context.Context, workspace, afterID string, limit int) ([]CommandSession, error) {
	size, err := pageSize(limit)
	if err != nil {
		return nil, err
	}
	if !textValid(workspace, 256, true) || !textValid(afterID, 256, true) {
		return nil, ErrInvalid
	}
	query := commandSessionColumns + " WHERE session_id>? AND (?='' OR workspace_id=?) ORDER BY session_id LIMIT ?"
	rows, err := s.db.QueryContext(ctx, query, afterID, workspace, workspace, size)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []CommandSession{}
	for rows.Next() {
		v, err := scanCommandSession(rows)
		if err != nil {
			return nil, err
		}
		values = append(values, v)
	}
	return values, rows.Err()
}

// UpdateCommandSession records what a rebuild observed. It never changes the
// frozen root, workspace or launch specification.
func (s *Store) UpdateCommandSession(ctx context.Context, id string, expectedRevision, generation uint64, state CommandSessionState, reason string, atMS int64) (CommandSession, error) {
	if !validCommandID(id) || expectedRevision == 0 || !textValid(reason, 64, true) || atMS <= 0 {
		return CommandSession{}, ErrInvalid
	}
	if state != CommandSessionReady && state != CommandSessionUnrebuildable {
		return CommandSession{}, ErrInvalid
	}
	if state == CommandSessionReady && reason != "" {
		return CommandSession{}, ErrInvalid
	}
	next, err := signed(expectedRevision + 1)
	if err != nil {
		return CommandSession{}, err
	}
	if generation == 0 {
		return CommandSession{}, ErrInvalid
	}
	value, err := signed(generation)
	if err != nil {
		return CommandSession{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return CommandSession{}, err
	}
	defer tx.Rollback()
	if err = changed(tx.ExecContext(ctx, "UPDATE command_sessions SET generation=?,state=?,reason_code=?,revision=?,updated_at_ms=? WHERE session_id=? AND revision=?", value, int64(state), reason, next, atMS, id, int64(expectedRevision))); err != nil {
		return CommandSession{}, err
	}
	record, err := scanCommandSession(tx.QueryRowContext(ctx, commandSessionColumns+" WHERE session_id=?", id))
	if err != nil {
		return CommandSession{}, err
	}
	return record, tx.Commit()
}

// PutAutomationPayload stores immutable content. The same reference must always
// resolve to the same bytes; a mismatch is a conflict, never a replacement.
func (s *Store) PutAutomationPayload(ctx context.Context, record AutomationPayload) error {
	if !validCommandID(record.WorkspaceID) || !validCommandID(record.Ref) || len(record.Payload) > MaxAutomationPayloadBytes || record.CreatedAtMS <= 0 {
		return ErrInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var payload, digest []byte
	err = tx.QueryRowContext(ctx, "SELECT payload,payload_sha256 FROM automation_payloads WHERE workspace_id=? AND payload_ref=?", record.WorkspaceID, record.Ref).Scan(&payload, &digest)
	if err == nil {
		if !bytes.Equal(payload, record.Payload) || !bytes.Equal(digest, record.SHA256[:]) {
			return ErrConflict
		}
		return tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO automation_payloads(workspace_id,payload_ref,payload,payload_sha256,created_at_ms) VALUES(?,?,?,?,?)", record.WorkspaceID, record.Ref, record.Payload, record.SHA256[:], record.CreatedAtMS); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) AutomationPayload(ctx context.Context, workspace, ref string) (AutomationPayload, error) {
	if !validCommandID(workspace) || !validCommandID(ref) {
		return AutomationPayload{}, ErrInvalid
	}
	record := AutomationPayload{WorkspaceID: workspace, Ref: ref}
	var digest []byte
	err := s.db.QueryRowContext(ctx, "SELECT payload,payload_sha256,created_at_ms FROM automation_payloads WHERE workspace_id=? AND payload_ref=?", workspace, ref).Scan(&record.Payload, &digest, &record.CreatedAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return AutomationPayload{}, ErrNotFound
	}
	if err != nil {
		return AutomationPayload{}, err
	}
	if len(digest) != 32 {
		return AutomationPayload{}, ErrCorrupt
	}
	copy(record.SHA256[:], digest)
	return record, nil
}

// PutAutomationGrant records the current device epoch and scopes. It refuses to
// move an existing grant to another device or owner.
func (s *Store) PutAutomationGrant(ctx context.Context, record AutomationGrant) error {
	if !hostPattern.MatchString(record.AuthorizationID) || !hostPattern.MatchString(record.PrincipalID) || !hostPattern.MatchString(record.DeviceID) {
		return ErrInvalid
	}
	epoch, err := signed(record.DeviceEpoch)
	if err != nil {
		return err
	}
	if record.DeviceEpoch == 0 || len(record.Scopes) == 0 || len(record.Scopes) > 16384 || record.CreatedAtMS <= 0 || record.UpdatedAtMS <= 0 {
		return ErrInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var device, principal string
	err = tx.QueryRowContext(ctx, "SELECT device_id,principal_id FROM automation_grants WHERE authorization_id=?", record.AuthorizationID).Scan(&device, &principal)
	if err == nil {
		if device != record.DeviceID || principal != record.PrincipalID {
			return ErrConflict
		}
		if _, err = tx.ExecContext(ctx, "UPDATE automation_grants SET device_epoch=?,scopes=?,updated_at_ms=? WHERE authorization_id=?", epoch, record.Scopes, record.UpdatedAtMS, record.AuthorizationID); err != nil {
			return err
		}
		return tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO automation_grants(authorization_id,principal_id,device_id,device_epoch,scopes,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)", record.AuthorizationID, record.PrincipalID, record.DeviceID, epoch, record.Scopes, record.CreatedAtMS, record.UpdatedAtMS); err != nil {
		return err
	}
	return tx.Commit()
}

// AutomationGrant joins the recorded grant with live device state so a dispatch
// check sees revocation and epoch changes without a browser credential.
func (s *Store) AutomationGrant(ctx context.Context, id string) (AutomationGrant, uint64, int64, error) {
	if !hostPattern.MatchString(id) {
		return AutomationGrant{}, 0, 0, ErrInvalid
	}
	var record AutomationGrant
	var epoch, deviceEpoch, revoked int64
	err := s.db.QueryRowContext(ctx, "SELECT g.authorization_id,g.principal_id,g.device_id,g.device_epoch,g.scopes,g.created_at_ms,g.updated_at_ms,d.epoch,d.revoked_at_ms FROM automation_grants g JOIN identity_devices d ON d.device_id=g.device_id WHERE g.authorization_id=?", id).
		Scan(&record.AuthorizationID, &record.PrincipalID, &record.DeviceID, &epoch, &record.Scopes, &record.CreatedAtMS, &record.UpdatedAtMS, &deviceEpoch, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return AutomationGrant{}, 0, 0, ErrNotFound
	}
	if err != nil {
		return AutomationGrant{}, 0, 0, err
	}
	if epoch < 1 || deviceEpoch < 1 || revoked < 0 {
		return AutomationGrant{}, 0, 0, ErrCorrupt
	}
	record.DeviceEpoch = uint64(epoch)
	return record, uint64(deviceEpoch), revoked, nil
}
