// Reading the exported snapshot read-only and refusing anything whose ledger,
// schema or inventory this build does not recognise.

package migration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

func openSnapshot(path string) (*sql.DB, error) {
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err := os.Lstat(path + suffix); err == nil {
			return nil, errors.New("offline snapshot has unverified journal companions")
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	dsn, err := storage.SQLiteReadOnlyURI(path)
	if err != nil {
		return nil, err
	}
	parsed, err := url.Parse(dsn)
	if err != nil {
		return nil, err
	}
	query := parsed.Query()
	query.Set("immutable", "1")
	parsed.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", parsed.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

func quote(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }
func schema(ctx context.Context, db *sql.DB) (map[string]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite\_%' ESCAPE '\' AND name <> '_sqlx_migrations' ORDER BY type,name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var kind, name, statement string
		if err := rows.Scan(&kind, &name, &statement); err != nil {
			return nil, err
		}
		out[kind+":"+name] = statement
	}
	return out, rows.Err()
}
func validateLedger(ctx context.Context, db *sql.DB) error {
	var kind string
	if err := db.QueryRowContext(ctx, "SELECT type FROM sqlite_schema WHERE name='_sqlx_migrations'").Scan(&kind); err != nil {
		return err
	}
	if kind != "table" {
		return errors.New("migration ledger must be a table")
	}
	rows, err := db.QueryContext(ctx, "PRAGMA table_xinfo('_sqlx_migrations')")
	if err != nil {
		return err
	}
	defer rows.Close()
	names := []string{"version", "description", "installed_on", "success", "checksum", "execution_time"}
	types := []string{"BIGINT", "TEXT", "TIMESTAMP", "BOOLEAN", "BLOB", "BIGINT"}
	index := 0
	for rows.Next() {
		var cid, required, primary, hidden int
		var name, typ string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &typ, &required, &defaultValue, &primary, &hidden); err != nil {
			return err
		}
		expectedPrimary := 0
		if index == 0 {
			expectedPrimary = 1
		}
		if index >= len(names) || cid != index || name != names[index] || strings.ToUpper(typ) != types[index] || primary != expectedPrimary || hidden != 0 || (index > 0 && required != 1) {
			return errors.New("unsupported migration ledger schema")
		}
		index++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if index != len(names) {
		return errors.New("incomplete migration ledger schema")
	}
	return nil
}

func validateDatabase(ctx context.Context, db *sql.DB, manifest *pb.MigrationExportManifest) error {
	if err := validateLedger(ctx, db); err != nil {
		return err
	}
	var integrity string
	if err := db.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil {
		return err
	}
	if integrity != "ok" {
		return errors.New("source database integrity check failed")
	}
	fk, err := db.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	hasViolation := fk.Next()
	scanErr := fk.Err()
	fk.Close()
	if scanErr != nil {
		return scanErr
	}
	if hasViolation {
		return errors.New("source database has broken references")
	}
	rows, err := db.QueryContext(ctx, `SELECT version,checksum,CASE WHEN typeof(success)='integer' AND success=1 THEN 1 ELSE 0 END,description FROM _sqlx_migrations ORDER BY version`)
	if err != nil {
		return err
	}
	var migrations []*pb.ExportMigration
	for rows.Next() {
		m := new(pb.ExportMigration)
		if err = rows.Scan(&m.Version, &m.Checksum, &m.Success, &m.Description); err != nil {
			rows.Close()
			return err
		}
		migrations = append(migrations, m)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(migrations) < 1 || len(migrations) > len(legacyMigrations) || len(migrations) != len(manifest.Migrations) {
		return errors.New("unsupported source migration history")
	}
	expected, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return err
	}
	defer expected.Close()
	expected.SetMaxOpenConns(1)
	for i, m := range migrations {
		source, err := legacy.ReadFile(legacyMigrations[i])
		if err != nil {
			return err
		}
		version, err := legacyVersion(legacyMigrations[i])
		if err != nil {
			return err
		}
		checksum := sha512.Sum384(source)
		if m.Version != version || !m.Success || !bytes.Equal(m.Checksum, checksum[:]) || !proto.Equal(m, manifest.Migrations[i]) {
			return errors.New("source migration checksum or manifest mismatch")
		}
		if _, err = expected.ExecContext(ctx, string(source)); err != nil {
			return err
		}
	}
	actualSchema, err := schema(ctx, db)
	if err != nil {
		return err
	}
	knownSchema, err := schema(ctx, expected)
	if err != nil {
		return err
	}
	if len(actualSchema) != len(knownSchema) {
		return errors.New("source schema has unexpected objects")
	}
	for key, value := range knownSchema {
		if actualSchema[key] != value {
			return fmt.Errorf("source schema differs at %s", key)
		}
	}
	tables, err := db.QueryContext(ctx, "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
	if err != nil {
		return err
	}
	actualTables := map[string]string{}
	for tables.Next() {
		var name, statement string
		if err = tables.Scan(&name, &statement); err != nil {
			tables.Close()
			return err
		}
		actualTables[name] = statement
	}
	err = tables.Err()
	tables.Close()
	if err != nil {
		return err
	}
	if len(actualTables) != len(manifest.Tables) {
		return errors.New("table manifest does not cover the snapshot")
	}
	seen := map[string]bool{}
	for _, table := range manifest.Tables {
		statement, exists := actualTables[table.Name]
		if !exists || seen[table.Name] || !table.Readable {
			return errors.New("invalid table manifest")
		}
		seen[table.Name] = true
		sum := sha256.Sum256([]byte(statement))
		if !bytes.Equal(sum[:], table.SchemaSha256) {
			return errors.New("table schema digest mismatch")
		}
		var count uint64
		if err = db.QueryRowContext(ctx, "SELECT count(*) FROM "+quote(table.Name)).Scan(&count); err != nil {
			return err
		}
		if count != table.RowCount {
			return errors.New("table row count mismatch")
		}
	}
	return nil
}

func validateManifestData(ctx context.Context, db *sql.DB, m *pb.MigrationExportManifest) error {
	expectedIDs := map[string]bool{"workspaces": true, "boards": true, "nodes": true, "terminal_sessions": true, "edges": true}
	if len(m.Identities) != len(expectedIDs) {
		return errors.New("identity manifest is incomplete")
	}
	for _, set := range m.Identities {
		if !expectedIDs[set.Table] {
			return errors.New("unknown or duplicate identity table")
		}
		delete(expectedIDs, set.Table)
		rows, err := db.QueryContext(ctx, "SELECT id FROM "+quote(set.Table)+" ORDER BY id")
		if err != nil {
			return err
		}
		index := 0
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			if index >= len(set.Ids) || set.Ids[index] != id {
				rows.Close()
				return errors.New("identity manifest mismatch")
			}
			index++
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if index != len(set.Ids) {
			return errors.New("identity manifest length mismatch")
		}
	}
	rows, err := db.QueryContext(ctx, "SELECT id,workspace_id,whiteboard_json,kanban_json FROM boards ORDER BY id")
	if err != nil {
		return err
	}
	index := 0
	for rows.Next() {
		var id, workspace, whiteboard, kanban string
		if err = rows.Scan(&id, &workspace, &whiteboard, &kanban); err != nil {
			rows.Close()
			return err
		}
		if index >= len(m.Canvases) {
			rows.Close()
			return errors.New("canvas manifest incomplete")
		}
		c := m.Canvases[index]
		sum := sha256.Sum256([]byte(whiteboard))
		if c.CanvasId != id || c.WorkspaceId != workspace || c.WhiteboardBytes != uint64(len(whiteboard)) || !bytes.Equal(c.WhiteboardSha256, sum[:]) || !bytes.Equal(c.KanbanJson, []byte(kanban)) {
			rows.Close()
			return errors.New("canvas compatibility archive differs from snapshot")
		}
		index++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if index != len(m.Canvases) {
		return errors.New("canvas manifest length mismatch")
	}
	rows, err = db.QueryContext(ctx, "SELECT id,board_id,labels_json,note FROM nodes ORDER BY id")
	if err != nil {
		return err
	}
	index = 0
	for rows.Next() {
		var id, canvas, labels, note string
		if err = rows.Scan(&id, &canvas, &labels, &note); err != nil {
			rows.Close()
			return err
		}
		if index >= len(m.Annotations) {
			rows.Close()
			return errors.New("annotation manifest incomplete")
		}
		a := m.Annotations[index]
		if a.NodeId != id || a.CanvasId != canvas || !bytes.Equal(a.LabelsJson, []byte(labels)) || !bytes.Equal(a.NoteUtf8, []byte(note)) {
			rows.Close()
			return errors.New("annotation archive differs from snapshot")
		}
		index++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if index != len(m.Annotations) {
		return errors.New("annotation manifest length mismatch")
	}
	return nil
}
