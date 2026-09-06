package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"math"
	"strconv"
)

// The session domain's tables (Go Host 业务所有权迁移 §3.1 v8).
//
// A session record is the answer to "should this process exist, and what was
// the last thing anybody saw it do". It is stored under the same two rules the
// entity table uses, and for the same reasons:
//
//   - **Revision CAS.** A change names the revision it read. Two clients that
//     both decided to start a session for one node produce one start and one
//     refusal, rather than two programs in one pane.
//   - **A tombstone, not a delete.** Closing keeps the row with `deleted` set
//     and the revision intact, so re-creating a session under the same logical
//     key has to name it. A row that simply vanished would let a delayed mount
//     re-create the session from revision zero, under a decision about a
//     session that has since been replaced.
//
// Every change publishes an event on the Host's durable sequence inside the
// same transaction. That is the whole reason a write goes through this package:
// a session that reached the table but not the outbox would leave every
// connected client offering to start a program that is already running.
//
// The run table is separate and is *not* CAS'd against a client. A run is the
// Worker's report about a process it created; there is no second writer to race
// with, and the identity is (session, generation), so the same run reported
// twice is the same row.

const (
	// SessionKind is the stored event kind for a session's intent, and
	// SessionRunKind for one generation of it. They are separate kinds because
	// they change for different reasons: a client that only tracks lifecycle
	// must not have to decode a backend reference to learn nothing moved.
	SessionKind    = "session.session"
	SessionRunKind = "session.run"
)

// Session is one session's intent as the Host stores it. `Payload` is the
// encoded entity as it is published on the stream; like every other payload
// here it carries `revision = 0`, because the row is where a revision comes
// from and two copies could drift.
type Session struct {
	SessionID       string
	WorkspaceID     string
	ExecutionHostID string
	SessionKey      string
	OwnerNodeID     string
	Kind            int32
	Status          int32
	AttachState     int32
	Intent          int32
	BackendKind     string
	Generation      uint64
	ExitCode        *int32
	// Launch is the frozen definition, encoded. It is opaque here: what a
	// launch means belongs to the domain service, and decoding it to store it
	// would put a Protobuf parse inside the transaction.
	Launch       []byte
	LaunchSHA256 []byte
	ReasonCode   string
	Deleted      bool
	Revision     uint64
	CreatedAtMS  int64
	UpdatedAtMS  int64
	EndedAtMS    int64
	LastOutputMS int64
	Payload      []byte
}

// SessionRun is one generation of one session.
type SessionRun struct {
	SessionID        string
	Generation       uint64
	WorkerInstanceID string
	BackendRef       string
	ExitCode         *int32
	ReasonCode       string
	Revision         uint64
	StartedAtMS      int64
	EndedAtMS        int64
	Payload          []byte
}

// SessionClaim records which Worker instance last spoke for an execution host.
// It is what makes EXITED and LOST decidable: a session whose claim belongs to
// a Worker that is gone was not observed to end.
type SessionClaim struct {
	ExecutionHostID  string
	WorkerInstanceID string
	ClaimedAtMS      int64
}

func validateSession(session Session) error {
	if !textValid(session.SessionID, 256, false) || !textValid(session.WorkspaceID, 256, false) ||
		!textValid(session.ExecutionHostID, 256, true) || !textValid(session.SessionKey, 256, false) ||
		!textValid(session.OwnerNodeID, 256, true) || !textValid(session.BackendKind, 64, true) ||
		!textValid(session.ReasonCode, 64, true) || len(session.Payload) > MaxPayloadBytes ||
		len(session.Launch) > MaxPayloadBytes ||
		(len(session.LaunchSHA256) != 0 && len(session.LaunchSHA256) != 32) {
		return ErrInvalid
	}
	if session.Kind < 0 || session.Kind > 3 || session.Status < 0 || session.Status > 6 ||
		session.AttachState < 0 || session.AttachState > 3 || session.Intent < 0 || session.Intent > 4 {
		return ErrInvalid
	}
	if session.CreatedAtMS <= 0 || session.UpdatedAtMS <= 0 || session.EndedAtMS < 0 || session.LastOutputMS < 0 {
		return ErrInvalid
	}
	// A tombstone is the withdrawal of an intent, so it carries no intent: a
	// closed session that still named a launch and a generation would read like
	// a session that is merely hidden, which is the one thing it is not.
	if session.Deleted && (len(session.Launch) != 0 || session.Generation != 0 || session.BackendKind != "" || session.ExitCode != nil) {
		return ErrInvalid
	}
	if _, err := signed(session.Generation); err != nil {
		return err
	}
	return nil
}

func validateRun(run SessionRun) error {
	if !textValid(run.SessionID, 256, false) || !textValid(run.WorkerInstanceID, 256, true) ||
		!textValid(run.BackendRef, 1024, true) || !textValid(run.ReasonCode, 64, true) ||
		len(run.Payload) > MaxPayloadBytes {
		return ErrInvalid
	}
	if run.Generation == 0 || run.StartedAtMS <= 0 || run.EndedAtMS < 0 {
		return ErrInvalid
	}
	_, err := signed(run.Generation)
	return err
}

// sessionFingerprint is the request as the idempotency digest sees it: the
// columns that say something about the session, length-prefixed so two fields
// cannot run together.
//
// The published payload is deliberately excluded, exactly as it is for a
// workspace root: the payload is derived from these columns plus the moment the
// request arrived, so hashing it would make every retry a different request —
// which is the case idempotency exists to make harmless.
//
// A withdrawal fingerprints as nothing, because a withdrawal *is* nothing but
// the key and the revision it names.
func sessionFingerprint(session Session) []byte {
	if session.Deleted {
		return nil
	}
	digest := sha256.New()
	writeDigestPart(digest, []byte("armadra.storage.session.v1"))
	for _, value := range []string{
		session.WorkspaceID, session.ExecutionHostID, session.SessionKey,
		session.OwnerNodeID, session.BackendKind, session.ReasonCode,
	} {
		writeDigestPart(digest, []byte(value))
	}
	writeDigestPart(digest, session.LaunchSHA256)
	var numbers [8]byte
	for _, value := range []int32{session.Kind, session.Status, session.AttachState, session.Intent} {
		numbers[0] = byte(value)
		digest.Write(numbers[:1])
	}
	writeDigestPart(digest, []byte(exitText(session.ExitCode)))
	return digest.Sum(nil)
}

// exitText spells an optional exit code so that "exited with 0" and "nobody saw
// it end" hash differently. A missing code is not zero, and a client acts
// differently on each.
func exitText(code *int32) string {
	if code == nil {
		return "absent"
	}
	return "code:" + strconv.FormatInt(int64(*code), 10)
}

const sessionColumns = "session_id,workspace_id,execution_host_id,session_key,owner_node_id,kind,status,attach_state,termination_intent,backend_kind,generation,exit_code,launch,launch_sha256,reason_code,deleted,revision,created_at_ms,updated_at_ms,ended_at_ms,last_output_at_ms"

func scanSession(row scanner) (Session, error) {
	var session Session
	var revision, generation int64
	var deleted int
	var exit sql.NullInt64
	err := row.Scan(&session.SessionID, &session.WorkspaceID, &session.ExecutionHostID,
		&session.SessionKey, &session.OwnerNodeID, &session.Kind, &session.Status,
		&session.AttachState, &session.Intent, &session.BackendKind, &generation, &exit,
		&session.Launch, &session.LaunchSHA256, &session.ReasonCode, &deleted, &revision,
		&session.CreatedAtMS, &session.UpdatedAtMS, &session.EndedAtMS, &session.LastOutputMS)
	if errors.Is(err, sql.ErrNoRows) {
		return session, ErrNotFound
	}
	if err != nil {
		return session, err
	}
	if revision < 1 || generation < 0 {
		return Session{}, ErrCorrupt
	}
	session.Revision, session.Generation, session.Deleted = uint64(revision), uint64(generation), deleted == 1
	if exit.Valid {
		code := int32(exit.Int64)
		session.ExitCode = &code
	}
	if validateSession(session) != nil {
		return Session{}, ErrCorrupt
	}
	return session, nil
}

// GetSession reads one session, tombstones included. ErrNotFound means no
// session with that identifier was ever recorded, which is a different answer
// from a closed one: the second still has a revision a caller has to name.
func (s *Store) GetSession(ctx context.Context, sessionID string) (Session, error) {
	if !textValid(sessionID, 256, false) {
		return Session{}, ErrInvalid
	}
	return scanSession(s.db.QueryRowContext(ctx, "SELECT "+sessionColumns+" FROM sessions WHERE session_id=?", sessionID))
}

// GetSessionByKey reads the live session for a logical key.
//
// The key survives recycles, which is exactly why the lookup exists: a client
// mounting a node asks "is there already a session for this node", and the
// answer must not change because the pane was recycled while it was away.
// Tombstones are excluded — a closed session is not one to attach to — and the
// newest generation wins when a key somehow has more than one row.
func (s *Store) GetSessionByKey(ctx context.Context, sessionKey string) (Session, error) {
	if !textValid(sessionKey, 256, false) {
		return Session{}, ErrInvalid
	}
	return scanSession(s.db.QueryRowContext(ctx,
		"SELECT "+sessionColumns+" FROM sessions WHERE session_key=? AND deleted=0 ORDER BY generation DESC, created_at_ms DESC LIMIT 1", sessionKey))
}

// ListSessions pages one workspace's live sessions by identifier. Tombstones
// are left out: a caller listing sessions is asking which ones exist.
func (s *Store) ListSessions(ctx context.Context, workspaceID, after string, limit int) ([]Session, bool, error) {
	if !textValid(workspaceID, 256, false) || !textValid(after, 256, true) {
		return nil, false, ErrInvalid
	}
	size, err := pageSize(limit)
	if err != nil {
		return nil, false, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+sessionColumns+" FROM sessions WHERE workspace_id=? AND session_id>? AND deleted=0 ORDER BY session_id LIMIT ?", workspaceID, after, size+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	sessions := []Session{}
	for rows.Next() {
		session, err := scanSession(rows)
		if err != nil {
			return nil, false, err
		}
		sessions = append(sessions, session)
	}
	if err = rows.Err(); err != nil {
		return nil, false, err
	}
	if len(sessions) > size {
		return sessions[:size], true, nil
	}
	return sessions, false, nil
}

// AllSessions reads every session this Host holds, tombstones included, in
// identifier order. It is what a reverse export walks, and it is complete on
// purpose: a partial package would be a rollback that quietly dropped a
// session the Runtime would then never reclaim.
func (s *Store) AllSessions(ctx context.Context) ([]Session, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+sessionColumns+" FROM sessions ORDER BY session_id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sessions := []Session{}
	for rows.Next() {
		session, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
	}
	return sessions, rows.Err()
}

// PutSession stores one session under revision CAS and publishes it.
//
// `expected` is the revision the caller read; 0 means "this session has never
// been recorded". The receipt is the shape every other change produces, so an
// interrupted request replays instead of recording a second session.
func (s *Store) PutSession(ctx context.Context, operationID string, session Session, expected uint64) (ApplyResult, error) {
	var result ApplyResult
	if !textValid(operationID, 512, false) {
		return result, ErrInvalid
	}
	if err := validateSession(session); err != nil {
		return result, err
	}
	if _, err := signed(expected); err != nil {
		return result, err
	}
	digest, err := OperationDigest([]Change{{
		Key:              Key{Kind: SessionKind, ID: session.SessionID, WorkspaceID: session.WorkspaceID},
		ExpectedRevision: expected,
		Payload:          sessionFingerprint(session),
		Delete:           session.Deleted,
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
	var current, created int64
	err = tx.QueryRowContext(ctx, "SELECT revision,created_at_ms FROM sessions WHERE session_id=?", session.SessionID).Scan(&current, &created)
	if errors.Is(err, sql.ErrNoRows) {
		current, created = 0, session.CreatedAtMS
	} else if err != nil {
		return ApplyResult{}, err
	}
	if current < 0 {
		return ApplyResult{}, ErrCorrupt
	}
	if uint64(current) != expected {
		return ApplyResult{}, &RevisionConflict{Key: Key{Kind: SessionKind, ID: session.SessionID, WorkspaceID: session.WorkspaceID}, Expected: expected, Actual: uint64(current)}
	}
	if current == math.MaxInt64 {
		return ApplyResult{}, ErrCounterExhausted
	}
	next := current + 1
	generation, err := signed(session.Generation)
	if err != nil {
		return ApplyResult{}, err
	}
	exit := sql.NullInt64{}
	if session.ExitCode != nil {
		exit = sql.NullInt64{Int64: int64(*session.ExitCode), Valid: true}
	}
	// Creation time belongs to the first record and is never rewritten: it says
	// how long this node has had a session, and a recycle is not a new session.
	if current == 0 {
		_, err = tx.ExecContext(ctx, "INSERT INTO sessions("+sessionColumns+") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,X''),COALESCE(?,X''),?,?,?,?,?,?,?)",
			session.SessionID, session.WorkspaceID, session.ExecutionHostID, session.SessionKey,
			session.OwnerNodeID, session.Kind, session.Status, session.AttachState, session.Intent,
			session.BackendKind, generation, exit, session.Launch, session.LaunchSHA256,
			session.ReasonCode, boolean(session.Deleted), next, created, session.UpdatedAtMS,
			session.EndedAtMS, session.LastOutputMS)
	} else {
		var updated sql.Result
		updated, err = tx.ExecContext(ctx, "UPDATE sessions SET workspace_id=?,execution_host_id=?,session_key=?,owner_node_id=?,kind=?,status=?,attach_state=?,termination_intent=?,backend_kind=?,generation=?,exit_code=?,launch=COALESCE(?,X''),launch_sha256=COALESCE(?,X''),reason_code=?,deleted=?,revision=?,updated_at_ms=?,ended_at_ms=?,last_output_at_ms=? WHERE session_id=? AND revision=?",
			session.WorkspaceID, session.ExecutionHostID, session.SessionKey, session.OwnerNodeID,
			session.Kind, session.Status, session.AttachState, session.Intent, session.BackendKind,
			generation, exit, session.Launch, session.LaunchSHA256, session.ReasonCode,
			boolean(session.Deleted), next, session.UpdatedAtMS, session.EndedAtMS,
			session.LastOutputMS, session.SessionID, current)
		if err == nil {
			var count int64
			if count, err = updated.RowsAffected(); err == nil && count != 1 {
				return ApplyResult{}, ErrConflict
			}
		}
	}
	if err != nil {
		return ApplyResult{}, err
	}
	revision := Revision{
		Key:      Key{Kind: SessionKind, ID: session.SessionID, WorkspaceID: session.WorkspaceID},
		Revision: uint64(next),
		Deleted:  session.Deleted,
	}
	if err = appendChange(ctx, tx, &result, transactionID, 0, 1, revision, session.Payload); err != nil {
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

const runColumns = "session_id,generation,worker_instance_id,backend_ref,exit_code,reason_code,revision,started_at_ms,ended_at_ms"

func scanRun(row scanner) (SessionRun, error) {
	var run SessionRun
	var revision, generation int64
	var exit sql.NullInt64
	err := row.Scan(&run.SessionID, &generation, &run.WorkerInstanceID, &run.BackendRef,
		&exit, &run.ReasonCode, &revision, &run.StartedAtMS, &run.EndedAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return run, ErrNotFound
	}
	if err != nil {
		return run, err
	}
	if revision < 1 || generation < 1 {
		return SessionRun{}, ErrCorrupt
	}
	run.Revision, run.Generation = uint64(revision), uint64(generation)
	if exit.Valid {
		code := int32(exit.Int64)
		run.ExitCode = &code
	}
	if validateRun(run) != nil {
		return SessionRun{}, ErrCorrupt
	}
	return run, nil
}

// GetSessionRun reads one generation of one session.
func (s *Store) GetSessionRun(ctx context.Context, sessionID string, generation uint64) (SessionRun, error) {
	stored, err := signed(generation)
	if err != nil || !textValid(sessionID, 256, false) || generation == 0 {
		return SessionRun{}, ErrInvalid
	}
	return scanRun(s.db.QueryRowContext(ctx, "SELECT "+runColumns+" FROM session_runs WHERE session_id=? AND generation=?", sessionID, stored))
}

// SessionRuns reads one session's runs, oldest generation first. It is the run
// history §2.6 promises, and it is what a reverse export carries beside the
// session so a restored row's generation is accounted for.
func (s *Store) SessionRuns(ctx context.Context, sessionID string) ([]SessionRun, error) {
	if !textValid(sessionID, 256, false) {
		return nil, ErrInvalid
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+runColumns+" FROM session_runs WHERE session_id=? ORDER BY generation", sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := []SessionRun{}
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

// PutSessionRun records one generation of one session and publishes it.
//
// There is no revision CAS against a caller here, and that is deliberate: a run
// is the Worker's report about a process it created, so there is no second
// writer to race with. The identity is (session, generation), which means the
// same run reported twice is the same row and a run under a new generation is a
// new one — which is exactly what a reclaim needs to be able to say.
func (s *Store) PutSessionRun(ctx context.Context, operationID string, run SessionRun) (ApplyResult, error) {
	var result ApplyResult
	if !textValid(operationID, 512, false) {
		return result, ErrInvalid
	}
	if err := validateRun(run); err != nil {
		return result, err
	}
	generation, err := signed(run.Generation)
	if err != nil {
		return result, err
	}
	digest, err := OperationDigest([]Change{{
		Key:     Key{Kind: SessionRunKind, ID: run.SessionID + "/" + strconv.FormatInt(generation, 10), WorkspaceID: ""},
		Payload: runFingerprint(run),
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
	err = tx.QueryRowContext(ctx, "SELECT revision FROM session_runs WHERE session_id=? AND generation=?", run.SessionID, generation).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		current = 0
	} else if err != nil {
		return ApplyResult{}, err
	}
	if current < 0 {
		return ApplyResult{}, ErrCorrupt
	}
	if current == math.MaxInt64 {
		return ApplyResult{}, ErrCounterExhausted
	}
	next := current + 1
	exit := sql.NullInt64{}
	if run.ExitCode != nil {
		exit = sql.NullInt64{Int64: int64(*run.ExitCode), Valid: true}
	}
	if current == 0 {
		_, err = tx.ExecContext(ctx, "INSERT INTO session_runs("+runColumns+") VALUES(?,?,?,?,?,?,?,?,?)",
			run.SessionID, generation, run.WorkerInstanceID, run.BackendRef, exit,
			run.ReasonCode, next, run.StartedAtMS, run.EndedAtMS)
	} else {
		_, err = tx.ExecContext(ctx, "UPDATE session_runs SET worker_instance_id=?,backend_ref=?,exit_code=?,reason_code=?,revision=?,ended_at_ms=? WHERE session_id=? AND generation=?",
			run.WorkerInstanceID, run.BackendRef, exit, run.ReasonCode, next, run.EndedAtMS, run.SessionID, generation)
	}
	if err != nil {
		return ApplyResult{}, err
	}
	revision := Revision{
		Key:      Key{Kind: SessionRunKind, ID: run.SessionID + "/" + strconv.FormatInt(generation, 10)},
		Revision: uint64(next),
	}
	if err = appendChange(ctx, tx, &result, transactionID, 0, 1, revision, run.Payload); err != nil {
		return ApplyResult{}, err
	}
	if err = closeOperation(ctx, tx, result); err != nil {
		return ApplyResult{}, err
	}
	if err = tx.Commit(); err != nil {
		return ApplyResult{}, err
	}
	s.committed(result.LastSequence)
	return result, nil
}

func runFingerprint(run SessionRun) []byte {
	digest := sha256.New()
	writeDigestPart(digest, []byte("armadra.storage.session_run.v1"))
	for _, value := range []string{run.WorkerInstanceID, run.BackendRef, run.ReasonCode, exitText(run.ExitCode)} {
		writeDigestPart(digest, []byte(value))
	}
	return digest.Sum(nil)
}

// PutSessionClaim records which Worker instance currently speaks for an
// execution host. It publishes nothing: a claim is a fact about which process
// is answering, not a business change a client renders, and putting it on the
// stream would wake every subscriber on every Worker restart.
func (s *Store) PutSessionClaim(ctx context.Context, claim SessionClaim) error {
	if !textValid(claim.ExecutionHostID, 256, true) || !textValid(claim.WorkerInstanceID, 256, false) || claim.ClaimedAtMS <= 0 {
		return ErrInvalid
	}
	_, err := s.db.ExecContext(ctx, "INSERT INTO session_claims(execution_host_id,worker_instance_id,claimed_at_ms) VALUES(?,?,?) ON CONFLICT(execution_host_id) DO UPDATE SET worker_instance_id=excluded.worker_instance_id,claimed_at_ms=excluded.claimed_at_ms",
		claim.ExecutionHostID, claim.WorkerInstanceID, claim.ClaimedAtMS)
	return err
}

// SessionClaimOf reads the current claim for an execution host. ErrNotFound
// means nothing has ever claimed it, which is why a session there is LOST
// rather than EXITED: nobody has been in a position to watch it end.
func (s *Store) SessionClaimOf(ctx context.Context, executionHostID string) (SessionClaim, error) {
	if !textValid(executionHostID, 256, true) {
		return SessionClaim{}, ErrInvalid
	}
	claim := SessionClaim{ExecutionHostID: executionHostID}
	err := s.db.QueryRowContext(ctx, "SELECT worker_instance_id,claimed_at_ms FROM session_claims WHERE execution_host_id=?", executionHostID).
		Scan(&claim.WorkerInstanceID, &claim.ClaimedAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionClaim{}, ErrNotFound
	}
	return claim, err
}
