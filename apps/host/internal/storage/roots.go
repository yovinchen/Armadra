package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"math"
)

// The filesystem domain's registration table (Go Host 业务所有权迁移 §3.1 v7).
//
// A root registration is a small record with a large consequence: it is what
// says which directory on which machine a workspace's files are, and which of
// read, write and execute a client may ask for. So it is stored under the same
// two rules the entity table uses, for the same reasons:
//
//   - **Revision CAS.** A change names the revision it read. A second writer
//     that decided against an older one is refused rather than applied, which
//     is what stops two clients from pointing one workspace at two directories.
//   - **A tombstone, not a delete.** Unregistering keeps the row with `deleted`
//     set and the revision intact, so a re-registration has to name it. A row
//     that simply vanished would let a delayed request re-register the
//     workspace from revision zero, under a decision about a directory that is
//     no longer the one being registered.
//
// Every change publishes an event on the Host's own durable sequence inside the
// same transaction (`openOperation`/`appendChange`/`closeOperation` in
// entities.go). That is the whole reason the write goes through this package
// rather than through a service holding a `*sql.DB`: a permission change that
// reached the table but not the outbox would leave every connected client
// showing access the Host has already revoked.

// RootKind is the stored event kind for a workspace root. It is the domain's
// name and the entity's, joined the way §3.1 spells it, and it is what the
// event stream's filesystem projector claims.
const RootKind = "filesystem.root"

// WorkspaceRoot is one registration. `Payload` is the encoded entity as it is
// published on the event stream; like every other payload in this package it
// is opaque bytes, and by the same convention as the entity table it carries
// `revision = 0` — the row is where a revision comes from.
type WorkspaceRoot struct {
	WorkspaceID     string
	ExecutionHostID string
	CanonicalPath   string
	ProofSHA256     []byte
	Read            bool
	Write           bool
	Execute         bool
	Deleted         bool
	Revision        uint64
	RegisteredAtMS  int64
	UpdatedAtMS     int64
	Payload         []byte
}

func validateRoot(root WorkspaceRoot) error {
	if !textValid(root.WorkspaceID, 256, false) || !textValid(root.ExecutionHostID, 256, true) ||
		!textValid(root.CanonicalPath, 4096, true) || len(root.Payload) > MaxPayloadBytes ||
		(len(root.ProofSHA256) != 0 && len(root.ProofSHA256) != 32) {
		return ErrInvalid
	}
	// A live registration names a directory; a tombstone does not, and must not
	// keep one either — a tombstone that still carried a path would read like a
	// workspace whose root is merely hidden.
	if root.Deleted != (root.CanonicalPath == "") {
		return ErrInvalid
	}
	if root.Deleted && (root.Read || root.Write || root.Execute || root.ExecutionHostID != "" || len(root.ProofSHA256) != 0) {
		return ErrInvalid
	}
	if root.RegisteredAtMS <= 0 || root.UpdatedAtMS <= 0 {
		return ErrInvalid
	}
	return nil
}

// rootFingerprint is the request as the idempotency digest sees it: the columns
// that say something about the workspace, length-prefixed so two fields cannot
// run together.
//
// The published payload is deliberately not part of it. The payload is derived
// from these columns plus the moment the request arrived, so hashing it would
// make every retry a different request — which is exactly the case idempotency
// exists to make harmless. Two requests that say the same thing about a
// workspace are the same request, whatever second they were sent in.
//
// A withdrawal fingerprints as nothing, because a withdrawal *is* nothing but
// the key and the revision it names — and because a deletion carrying content
// is a shape the digest refuses outright.
func rootFingerprint(root WorkspaceRoot) []byte {
	if root.Deleted {
		return nil
	}
	digest := sha256.New()
	writeDigestPart(digest, []byte("armadra.storage.workspace_root.v1"))
	for _, value := range []string{root.ExecutionHostID, root.CanonicalPath} {
		writeDigestPart(digest, []byte(value))
	}
	writeDigestPart(digest, root.ProofSHA256)
	digest.Write([]byte{byte(boolean(root.Read)), byte(boolean(root.Write)), byte(boolean(root.Execute))})
	return digest.Sum(nil)
}

func boolean(value bool) int {
	if value {
		return 1
	}
	return 0
}

func scanRoot(row scanner) (WorkspaceRoot, error) {
	var root WorkspaceRoot
	var revision int64
	var read, write, execute, deleted int
	err := row.Scan(&root.WorkspaceID, &root.ExecutionHostID, &root.CanonicalPath, &root.ProofSHA256,
		&read, &write, &execute, &deleted, &revision, &root.RegisteredAtMS, &root.UpdatedAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return root, ErrNotFound
	}
	if err != nil {
		return root, err
	}
	if revision < 1 {
		return WorkspaceRoot{}, ErrCorrupt
	}
	root.Read, root.Write, root.Execute, root.Deleted = read == 1, write == 1, execute == 1, deleted == 1
	root.Revision = uint64(revision)
	if validateRoot(root) != nil {
		return WorkspaceRoot{}, ErrCorrupt
	}
	return root, nil
}

const rootColumns = "workspace_id,execution_host_id,canonical_path,proof_sha256,can_read,can_write,can_execute,deleted,revision,registered_at_ms,updated_at_ms"

// GetWorkspaceRoot reads one registration, tombstones included. ErrNotFound
// means the workspace was never registered, which is a different answer from a
// registration that was withdrawn: the second one still has a revision the
// caller has to name.
func (s *Store) GetWorkspaceRoot(ctx context.Context, workspaceID string) (WorkspaceRoot, error) {
	if !textValid(workspaceID, 256, false) {
		return WorkspaceRoot{}, ErrInvalid
	}
	return scanRoot(s.db.QueryRowContext(ctx, "SELECT "+rootColumns+" FROM workspace_roots WHERE workspace_id=?", workspaceID))
}

// ListWorkspaceRoots pages live registrations by workspace id. Tombstones are
// left out: a caller listing roots is asking which workspaces have one, and a
// withdrawn registration is not one of them.
func (s *Store) ListWorkspaceRoots(ctx context.Context, after string, limit int) ([]WorkspaceRoot, bool, error) {
	if !textValid(after, 256, true) {
		return nil, false, ErrInvalid
	}
	size, err := pageSize(limit)
	if err != nil {
		return nil, false, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+rootColumns+" FROM workspace_roots WHERE workspace_id>? AND deleted=0 ORDER BY workspace_id LIMIT ?", after, size+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	roots := []WorkspaceRoot{}
	for rows.Next() {
		root, err := scanRoot(rows)
		if err != nil {
			return nil, false, err
		}
		roots = append(roots, root)
	}
	if err = rows.Err(); err != nil {
		return nil, false, err
	}
	if len(roots) > size {
		return roots[:size], true, nil
	}
	return roots, false, nil
}

// PutWorkspaceRoot stores one registration under revision CAS and publishes it.
//
// `expected` is the revision the caller read; 0 means "this workspace has never
// been registered". The receipt is the same shape every other change produces,
// so an interrupted request replays instead of registering a second time.
func (s *Store) PutWorkspaceRoot(ctx context.Context, operationID string, root WorkspaceRoot, expected uint64) (ApplyResult, error) {
	var result ApplyResult
	if !textValid(operationID, 512, false) {
		return result, ErrInvalid
	}
	if err := validateRoot(root); err != nil {
		return result, err
	}
	if _, err := signed(expected); err != nil {
		return result, err
	}
	// The digest covers the stored columns, not only the published payload.
	// Two registrations of the same workspace under one operation id differ in
	// the directory they name, and a digest that only saw the payload would
	// call the second one a retry of the first.
	digest, err := OperationDigest([]Change{{
		Key:              Key{Kind: RootKind, ID: root.WorkspaceID, WorkspaceID: root.WorkspaceID},
		ExpectedRevision: expected,
		Payload:          rootFingerprint(root),
		Delete:           root.Deleted,
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
	var registered int64
	err = tx.QueryRowContext(ctx, "SELECT revision,registered_at_ms FROM workspace_roots WHERE workspace_id=?", root.WorkspaceID).Scan(&current, &registered)
	if errors.Is(err, sql.ErrNoRows) {
		current, registered = 0, root.RegisteredAtMS
	} else if err != nil {
		return ApplyResult{}, err
	}
	if current < 0 {
		return ApplyResult{}, ErrCorrupt
	}
	if uint64(current) != expected {
		return ApplyResult{}, &RevisionConflict{Key: Key{Kind: RootKind, ID: root.WorkspaceID, WorkspaceID: root.WorkspaceID}, Expected: expected, Actual: uint64(current)}
	}
	if current == math.MaxInt64 {
		return ApplyResult{}, ErrCounterExhausted
	}
	next := current + 1
	// Registration time belongs to the first registration and is never
	// rewritten: it is what says how long this workspace has pointed at this
	// directory, and a permission change is not a new registration.
	if current == 0 {
		_, err = tx.ExecContext(ctx, "INSERT INTO workspace_roots("+rootColumns+") VALUES(?,?,?,COALESCE(?,X''),?,?,?,?,?,?,?)",
			root.WorkspaceID, root.ExecutionHostID, root.CanonicalPath, root.ProofSHA256,
			boolean(root.Read), boolean(root.Write), boolean(root.Execute), boolean(root.Deleted),
			next, registered, root.UpdatedAtMS)
	} else {
		var updated sql.Result
		updated, err = tx.ExecContext(ctx, "UPDATE workspace_roots SET execution_host_id=?,canonical_path=?,proof_sha256=COALESCE(?,X''),can_read=?,can_write=?,can_execute=?,deleted=?,revision=?,updated_at_ms=? WHERE workspace_id=? AND revision=?",
			root.ExecutionHostID, root.CanonicalPath, root.ProofSHA256,
			boolean(root.Read), boolean(root.Write), boolean(root.Execute), boolean(root.Deleted),
			next, root.UpdatedAtMS, root.WorkspaceID, current)
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
		Key:      Key{Kind: RootKind, ID: root.WorkspaceID, WorkspaceID: root.WorkspaceID},
		Revision: uint64(next),
		Deleted:  root.Deleted,
	}
	if err = appendChange(ctx, tx, &result, transactionID, 0, 1, revision, root.Payload); err != nil {
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
