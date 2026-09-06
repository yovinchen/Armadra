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

// Write ownership per business domain (host protocol design §4, step 5). One
// row per domain, outside entities/events because it is not canvas content and
// must never be replayed to a client as a business change. `phase` exists so a
// crash between "the Host recorded the switch" and "the Runtime acknowledged
// it" is visible as an open maintenance window rather than resolving itself
// into one side silently believing it owns the domain.
const schemaV5 = `CREATE TABLE write_ownership (
 domain TEXT PRIMARY KEY CHECK(domain = 'canvas'),
 owner TEXT NOT NULL CHECK(owner IN ('runtime','host')),
 epoch INTEGER NOT NULL CHECK(epoch > 0),
 phase TEXT NOT NULL CHECK(phase IN ('settled','switching','rolling_back')),
 import_id TEXT NOT NULL CHECK(length(import_id) <= 128),
 reason_code TEXT NOT NULL CHECK(length(reason_code) <= 64),
 event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(event_sequence >= 0),
 revision INTEGER NOT NULL CHECK(revision > 0),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
)`

// Write ownership for all six domains (Go Host 业务所有权迁移 §3.1). SQLite
// cannot widen a CHECK in place, so the v5 table is renamed aside, the new one
// is created, the rows are copied and the old name is dropped. The copy is the
// point: an installation that already switched the canvas keeps its epoch,
// phase and import id exactly as they were.
//
// The five new domains get no rows here. An absent row means "no switch has
// ever been recorded on this Host", which the ownership service reports as the
// Runtime owning writes -- inserting rows would make this Host claim a history
// it does not have.
//
// A maintenance token is what lets an HTTPS caller open a window at all. Only
// the hash is stored, exactly like a pairing ticket: a leaked database must not
// hand anyone the ability to move a domain. One token covers one domain, is
// consumed once, and dies with the Host instance that issued it.
const schemaV6 = `ALTER TABLE write_ownership RENAME TO write_ownership_v5;
CREATE TABLE write_ownership (
 domain TEXT PRIMARY KEY CHECK(domain IN ('canvas','settings','filesystem','session','agent','git')),
 owner TEXT NOT NULL CHECK(owner IN ('runtime','host')),
 epoch INTEGER NOT NULL CHECK(epoch > 0),
 phase TEXT NOT NULL CHECK(phase IN ('settled','switching','rolling_back')),
 import_id TEXT NOT NULL CHECK(length(import_id) <= 128),
 reason_code TEXT NOT NULL CHECK(length(reason_code) <= 64),
 event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(event_sequence >= 0),
 revision INTEGER NOT NULL CHECK(revision > 0),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
);
INSERT INTO write_ownership(domain,owner,epoch,phase,import_id,reason_code,event_sequence,revision,created_at_ms,updated_at_ms) SELECT domain,owner,epoch,phase,import_id,reason_code,event_sequence,revision,created_at_ms,updated_at_ms FROM write_ownership_v5;
DROP TABLE write_ownership_v5;
CREATE TABLE maintenance_tokens (
 token_hash BLOB PRIMARY KEY CHECK(length(token_hash) = 32),
 domain TEXT NOT NULL CHECK(domain IN ('canvas','settings','filesystem','session','agent','git')),
 instance_id TEXT NOT NULL CHECK(length(instance_id) BETWEEN 1 AND 256),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
 consumed_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(consumed_at_ms >= 0)
)`

// Where a workspace's files are and who may touch them
// (Go Host 业务所有权迁移 §3.1 v7). The files themselves never move: this table
// is the *registration*, which is the only part of the filesystem domain that
// has an owner at all.
//
// It is a table of its own rather than an `entities` row because its columns
// are queried as columns — the Runtime proxy narrows a forwarded file request
// by reading one workspace's three permission bits, and decoding a payload to
// answer that would put a Protobuf parse in front of every proxied read.
//
// The path is frozen. There is no statement that moves a root: a workspace
// whose files are somewhere else is a new registration, because everything the
// workspace holds is addressed relative to the path that was frozen. A
// tombstone keeps its revision, so re-registering has to name it rather than
// start from zero, which is what stops a delayed request from re-registering a
// root under a revision that described a different directory.
const schemaV7 = `CREATE TABLE workspace_roots (
 workspace_id TEXT PRIMARY KEY,
 execution_host_id TEXT NOT NULL,
 canonical_path TEXT NOT NULL,
 proof_sha256 BLOB NOT NULL CHECK(length(proof_sha256) IN (0,32)),
 can_read INTEGER NOT NULL CHECK(can_read IN (0,1)),
 can_write INTEGER NOT NULL CHECK(can_write IN (0,1)),
 can_execute INTEGER NOT NULL CHECK(can_execute IN (0,1)),
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision > 0),
 registered_at_ms INTEGER NOT NULL CHECK(registered_at_ms > 0),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
)`

var migrations = []string{schemaV1, schemaV2, schemaV3, schemaV4, schemaV5, schemaV6, schemaV7}

type sqlReader interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func canonicalSQL(value string) string {
	return strings.Join(strings.Fields(strings.TrimSuffix(strings.TrimSpace(value), ";")), " ")
}

// objectName strips the punctuation a name can be written against, so
// `CREATE TABLE staging_ids (staging_id ...` and a quoted name both resolve to
// the identifier SQLite stores.
func objectName(token string) string {
	return strings.Trim(token, `"'()`)
}

// expectedObjects folds the migrations into the schema they must have produced,
// so validateSchema compares a database against this build's own statements
// rather than against a version number it would have to trust.
//
// Four statement forms are recognised, and an unrecognised one is an error
// rather than a skip: a migration this function cannot model would leave the
// validator silently blind to whatever that statement changed.
//
//	CREATE TABLE name (...)        defines an object
//	ALTER TABLE old RENAME TO new  moves it, and SQLite quotes the new name in
//	                               the schema text it stores
//	DROP TABLE name                removes it
//	INSERT INTO ...                changes rows, never the schema
func expectedObjects(version int) (map[string]string, error) {
	result := map[string]string{"schema_migrations": canonicalSQL(ledgerSQL)}
	for _, migration := range migrations[:version] {
		for _, statement := range strings.Split(migration, ";") {
			statement = canonicalSQL(statement)
			if statement == "" {
				continue
			}
			parts := strings.Fields(statement)
			switch {
			case len(parts) >= 4 && strings.EqualFold(parts[0], "CREATE") && strings.EqualFold(parts[1], "TABLE"):
				result[objectName(parts[2])] = statement
			case len(parts) == 5 && strings.EqualFold(parts[0], "ALTER") && strings.EqualFold(parts[1], "TABLE") && strings.EqualFold(parts[3], "RENAME"):
				return nil, fmt.Errorf("%w: rename needs a target", ErrSchema)
			case len(parts) == 6 && strings.EqualFold(parts[0], "ALTER") && strings.EqualFold(parts[1], "TABLE") &&
				strings.EqualFold(parts[3], "RENAME") && strings.EqualFold(parts[4], "TO"):
				from, to := objectName(parts[2]), objectName(parts[5])
				existing, ok := result[from]
				if !ok {
					return nil, fmt.Errorf("%w: %s cannot be renamed before it exists", ErrSchema, from)
				}
				delete(result, from)
				// SQLite rewrites the stored CREATE with the new name quoted,
				// and leaves the rest of the text alone.
				result[to] = strings.Replace(existing, " "+from+" ", ` "`+to+`" `, 1)
			case len(parts) == 3 && strings.EqualFold(parts[0], "DROP") && strings.EqualFold(parts[1], "TABLE"):
				name := objectName(parts[2])
				if _, ok := result[name]; !ok {
					return nil, fmt.Errorf("%w: %s cannot be dropped before it exists", ErrSchema, name)
				}
				delete(result, name)
			case strings.EqualFold(parts[0], "INSERT"):
			default:
				return nil, fmt.Errorf("%w: unrecognised migration statement", ErrSchema)
			}
		}
	}
	return result, nil
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
	expected, err := expectedObjects(version)
	if err != nil {
		return 0, err
	}
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
