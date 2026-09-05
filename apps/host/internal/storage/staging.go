package storage

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"strings"
)

func validateStaging(record Staging) error {
	if !textValid(record.ID, 256, false) || !textValid(record.OwnerID, 256, false) || !textValid(record.Purpose, 128, false) || !textValid(record.WorkspaceID, 256, true) || record.Active || record.LeaseUntilMS <= 0 || len(record.Metadata) > MaxPayloadBytes {
		return ErrInvalid
	}
	path := record.RelativePath
	if !textValid(path, 4096, false) || strings.HasPrefix(path, "/") || strings.Contains(path, "\\") || strings.Contains(strings.Split(path, "/")[0], ":") {
		return ErrInvalid
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return ErrInvalid
		}
	}
	return nil
}

func scanStaging(row scanner) (Staging, error) {
	var record Staging
	var revision int64
	var active int
	err := row.Scan(&record.ID, &record.OwnerID, &record.WorkspaceID, &record.Purpose, &record.RelativePath, &revision, &record.LeaseUntilMS, &record.Metadata, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return record, ErrNotFound
	}
	if err != nil {
		return record, err
	}
	if revision < 1 || active != 0 {
		return record, ErrCorrupt
	}
	record.Revision = uint64(revision)
	if validateStaging(record) != nil {
		return Staging{}, ErrCorrupt
	}
	return record, nil
}

func (s *Store) GetStaging(ctx context.Context, id string) (Staging, error) {
	if !textValid(id, 256, false) {
		return Staging{}, ErrInvalid
	}
	return scanStaging(s.db.QueryRowContext(ctx, "SELECT staging_id,owner_id,workspace_id,purpose,relative_path,revision,lease_until_ms,metadata,active FROM staging WHERE staging_id=?", id))
}

// PutStaging creates with expectedOwner="", expectedRevision=0, or updates with
// an explicit owner+revision CAS. Transferring to a new OwnerID uses the same CAS;
// expired leases are never silently stolen. IDs remain reserved after release.
// This function activates nothing.
func (s *Store) PutStaging(ctx context.Context, record Staging, expectedOwner string, expectedRevision uint64) (Staging, error) {
	if err := validateStaging(record); err != nil {
		return Staging{}, err
	}
	expected, err := signed(expectedRevision)
	if err != nil {
		return Staging{}, err
	}
	if expected == 0 && expectedOwner != "" {
		return Staging{}, ErrInvalid
	}
	if expected > 0 && !textValid(expectedOwner, 256, false) {
		return Staging{}, ErrInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Staging{}, err
	}
	defer tx.Rollback()
	var current int64
	var owner string
	err = tx.QueryRowContext(ctx, "SELECT owner_id,revision FROM staging WHERE staging_id=?", record.ID).Scan(&owner, &current)
	if errors.Is(err, sql.ErrNoRows) {
		current = 0
	} else if err != nil {
		return Staging{}, err
	}
	if current != expected {
		return Staging{}, ErrConflict
	}
	if current > 0 && owner != expectedOwner {
		return Staging{}, ErrOwnership
	}
	if current == math.MaxInt64 {
		return Staging{}, ErrCounterExhausted
	}
	if current < 0 {
		return Staging{}, ErrCorrupt
	}
	next := current + 1
	if current == 0 {
		// Released staging IDs are never reused, so a delayed cleanup with an
		// old owner/revision cannot act on a new resource (ownership ABA).
		var used int
		err = tx.QueryRowContext(ctx, "SELECT count(*) FROM staging_ids WHERE staging_id=?", record.ID).Scan(&used)
		if err != nil {
			return Staging{}, err
		}
		if used != 0 {
			return Staging{}, ErrConflict
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO staging_ids(staging_id) VALUES(?)", record.ID); err != nil {
			return Staging{}, err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO staging(staging_id,owner_id,workspace_id,purpose,relative_path,revision,lease_until_ms,metadata) VALUES(?,?,?,?,?,?,?,COALESCE(?,X''))", record.ID, record.OwnerID, record.WorkspaceID, record.Purpose, record.RelativePath, next, record.LeaseUntilMS, record.Metadata)
	} else {
		_, err = tx.ExecContext(ctx, "UPDATE staging SET owner_id=?,workspace_id=?,purpose=?,relative_path=?,revision=?,lease_until_ms=?,metadata=COALESCE(?,X'') WHERE staging_id=? AND owner_id=? AND revision=?", record.OwnerID, record.WorkspaceID, record.Purpose, record.RelativePath, next, record.LeaseUntilMS, record.Metadata, record.ID, expectedOwner, current)
	}
	if err != nil {
		return Staging{}, err
	}
	if err = tx.Commit(); err != nil {
		return Staging{}, err
	}
	record.Revision = uint64(next)
	record.Metadata = append([]byte(nil), record.Metadata...)
	return record, nil
}

func (s *Store) DeleteStaging(ctx context.Context, id, owner string, expectedRevision uint64) error {
	if !textValid(id, 256, false) || !textValid(owner, 256, false) || expectedRevision == 0 {
		return ErrInvalid
	}
	revision, err := signed(expectedRevision)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var current int64
	var actualOwner string
	err = tx.QueryRowContext(ctx, "SELECT owner_id,revision FROM staging WHERE staging_id=?", id).Scan(&actualOwner, &current)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if actualOwner != owner {
		return ErrOwnership
	}
	if current != revision {
		return ErrConflict
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM staging WHERE staging_id=? AND owner_id=? AND revision=?", id, owner, revision); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ListStaging(ctx context.Context, query StagingQuery) (StagingPage, error) {
	result := StagingPage{Records: []Staging{}, NextID: query.AfterID}
	if !textValid(query.OwnerID, 256, true) || !textValid(query.AfterID, 256, true) {
		return result, ErrInvalid
	}
	limit, err := pageSize(query.Limit)
	if err != nil {
		return result, err
	}
	budget, err := pageBytes(query.ByteBudget)
	if err != nil {
		return result, err
	}
	used := 0
	statement := "SELECT staging_id,owner_id,workspace_id,purpose,relative_path,revision,lease_until_ms,metadata,active FROM staging WHERE staging_id>?"
	args := []any{query.AfterID}
	if query.OwnerID != "" {
		statement += " AND owner_id=?"
		args = append(args, query.OwnerID)
	}
	statement += " ORDER BY staging_id LIMIT ?"
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, statement, args...)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		if len(result.Records) == limit || (len(result.Records) > 0 && used >= budget) {
			result.HasMore = true
			break
		}
		record, err := scanStaging(rows)
		if err != nil {
			return result, err
		}
		size := len(record.Metadata) + len(record.ID) + len(record.OwnerID) + len(record.WorkspaceID) + len(record.RelativePath) + len(record.Purpose) + 128
		if len(result.Records) > 0 && used+size > budget {
			result.HasMore = true
			break
		}
		used += size
		result.Records = append(result.Records, record)
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	if len(result.Records) > limit {
		result.HasMore = true
		result.Records = result.Records[:limit]
	}
	if len(result.Records) > 0 {
		result.NextID = result.Records[len(result.Records)-1].ID
	}
	return result, nil
}
