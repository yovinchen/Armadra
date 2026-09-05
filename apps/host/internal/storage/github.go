package storage

import (
	"context"
	"database/sql"
	"errors"
)

// GitHub state the Host owns: which credential source was chosen, how each
// repository's status groups are configured, and which Issue or pull request a
// local session, branch or worktree is linked to.
//
// No token is ever stored here. GithubConfig records the source, the secret
// store and the reference under which that store holds the value; reading the
// credential itself always goes back to the OS store.

const (
	GithubSourceNone     = "none"
	GithubSourceGhCLI    = "gh_cli"
	GithubSourceTokenRef = "token_ref"

	GithubStoreNone         = "none"
	GithubStoreOSKeychain   = "os_keychain"
	GithubStoreFileFallback = "file_fallback"

	GithubReferenceIssue = 1
	GithubReferencePull  = 2

	GithubTargetSession  = 1
	GithubTargetBranch   = 2
	GithubTargetWorktree = 3

	MaxGithubMappingBytes = 256 << 10
)

// GithubConfig is the singleton credential and API base selection.
type GithubConfig struct {
	Source, APIBase, SecretStore, SecretRef, AccountLogin string
	Revision                                              uint64
	CreatedAtMS, UpdatedAtMS                              int64
}

// GithubRepositoryKey identifies one repository on one API base. The base is
// part of the key so an enterprise repository and a public one that happen to
// share owner/name are never the same record.
type GithubRepositoryKey struct{ Owner, Name, APIBase, WebHost string }

type GithubStatusMappingRecord struct {
	WorkspaceID              string
	Repository               GithubRepositoryKey
	Mapping                  []byte
	Revision                 uint64
	CreatedAtMS, UpdatedAtMS int64
}

type GithubReferenceRecord struct {
	ReferenceID, WorkspaceID string
	Repository               GithubRepositoryKey
	Kind                     int64
	Number                   int64
	TargetKind               int64
	TargetID, Title          string
	Revision                 uint64
	CreatedAtMS, UpdatedAtMS int64
}

func (k GithubRepositoryKey) validate() error {
	if !textValid(k.Owner, 256, false) || !textValid(k.Name, 256, false) {
		return ErrInvalid
	}
	if !textValid(k.APIBase, 2048, false) || !textValid(k.WebHost, 256, false) {
		return ErrInvalid
	}
	return nil
}

func (c GithubConfig) validate() error {
	switch c.Source {
	case GithubSourceNone, GithubSourceGhCLI, GithubSourceTokenRef:
	default:
		return ErrInvalid
	}
	switch c.SecretStore {
	case GithubStoreNone, GithubStoreOSKeychain, GithubStoreFileFallback:
	default:
		return ErrInvalid
	}
	// Only a pasted token is held by a secret store; the gh CLI source keeps
	// nothing at rest, so a reference there would describe something untrue.
	if (c.Source == GithubSourceTokenRef) != (c.SecretRef != "") {
		return ErrInvalid
	}
	if c.Source != GithubSourceTokenRef && c.SecretStore != GithubStoreNone {
		return ErrInvalid
	}
	if !textValid(c.APIBase, 2048, false) || !textValid(c.SecretRef, 256, true) || !textValid(c.AccountLogin, 256, true) {
		return ErrInvalid
	}
	if c.CreatedAtMS <= 0 || c.UpdatedAtMS <= 0 {
		return ErrInvalid
	}
	return nil
}

const githubConfigColumns = "SELECT source,api_base,secret_store,secret_ref,account_login,revision,created_at_ms,updated_at_ms FROM github_config WHERE singleton=1"

func scanGithubConfig(row scanner) (GithubConfig, error) {
	var record GithubConfig
	var revision int64
	err := row.Scan(&record.Source, &record.APIBase, &record.SecretStore, &record.SecretRef, &record.AccountLogin, &revision, &record.CreatedAtMS, &record.UpdatedAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return GithubConfig{}, ErrNotFound
	}
	if err != nil {
		return GithubConfig{}, err
	}
	if revision < 1 {
		return GithubConfig{}, ErrCorrupt
	}
	record.Revision = uint64(revision)
	if record.validate() != nil {
		return GithubConfig{}, ErrCorrupt
	}
	return record, nil
}

func (s *Store) GithubConfig(ctx context.Context) (GithubConfig, error) {
	return scanGithubConfig(s.db.QueryRowContext(ctx, githubConfigColumns))
}

// PutGithubConfig replaces the singleton under explicit revision CAS. Zero
// means "not configured yet"; anything else must match what the caller read.
func (s *Store) PutGithubConfig(ctx context.Context, record GithubConfig, expectedRevision uint64) (GithubConfig, error) {
	if err := record.validate(); err != nil {
		return GithubConfig{}, err
	}
	next, err := signed(expectedRevision + 1)
	if err != nil {
		return GithubConfig{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GithubConfig{}, err
	}
	defer tx.Rollback()
	existing, err := scanGithubConfig(tx.QueryRowContext(ctx, githubConfigColumns))
	switch {
	case errors.Is(err, ErrNotFound):
		if expectedRevision != 0 {
			return GithubConfig{}, ErrConflict
		}
		record.Revision = 1
		if _, err = tx.ExecContext(ctx, "INSERT INTO github_config(singleton,source,api_base,secret_store,secret_ref,account_login,revision,created_at_ms,updated_at_ms) VALUES(1,?,?,?,?,?,1,?,?)",
			record.Source, record.APIBase, record.SecretStore, record.SecretRef, record.AccountLogin, record.CreatedAtMS, record.UpdatedAtMS); err != nil {
			return GithubConfig{}, err
		}
		return record, tx.Commit()
	case err != nil:
		return GithubConfig{}, err
	}
	if existing.Revision != expectedRevision {
		return GithubConfig{}, ErrConflict
	}
	record.Revision = uint64(next)
	record.CreatedAtMS = existing.CreatedAtMS
	if err = changed(tx.ExecContext(ctx, "UPDATE github_config SET source=?,api_base=?,secret_store=?,secret_ref=?,account_login=?,revision=?,updated_at_ms=? WHERE singleton=1 AND revision=?",
		record.Source, record.APIBase, record.SecretStore, record.SecretRef, record.AccountLogin, next, record.UpdatedAtMS, int64(expectedRevision))); err != nil {
		return GithubConfig{}, err
	}
	return record, tx.Commit()
}

const githubMappingColumns = "SELECT workspace_id,api_base,owner,name,web_host,mapping,revision,created_at_ms,updated_at_ms FROM github_status_mappings"

func scanGithubMapping(row scanner) (GithubStatusMappingRecord, error) {
	var record GithubStatusMappingRecord
	var revision int64
	err := row.Scan(&record.WorkspaceID, &record.Repository.APIBase, &record.Repository.Owner, &record.Repository.Name, &record.Repository.WebHost, &record.Mapping, &revision, &record.CreatedAtMS, &record.UpdatedAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return GithubStatusMappingRecord{}, ErrNotFound
	}
	if err != nil {
		return GithubStatusMappingRecord{}, err
	}
	if revision < 1 || record.Repository.validate() != nil {
		return GithubStatusMappingRecord{}, ErrCorrupt
	}
	record.Revision = uint64(revision)
	return record, nil
}

func (s *Store) GithubStatusMapping(ctx context.Context, workspace string, repository GithubRepositoryKey) (GithubStatusMappingRecord, error) {
	if !textValid(workspace, 256, false) {
		return GithubStatusMappingRecord{}, ErrInvalid
	}
	if err := repository.validate(); err != nil {
		return GithubStatusMappingRecord{}, err
	}
	return scanGithubMapping(s.db.QueryRowContext(ctx, githubMappingColumns+" WHERE workspace_id=? AND api_base=? AND owner=? AND name=?", workspace, repository.APIBase, repository.Owner, repository.Name))
}

// PutGithubStatusMapping stores one repository's mapping under revision CAS.
// The mapping bytes are opaque here; validating that the configured groups do
// not describe a loop is the GitHub service's job, before it calls this.
func (s *Store) PutGithubStatusMapping(ctx context.Context, record GithubStatusMappingRecord, expectedRevision uint64) (GithubStatusMappingRecord, error) {
	if !textValid(record.WorkspaceID, 256, false) || len(record.Mapping) == 0 || len(record.Mapping) > MaxGithubMappingBytes {
		return GithubStatusMappingRecord{}, ErrInvalid
	}
	if err := record.Repository.validate(); err != nil {
		return GithubStatusMappingRecord{}, err
	}
	if record.CreatedAtMS <= 0 || record.UpdatedAtMS <= 0 {
		return GithubStatusMappingRecord{}, ErrInvalid
	}
	next, err := signed(expectedRevision + 1)
	if err != nil {
		return GithubStatusMappingRecord{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GithubStatusMappingRecord{}, err
	}
	defer tx.Rollback()
	existing, err := scanGithubMapping(tx.QueryRowContext(ctx, githubMappingColumns+" WHERE workspace_id=? AND api_base=? AND owner=? AND name=?", record.WorkspaceID, record.Repository.APIBase, record.Repository.Owner, record.Repository.Name))
	switch {
	case errors.Is(err, ErrNotFound):
		if expectedRevision != 0 {
			return GithubStatusMappingRecord{}, ErrConflict
		}
		record.Revision = 1
		if _, err = tx.ExecContext(ctx, "INSERT INTO github_status_mappings(workspace_id,api_base,owner,name,web_host,mapping,revision,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,1,?,?)",
			record.WorkspaceID, record.Repository.APIBase, record.Repository.Owner, record.Repository.Name, record.Repository.WebHost, record.Mapping, record.CreatedAtMS, record.UpdatedAtMS); err != nil {
			return GithubStatusMappingRecord{}, err
		}
		return record, tx.Commit()
	case err != nil:
		return GithubStatusMappingRecord{}, err
	}
	if existing.Revision != expectedRevision {
		return GithubStatusMappingRecord{}, ErrConflict
	}
	record.Revision = uint64(next)
	record.CreatedAtMS = existing.CreatedAtMS
	if err = changed(tx.ExecContext(ctx, "UPDATE github_status_mappings SET web_host=?,mapping=?,revision=?,updated_at_ms=? WHERE workspace_id=? AND api_base=? AND owner=? AND name=? AND revision=?",
		record.Repository.WebHost, record.Mapping, next, record.UpdatedAtMS, record.WorkspaceID, record.Repository.APIBase, record.Repository.Owner, record.Repository.Name, int64(expectedRevision))); err != nil {
		return GithubStatusMappingRecord{}, err
	}
	return record, tx.Commit()
}

const githubReferenceColumns = "SELECT reference_id,workspace_id,api_base,owner,name,web_host,kind,number,target_kind,target_id,title,revision,created_at_ms,updated_at_ms FROM github_references"

func scanGithubReference(row scanner) (GithubReferenceRecord, error) {
	var record GithubReferenceRecord
	var revision int64
	err := row.Scan(&record.ReferenceID, &record.WorkspaceID, &record.Repository.APIBase, &record.Repository.Owner, &record.Repository.Name, &record.Repository.WebHost,
		&record.Kind, &record.Number, &record.TargetKind, &record.TargetID, &record.Title, &revision, &record.CreatedAtMS, &record.UpdatedAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return GithubReferenceRecord{}, ErrNotFound
	}
	if err != nil {
		return GithubReferenceRecord{}, err
	}
	if revision < 1 || record.Repository.validate() != nil || record.validate() != nil {
		return GithubReferenceRecord{}, ErrCorrupt
	}
	record.Revision = uint64(revision)
	return record, nil
}

func (r GithubReferenceRecord) validate() error {
	if !textValid(r.ReferenceID, 256, false) || !textValid(r.WorkspaceID, 256, false) {
		return ErrInvalid
	}
	if r.Kind != GithubReferenceIssue && r.Kind != GithubReferencePull {
		return ErrInvalid
	}
	if r.TargetKind < GithubTargetSession || r.TargetKind > GithubTargetWorktree {
		return ErrInvalid
	}
	if r.Number <= 0 || !textValid(r.TargetID, 512, false) || !textValid(r.Title, 1024, true) {
		return ErrInvalid
	}
	return nil
}

// PutGithubReference creates or updates one link under revision CAS. A
// reference never moves between workspaces or repositories: re-pointing a badge
// at a different remote object is a new reference, not an edit of this one.
func (s *Store) PutGithubReference(ctx context.Context, record GithubReferenceRecord, expectedRevision uint64) (GithubReferenceRecord, error) {
	if err := record.validate(); err != nil {
		return GithubReferenceRecord{}, err
	}
	if err := record.Repository.validate(); err != nil {
		return GithubReferenceRecord{}, err
	}
	if record.CreatedAtMS <= 0 || record.UpdatedAtMS <= 0 {
		return GithubReferenceRecord{}, ErrInvalid
	}
	next, err := signed(expectedRevision + 1)
	if err != nil {
		return GithubReferenceRecord{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GithubReferenceRecord{}, err
	}
	defer tx.Rollback()
	existing, err := scanGithubReference(tx.QueryRowContext(ctx, githubReferenceColumns+" WHERE reference_id=?", record.ReferenceID))
	switch {
	case errors.Is(err, ErrNotFound):
		if expectedRevision != 0 {
			return GithubReferenceRecord{}, ErrConflict
		}
		record.Revision = 1
		if _, err = tx.ExecContext(ctx, "INSERT INTO github_references(reference_id,workspace_id,api_base,owner,name,web_host,kind,number,target_kind,target_id,title,revision,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)",
			record.ReferenceID, record.WorkspaceID, record.Repository.APIBase, record.Repository.Owner, record.Repository.Name, record.Repository.WebHost,
			record.Kind, record.Number, record.TargetKind, record.TargetID, record.Title, record.CreatedAtMS, record.UpdatedAtMS); err != nil {
			return GithubReferenceRecord{}, err
		}
		return record, tx.Commit()
	case err != nil:
		return GithubReferenceRecord{}, err
	}
	if existing.Revision != expectedRevision {
		return GithubReferenceRecord{}, ErrConflict
	}
	if existing.WorkspaceID != record.WorkspaceID || existing.Repository != record.Repository || existing.Kind != record.Kind || existing.Number != record.Number {
		return GithubReferenceRecord{}, ErrConflict
	}
	record.Revision = uint64(next)
	record.CreatedAtMS = existing.CreatedAtMS
	if err = changed(tx.ExecContext(ctx, "UPDATE github_references SET target_kind=?,target_id=?,title=?,revision=?,updated_at_ms=? WHERE reference_id=? AND revision=?",
		record.TargetKind, record.TargetID, record.Title, next, record.UpdatedAtMS, record.ReferenceID, int64(expectedRevision))); err != nil {
		return GithubReferenceRecord{}, err
	}
	return record, tx.Commit()
}

// DeleteGithubReference removes one link. Unlinking never touches the remote
// Issue or pull request, and never touches the local session it pointed at.
func (s *Store) DeleteGithubReference(ctx context.Context, workspace, id string, expectedRevision uint64) error {
	if !textValid(workspace, 256, false) || !textValid(id, 256, false) || expectedRevision == 0 {
		return ErrInvalid
	}
	return changed(s.db.ExecContext(ctx, "DELETE FROM github_references WHERE reference_id=? AND workspace_id=? AND revision=?", id, workspace, int64(expectedRevision)))
}

// GithubReferences lists a workspace's links, optionally for one target. An
// empty target lists the whole workspace; it is never an implicit match.
func (s *Store) GithubReferences(ctx context.Context, workspace, target, afterID string, limit int) ([]GithubReferenceRecord, error) {
	size, err := pageSize(limit)
	if err != nil {
		return nil, err
	}
	if !textValid(workspace, 256, false) || !textValid(target, 512, true) || !textValid(afterID, 256, true) {
		return nil, ErrInvalid
	}
	rows, err := s.db.QueryContext(ctx, githubReferenceColumns+" WHERE workspace_id=? AND reference_id>? AND (?='' OR target_id=?) ORDER BY reference_id LIMIT ?", workspace, afterID, target, target, size)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := []GithubReferenceRecord{}
	for rows.Next() {
		record, err := scanGithubReference(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}
