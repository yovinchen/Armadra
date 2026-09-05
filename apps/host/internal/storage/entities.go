package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"errors"
	"hash"
	"math"
	"time"
	"unicode/utf8"
)

func textValid(value string, max int, empty bool) bool {
	if (!empty && value == "") || len(value) > max || !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}
func validateKey(key Key) error {
	if !textValid(key.Kind, 128, false) || !textValid(key.ID, 256, false) || !textValid(key.WorkspaceID, 256, true) {
		return ErrInvalid
	}
	return nil
}
func signed(value uint64) (int64, error) {
	if value > math.MaxInt64 {
		return 0, ErrCounterExhausted
	}
	return int64(value), nil
}
func pageSize(limit int) (int, error) {
	if limit == 0 {
		return 100, nil
	}
	if limit < 1 || limit > MaxPageSize {
		return 0, ErrInvalid
	}
	return limit, nil
}
func pageBytes(budget int) (int, error) {
	if budget == 0 {
		return DefaultPageBytes, nil
	}
	if budget < 1 || budget > MaxPageBytes {
		return 0, ErrInvalid
	}
	return budget, nil
}
func entityBytes(entity Entity) int {
	return len(entity.Payload) + len(entity.ID) + len(entity.Kind) + len(entity.WorkspaceID) + 128
}

func writeDigestPart(digest hash.Hash, value []byte) {
	var size [8]byte
	binary.BigEndian.PutUint64(size[:], uint64(len(value)))
	digest.Write(size[:])
	digest.Write(value)
}

// OperationDigest is deterministic over ordered changes and their exact
// Protobuf bytes. Payloads are not decoded or re-encoded by this storage layer.
func OperationDigest(changes []Change) ([32]byte, error) {
	var result [32]byte
	if len(changes) == 0 || len(changes) > MaxChanges {
		return result, ErrInvalid
	}
	seen := map[Key]bool{}
	total := 0
	digest := sha256.New()
	writeDigestPart(digest, []byte("armadra.storage.apply.v1"))
	for _, change := range changes {
		if err := validateKey(change.Key); err != nil {
			return result, err
		}
		if _, err := signed(change.ExpectedRevision); err != nil {
			return result, err
		}
		if seen[change.Key] || len(change.Payload) > MaxPayloadBytes || (change.Delete && (change.ExpectedRevision == 0 || len(change.Payload) != 0)) {
			return result, ErrInvalid
		}
		seen[change.Key] = true
		total += len(change.Payload)
		if total > MaxBatchBytes {
			return result, ErrInvalid
		}
		for _, value := range []string{change.WorkspaceID, change.Kind, change.ID} {
			writeDigestPart(digest, []byte(value))
		}
		var revision [8]byte
		binary.BigEndian.PutUint64(revision[:], change.ExpectedRevision)
		digest.Write(revision[:])
		if change.Delete {
			digest.Write([]byte{1})
		} else {
			digest.Write([]byte{0})
		}
		writeDigestPart(digest, change.Payload)
	}
	copy(result[:], digest.Sum(nil))
	return result, nil
}

type scanner interface{ Scan(...any) error }

func scanEntity(row scanner) (Entity, error) {
	var entity Entity
	var revision int64
	var deleted int
	if err := row.Scan(&entity.WorkspaceID, &entity.Kind, &entity.ID, &revision, &entity.Payload, &deleted); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return entity, ErrNotFound
		}
		return entity, err
	}
	if revision < 1 || (deleted != 0 && deleted != 1) || validateKey(entity.Key) != nil {
		return Entity{}, ErrCorrupt
	}
	entity.Revision = uint64(revision)
	entity.Deleted = deleted == 1
	return entity, nil
}

// Read includes revision tombstones. ErrNotFound means the key never existed.
func (s *Store) Read(ctx context.Context, key Key) (Entity, error) {
	if err := validateKey(key); err != nil {
		return Entity{}, err
	}
	return scanEntity(s.db.QueryRowContext(ctx, "SELECT workspace_id,kind,entity_id,revision,payload,deleted FROM entities WHERE workspace_id=? AND kind=? AND entity_id=?", key.WorkspaceID, key.Kind, key.ID))
}

// WorkspacesOfKind lists the distinct workspaces that hold at least one entity
// of a kind, including workspaces whose only rows are tombstones. A migration
// needs it because the workspace identifiers themselves arrive in the data:
// there is no outer list to read them from before the first projection.
func (s *Store) WorkspacesOfKind(ctx context.Context, kind string) ([]string, error) {
	if !textValid(kind, 128, false) {
		return nil, ErrInvalid
	}
	rows, err := s.db.QueryContext(ctx, "SELECT DISTINCT workspace_id FROM entities WHERE kind=? ORDER BY workspace_id", kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var workspace string
		if err = rows.Scan(&workspace); err != nil {
			return nil, err
		}
		result = append(result, workspace)
	}
	return result, rows.Err()
}

func (s *Store) List(ctx context.Context, options ListOptions) (EntityPage, error) {
	result := EntityPage{Entities: []Entity{}, NextID: options.AfterID}
	if err := validateKey(Key{WorkspaceID: options.WorkspaceID, Kind: options.Kind, ID: "list"}); err != nil {
		return result, err
	}
	if !textValid(options.AfterID, 256, true) {
		return result, ErrInvalid
	}
	limit, err := pageSize(options.Limit)
	if err != nil {
		return result, err
	}
	budget, err := pageBytes(options.ByteBudget)
	if err != nil {
		return result, err
	}
	used := 0
	query := "SELECT workspace_id,kind,entity_id,revision,payload,deleted FROM entities WHERE workspace_id=? AND kind=? AND entity_id>?"
	if !options.IncludeDeleted {
		query += " AND deleted=0"
	}
	query += " ORDER BY entity_id LIMIT ?"
	rows, err := s.db.QueryContext(ctx, query, options.WorkspaceID, options.Kind, options.AfterID, limit+1)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		if len(result.Entities) == limit || (len(result.Entities) > 0 && used >= budget) {
			result.HasMore = true
			break
		}
		entity, err := scanEntity(rows)
		if err != nil {
			return result, err
		}
		size := entityBytes(entity)
		if len(result.Entities) > 0 && used+size > budget {
			result.HasMore = true
			break
		}
		used += size
		result.Entities = append(result.Entities, entity)
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	if len(result.Entities) > limit {
		result.HasMore = true
		result.Entities = result.Entities[:limit]
	}
	if len(result.Entities) > 0 {
		result.NextID = result.Entities[len(result.Entities)-1].ID
	}
	return result, nil
}

// Apply atomically stores entities, receipt and outbox. Operation IDs MUST be
// namespaced by the caller's principal/scope/action, e.g. import/<scope>/<id>.
// This internal idempotency key is not an authorization token.
func (s *Store) Apply(ctx context.Context, operationID string, changes []Change) (ApplyResult, error) {
	var result ApplyResult
	if !textValid(operationID, 512, false) {
		return result, ErrInvalid
	}
	digest, err := OperationDigest(changes)
	if err != nil {
		return result, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	result, found, err := readReceipt(ctx, tx, operationID, digest[:])
	if err != nil {
		return ApplyResult{}, err
	}
	if found {
		result.Replayed = true
		return result, nil
	}
	var last, eventCounter, transactionMax int64
	if err = tx.QueryRowContext(ctx, "SELECT last_sequence FROM store_meta WHERE singleton=1").Scan(&last); err != nil {
		return result, err
	}
	if err = tx.QueryRowContext(ctx, "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='operations'),0)").Scan(&transactionMax); err != nil {
		return result, err
	}
	if err = tx.QueryRowContext(ctx, "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0)").Scan(&eventCounter); err != nil {
		return result, err
	}
	if eventCounter != last {
		return result, ErrCorrupt
	}
	if last < 0 || transactionMax < 0 {
		return result, ErrCorrupt
	}
	if last > math.MaxInt64-int64(len(changes)) || transactionMax == math.MaxInt64 {
		return result, ErrCounterExhausted
	}
	inserted, err := tx.ExecContext(ctx, "INSERT INTO operations(operation_id,request_digest,change_count,committed_at_ms) VALUES(?,?,?,?)", operationID, digest[:], len(changes), time.Now().UnixMilli())
	if err != nil {
		return result, err
	}
	transactionID, err := inserted.LastInsertId()
	if err != nil {
		return result, err
	}
	result = ApplyResult{OperationID: operationID, TransactionID: uint64(transactionID), Revisions: []Revision{}}
	for index, change := range changes {
		var current int64
		err = tx.QueryRowContext(ctx, "SELECT revision FROM entities WHERE workspace_id=? AND kind=? AND entity_id=?", change.WorkspaceID, change.Kind, change.ID).Scan(&current)
		if errors.Is(err, sql.ErrNoRows) {
			current = 0
		} else if err != nil {
			return ApplyResult{}, err
		}
		if current < 0 {
			return ApplyResult{}, ErrCorrupt
		}
		if uint64(current) != change.ExpectedRevision {
			return ApplyResult{}, &RevisionConflict{Key: change.Key, Expected: change.ExpectedRevision, Actual: uint64(current)}
		}
		if current == math.MaxInt64 {
			return ApplyResult{}, ErrCounterExhausted
		}
		next := current + 1
		deleted := 0
		if change.Delete {
			deleted = 1
		}
		if current == 0 {
			_, err = tx.ExecContext(ctx, "INSERT INTO entities(workspace_id,kind,entity_id,revision,payload,deleted) VALUES(?,?,?,?,COALESCE(?,X''),?)", change.WorkspaceID, change.Kind, change.ID, next, change.Payload, deleted)
		} else {
			var updated sql.Result
			updated, err = tx.ExecContext(ctx, "UPDATE entities SET revision=?,payload=COALESCE(?,X''),deleted=? WHERE workspace_id=? AND kind=? AND entity_id=? AND revision=?", next, change.Payload, deleted, change.WorkspaceID, change.Kind, change.ID, current)
			if err == nil {
				var count int64
				count, err = updated.RowsAffected()
				if err == nil && count != 1 {
					return ApplyResult{}, ErrConflict
				}
			}
		}
		if err != nil {
			return ApplyResult{}, err
		}
		event, err := tx.ExecContext(ctx, "INSERT INTO events(transaction_id,operation_id,transaction_index,transaction_size,workspace_id,kind,entity_id,revision,payload,deleted) VALUES(?,?,?,?,?,?,?,?,COALESCE(?,X''),?)", transactionID, operationID, index, len(changes), change.WorkspaceID, change.Kind, change.ID, next, change.Payload, deleted)
		if err != nil {
			return ApplyResult{}, err
		}
		sequence, err := event.LastInsertId()
		if err != nil {
			return ApplyResult{}, err
		}
		if index == 0 {
			result.FirstSequence = uint64(sequence)
		}
		result.LastSequence = uint64(sequence)
		if _, err = tx.ExecContext(ctx, "INSERT INTO operation_changes(operation_id,position,workspace_id,kind,entity_id,revision,deleted) VALUES(?,?,?,?,?,?,?)", operationID, index, change.WorkspaceID, change.Kind, change.ID, next, deleted); err != nil {
			return ApplyResult{}, err
		}
		result.Revisions = append(result.Revisions, Revision{Key: change.Key, Revision: uint64(next), Deleted: change.Delete})
	}
	if _, err = tx.ExecContext(ctx, "UPDATE operations SET first_sequence=?,last_sequence=? WHERE operation_id=?", int64(result.FirstSequence), int64(result.LastSequence), operationID); err != nil {
		return ApplyResult{}, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE store_meta SET last_sequence=? WHERE singleton=1", int64(result.LastSequence)); err != nil {
		return ApplyResult{}, err
	}
	if err = tx.Commit(); err != nil {
		return ApplyResult{}, err
	}
	// Only after the commit: a subscriber woken earlier could read a sequence
	// that a rollback would have taken back.
	s.committed(result.LastSequence)
	return result, nil
}

func readReceipt(ctx context.Context, tx *sql.Tx, operationID string, digest []byte) (ApplyResult, bool, error) {
	var result ApplyResult
	var stored []byte
	var transaction, first, last int64
	var count int
	err := tx.QueryRowContext(ctx, "SELECT request_digest,transaction_id,first_sequence,last_sequence,change_count FROM operations WHERE operation_id=?", operationID).Scan(&stored, &transaction, &first, &last, &count)
	if errors.Is(err, sql.ErrNoRows) {
		return result, false, nil
	}
	if err != nil {
		return result, false, err
	}
	if string(stored) != string(digest) {
		return result, false, ErrIdempotencyConflict
	}
	if transaction < 1 || first < 1 || last < first || count < 1 || count > MaxChanges || last-first+1 != int64(count) {
		return result, false, ErrCorrupt
	}
	result = ApplyResult{OperationID: operationID, TransactionID: uint64(transaction), FirstSequence: uint64(first), LastSequence: uint64(last), Revisions: []Revision{}}
	rows, err := tx.QueryContext(ctx, "SELECT position,workspace_id,kind,entity_id,revision,deleted FROM operation_changes WHERE operation_id=? ORDER BY position", operationID)
	if err != nil {
		return result, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var revision Revision
		var number int64
		var deleted, position int
		if err = rows.Scan(&position, &revision.WorkspaceID, &revision.Kind, &revision.ID, &number, &deleted); err != nil {
			return result, false, err
		}
		if number < 1 || position != len(result.Revisions) || (deleted != 0 && deleted != 1) || validateKey(revision.Key) != nil {
			return result, false, ErrCorrupt
		}
		revision.Revision = uint64(number)
		revision.Deleted = deleted == 1
		result.Revisions = append(result.Revisions, revision)
	}
	if err = rows.Err(); err != nil {
		return result, false, err
	}
	if len(result.Revisions) != count {
		return result, false, ErrCorrupt
	}
	return result, true, nil
}
