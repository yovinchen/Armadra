package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// These strings are migration artifacts: once released, append a numbered
// migration instead of editing an existing SQL string and changing its checksum.
const ledgerSQL = `CREATE TABLE schema_migrations (
 version INTEGER PRIMARY KEY CHECK(version > 0),
 checksum BLOB NOT NULL CHECK(length(checksum) = 32),
 dirty INTEGER NOT NULL CHECK(dirty IN (0,1)),
 applied_at_ms INTEGER NOT NULL
)`

const schemaV1 = `CREATE TABLE store_meta (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 host_id TEXT NOT NULL,
 event_floor INTEGER NOT NULL DEFAULT 0 CHECK(event_floor >= 0),
 last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence >= event_floor)
);
CREATE TABLE entities (
 workspace_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 payload BLOB NOT NULL CHECK(length(payload) <= 16777216), deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
 PRIMARY KEY(workspace_id, kind, entity_id)
);
CREATE TABLE operations (
 transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
 operation_id TEXT NOT NULL UNIQUE, request_digest BLOB NOT NULL CHECK(length(request_digest) = 32),
 first_sequence INTEGER NOT NULL DEFAULT 0, last_sequence INTEGER NOT NULL DEFAULT 0,
 change_count INTEGER NOT NULL CHECK(change_count > 0), committed_at_ms INTEGER NOT NULL
);
CREATE TABLE operation_changes (
 operation_id TEXT NOT NULL REFERENCES operations(operation_id), position INTEGER NOT NULL,
 workspace_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0), deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
 PRIMARY KEY(operation_id, position)
);
CREATE TABLE events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 transaction_id INTEGER NOT NULL REFERENCES operations(transaction_id),
 operation_id TEXT NOT NULL REFERENCES operations(operation_id),
 transaction_index INTEGER NOT NULL, transaction_size INTEGER NOT NULL,
 workspace_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0), payload BLOB NOT NULL CHECK(length(payload) <= 16777216),
 deleted INTEGER NOT NULL CHECK(deleted IN (0,1))
);
CREATE TABLE staging_ids (staging_id TEXT PRIMARY KEY);
CREATE TABLE staging (
 staging_id TEXT PRIMARY KEY REFERENCES staging_ids(staging_id), owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
 purpose TEXT NOT NULL, relative_path TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0), lease_until_ms INTEGER NOT NULL,
 metadata BLOB NOT NULL CHECK(length(metadata) <= 16777216), active INTEGER NOT NULL DEFAULT 0 CHECK(active = 0)
)`

// Identity is deliberately outside entities/events. Only hashes of credentials
// belong here; these tables are never part of the public entity sync surface.
const schemaV2 = `CREATE TABLE identity_owner (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 principal_id TEXT NOT NULL UNIQUE CHECK(length(principal_id) = 32),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0)
);
CREATE TABLE identity_devices (
 device_id TEXT PRIMARY KEY CHECK(length(device_id) = 32),
 principal_id TEXT NOT NULL REFERENCES identity_owner(principal_id),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 256),
 role TEXT NOT NULL CHECK(role = 'owner'),
 epoch INTEGER NOT NULL CHECK(epoch > 0),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 revoked_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(revoked_at_ms >= 0)
);
CREATE TABLE identity_sessions (
 session_id TEXT PRIMARY KEY CHECK(length(session_id) = 32),
 device_id TEXT NOT NULL REFERENCES identity_devices(device_id),
 device_epoch INTEGER NOT NULL CHECK(device_epoch > 0),
 origin TEXT NOT NULL, scopes BLOB NOT NULL CHECK(length(scopes) <= 16384),
 access_hash BLOB NOT NULL CHECK(length(access_hash) = 32),
 refresh_hash BLOB NOT NULL CHECK(length(refresh_hash) = 32),
 csrf_hash BLOB NOT NULL CHECK(length(csrf_hash) = 32),
 rotation INTEGER NOT NULL CHECK(rotation > 0),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 access_expires_at_ms INTEGER NOT NULL CHECK(access_expires_at_ms > created_at_ms),
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= access_expires_at_ms),
 revoked_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(revoked_at_ms >= 0)
);
CREATE TABLE identity_bootstrap_tickets (
 ticket_id TEXT PRIMARY KEY CHECK(length(ticket_id) = 32),
 ticket_hash BLOB NOT NULL CHECK(length(ticket_hash) = 32),
 host_id TEXT NOT NULL, instance_id TEXT NOT NULL, origin TEXT NOT NULL,
 device_name TEXT NOT NULL CHECK(length(device_name) BETWEEN 1 AND 256),
 scopes BLOB NOT NULL CHECK(length(scopes) <= 16384),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
 consumed_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(consumed_at_ms >= 0)
)`

// Execution definitions the Host owns: the frozen command roots/sessions it
// rebuilds on a replaced Worker, the private payload bytes a plan sends to a
// new process, and the grant a dispatch is re-checked against. Payload bytes
// and grants stay out of the entity/event sync surface; only hashes and
// references reach clients.
const schemaV3 = `CREATE TABLE command_roots (
 root_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 path TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0)
);
CREATE TABLE command_sessions (
 session_id TEXT PRIMARY KEY,
 root_id TEXT NOT NULL REFERENCES command_roots(root_id),
 workspace_id TEXT NOT NULL,
 execution_host_id TEXT NOT NULL,
 launch BLOB NOT NULL CHECK(length(launch) BETWEEN 1 AND 131072),
 launch_sha256 BLOB NOT NULL CHECK(length(launch_sha256) = 32),
 generation INTEGER NOT NULL CHECK(generation > 0),
 state INTEGER NOT NULL CHECK(state IN (1,2)),
 reason_code TEXT NOT NULL CHECK(length(reason_code) <= 64),
 revision INTEGER NOT NULL CHECK(revision > 0),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
);
CREATE TABLE automation_payloads (
 workspace_id TEXT NOT NULL,
 payload_ref TEXT NOT NULL,
 payload BLOB NOT NULL CHECK(length(payload) <= 262144),
 payload_sha256 BLOB NOT NULL CHECK(length(payload_sha256) = 32),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 PRIMARY KEY(workspace_id, payload_ref)
);
CREATE TABLE automation_grants (
 authorization_id TEXT PRIMARY KEY CHECK(length(authorization_id) = 32),
 principal_id TEXT NOT NULL CHECK(length(principal_id) = 32),
 device_id TEXT NOT NULL REFERENCES identity_devices(device_id),
 device_epoch INTEGER NOT NULL CHECK(device_epoch > 0),
 scopes BLOB NOT NULL CHECK(length(scopes) BETWEEN 1 AND 16384),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
)`

// The GitHub surface the Host owns. The credential itself is never here: the
// row records which source was chosen, which secret store holds it and under
// what reference, so a token is only ever read back out of the OS store.
// Status mappings and external references are Host state, not entities, because
// they are configuration for a remote service rather than canvas content.
const schemaV4 = `CREATE TABLE github_config (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 source TEXT NOT NULL CHECK(source IN ('none','gh_cli','token_ref')),
 api_base TEXT NOT NULL CHECK(length(api_base) BETWEEN 1 AND 2048),
 secret_store TEXT NOT NULL CHECK(secret_store IN ('none','os_keychain','file_fallback')),
 secret_ref TEXT NOT NULL CHECK(length(secret_ref) <= 256),
 account_login TEXT NOT NULL CHECK(length(account_login) <= 256),
 revision INTEGER NOT NULL CHECK(revision > 0),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
);
CREATE TABLE github_status_mappings (
 workspace_id TEXT NOT NULL,
 api_base TEXT NOT NULL,
 owner TEXT NOT NULL,
 name TEXT NOT NULL,
 web_host TEXT NOT NULL,
 mapping BLOB NOT NULL CHECK(length(mapping) <= 262144),
 revision INTEGER NOT NULL CHECK(revision > 0),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0),
 PRIMARY KEY(workspace_id, api_base, owner, name)
);
CREATE TABLE github_references (
 reference_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 api_base TEXT NOT NULL,
 owner TEXT NOT NULL,
 name TEXT NOT NULL,
 web_host TEXT NOT NULL,
 kind INTEGER NOT NULL CHECK(kind IN (1,2)),
 number INTEGER NOT NULL CHECK(number > 0),
 target_kind INTEGER NOT NULL CHECK(target_kind IN (1,2,3)),
 target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 512),
 title TEXT NOT NULL CHECK(length(title) <= 1024),
 revision INTEGER NOT NULL CHECK(revision > 0),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
)`

var migrations = []string{schemaV1, schemaV2, schemaV3, schemaV4}

type sqlReader interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func canonicalSQL(value string) string {
	return strings.Join(strings.Fields(strings.TrimSuffix(strings.TrimSpace(value), ";")), " ")
}

func expectedObjects(version int) map[string]string {
	result := map[string]string{"schema_migrations": canonicalSQL(ledgerSQL)}
	for _, migration := range migrations[:version] {
		for _, statement := range strings.Split(migration, ";") {
			statement = canonicalSQL(statement)
			if statement == "" {
				continue
			}
			parts := strings.Fields(statement)
			result[parts[2]] = statement
		}
	}
	return result
}

func validateSchema(ctx context.Context, db sqlReader, hostID string) (int, error) {
	rows, err := db.QueryContext(ctx, "SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
	if err != nil {
		return 0, errors.Join(ErrSchema, err)
	}
	objects := map[string]string{}
	for rows.Next() {
		var name, kind string
		var statement sql.NullString
		if err = rows.Scan(&name, &kind, &statement); err != nil {
			rows.Close()
			return 0, err
		}
		if kind != "table" || !statement.Valid {
			rows.Close()
			return 0, ErrSchema
		}
		objects[name] = canonicalSQL(statement.String)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	var userVersion int
	if err = db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&userVersion); err != nil {
		return 0, err
	}
	if len(objects) == 0 {
		if userVersion != 0 {
			return 0, ErrSchema
		}
		return 0, nil
	}
	if objects["schema_migrations"] != canonicalSQL(ledgerSQL) {
		return 0, ErrSchema
	}
	rows, err = db.QueryContext(ctx, "SELECT version, checksum, dirty FROM schema_migrations ORDER BY version")
	if err != nil {
		return 0, errors.Join(ErrSchema, err)
	}
	version := 0
	for rows.Next() {
		var next, dirty int
		var checksum []byte
		if err = rows.Scan(&next, &checksum, &dirty); err != nil {
			rows.Close()
			return 0, errors.Join(ErrSchema, err)
		}
		if next != version+1 || next > len(migrations) || dirty != 0 {
			rows.Close()
			return 0, ErrSchema
		}
		expected := sha256.Sum256([]byte(migrations[next-1]))
		if !bytes.Equal(checksum, expected[:]) {
			rows.Close()
			return 0, ErrSchema
		}
		version = next
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	if version == 0 || userVersion != version {
		return 0, ErrSchema
	}
	expected := expectedObjects(version)
	if len(objects) != len(expected) {
		return 0, ErrSchema
	}
	for name, statement := range expected {
		if objects[name] != statement {
			return 0, fmt.Errorf("%w: object %s differs", ErrSchema, name)
		}
	}
	var stored string
	if err = db.QueryRowContext(ctx, "SELECT host_id FROM store_meta WHERE singleton=1").Scan(&stored); err != nil {
		return 0, errors.Join(ErrSchema, err)
	}
	if stored != hostID {
		return 0, ErrHostMismatch
	}
	return version, nil
}

func migrate(ctx context.Context, db *sql.DB, hostID string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	version, err := validateSchema(ctx, tx, hostID)
	if err != nil {
		return err
	}
	if version == 0 {
		if _, err = tx.ExecContext(ctx, ledgerSQL); err != nil {
			return err
		}
	}
	for index := version; index < len(migrations); index++ {
		checksum := sha256.Sum256([]byte(migrations[index]))
		if _, err = tx.ExecContext(ctx, "INSERT INTO schema_migrations(version,checksum,dirty,applied_at_ms) VALUES(?,?,1,?)", index+1, checksum[:], time.Now().UnixMilli()); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, migrations[index]); err != nil {
			return errors.Join(ErrSchema, err)
		}
		if index == 0 {
			if _, err = tx.ExecContext(ctx, "INSERT INTO store_meta(singleton,host_id) VALUES(1,?)", hostID); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "UPDATE schema_migrations SET dirty=0 WHERE version=?", index+1); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version=%d", index+1)); err != nil {
			return err
		}
	}
	if _, err = validateSchema(ctx, tx, hostID); err != nil {
		return err
	}
	return tx.Commit()
}
