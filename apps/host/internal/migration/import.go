// Package migration verifies offline exports and stores a resumable, inactive
// import. It never opens the original canvas.db or grants business ownership.
package migration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"database/sql"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

//go:embed legacy/*.sql
var legacy embed.FS

const maxManifest = 64 << 20
const maxDatabase = int64(16 << 30)
const maxAsset = int64(256 << 20)

type Bundle struct {
	Directory string
	Manifest  *pb.MigrationExportManifest
	Digest    [32]byte
	raw       []byte
}

func relativeFile(root, relative string) (string, error) {
	if relative == "" || strings.ContainsAny(relative, "\\:\x00") || strings.HasPrefix(relative, "/") || strings.Contains(strings.Split(relative, "/")[0], ":") {
		return "", errors.New("invalid package path")
	}
	path := root
	for _, part := range strings.Split(relative, "/") {
		if part == "" || part == "." || part == ".." {
			return "", errors.New("invalid package path")
		}
		path = filepath.Join(path, part)
		info, err := os.Lstat(path)
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("package symlinks are not supported")
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("package entry is not a regular file")
	}
	return path, nil
}
func hashFile(path string, limit int64) ([]byte, uint64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, 0, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, 0, errors.New("package file exceeds its limit")
	}
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, limit+1))
	if err != nil {
		return nil, 0, err
	}
	if n > limit {
		return nil, 0, errors.New("package file exceeds its limit")
	}
	return h.Sum(nil), uint64(n), nil
}
func verifyFile(root, relative string, size uint64, digest []byte, limit int64) (string, error) {
	if len(digest) != 32 {
		return "", errors.New("invalid package digest")
	}
	path, err := relativeFile(root, relative)
	if err != nil {
		return "", err
	}
	actual, n, err := hashFile(path, limit)
	if err != nil {
		return "", err
	}
	if n != size || !bytes.Equal(actual, digest) {
		return "", errors.New("package file checksum or length mismatch")
	}
	return path, nil
}
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
	if len(migrations) < 1 || len(migrations) > 4 || len(migrations) != len(manifest.Migrations) {
		return errors.New("unsupported source migration history")
	}
	expected, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return err
	}
	defer expected.Close()
	expected.SetMaxOpenConns(1)
	names := []string{"legacy/0001_initial.sql", "legacy/0002_agent_mailbox.sql", "legacy/0003_retire_kanban.sql", "legacy/0004_agent_handoffs.sql"}
	for i, m := range migrations {
		source, err := legacy.ReadFile(names[i])
		if err != nil {
			return err
		}
		checksum := sha512.Sum384(source)
		if m.Version != int64(i+1) || !m.Success || !bytes.Equal(m.Checksum, checksum[:]) || !proto.Equal(m, manifest.Migrations[i]) {
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

func ensureDirectory(root, relative string) (string, error) {
	current := root
	for _, part := range strings.Split(relative, "/") {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\:") {
			return "", errors.New("invalid artifact directory")
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			if err = os.Mkdir(current, 0700); err != nil && !errors.Is(err, os.ErrExist) {
				return "", err
			}
			info, err = os.Lstat(current)
		}
		if err != nil {
			return "", err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("import artifact directory is a link or file")
		}
		if err = storage.ProtectArtifactDirectory(current); err != nil {
			return "", err
		}
	}
	return current, nil
}

// Inspect validates before the CLI creates any Host state. A bundle may contain
// explicitly reported missing assets; it remains inactive and preserves issues.
func Inspect(ctx context.Context, directory string) (*Bundle, error) {
	root, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return nil, err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	path, err := relativeFile(root, "manifest.pb")
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxManifest+1))
	file.Close()
	if err != nil {
		return nil, err
	}
	if len(raw) > maxManifest {
		return nil, errors.New("export manifest is too large")
	}
	m := new(pb.MigrationExportManifest)
	if err = (proto.UnmarshalOptions{RecursionLimit: 64}).Unmarshal(raw, m); err != nil {
		return nil, err
	}
	if m.FormatVersion != 1 || m.ExportId == "" || m.DatabaseFile != "source.sqlite" || m.OwnershipSwitchAllowed {
		return nil, errors.New("unsupported export contract")
	}
	database, err := verifyFile(root, m.DatabaseFile, m.DatabaseBytes, m.DatabaseSha256, maxDatabase)
	if err != nil {
		return nil, err
	}
	db, err := openSnapshot(database)
	if err != nil {
		return nil, err
	}
	err = validateDatabase(ctx, db, m)
	if err == nil {
		err = validateManifestData(ctx, db, m)
	}
	db.Close()
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var total uint64
	for _, asset := range m.Assets {
		if !asset.Copied {
			if m.AssetsComplete {
				return nil, errors.New("incomplete assets claimed complete")
			}
			continue
		}
		if !strings.HasPrefix(asset.BundlePath, "assets/") || seen[asset.BundlePath] {
			return nil, errors.New("duplicate or invalid asset path")
		}
		seen[asset.BundlePath] = true
		total += asset.Bytes
		if total > 2<<30 {
			return nil, errors.New("export assets exceed total limit")
		}
		if _, err = verifyFile(root, asset.BundlePath, asset.Bytes, asset.Sha256, maxAsset); err != nil {
			return nil, err
		}
	}
	return &Bundle{Directory: root, Manifest: m, Digest: sha256.Sum256(raw), raw: raw}, nil
}

func copyFile(ctx context.Context, from, to string, digest []byte, size uint64) error {
	if info, err := os.Lstat(to); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("existing import artifact is not a regular file")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if actual, n, err := hashFile(to, maxDatabase); err == nil {
		if n == size && bytes.Equal(actual, digest) {
			return nil
		}
		return errors.New("existing import artifact differs")
	}
	if err := os.MkdirAll(filepath.Dir(to), 0700); err != nil {
		return err
	}
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	tmp, err := os.CreateTemp(filepath.Dir(to), ".copy-*.partial")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	h := sha256.New()
	buffer := make([]byte, 256<<10)
	var count uint64
	for {
		if err = ctx.Err(); err != nil {
			tmp.Close()
			return err
		}
		n, e := src.Read(buffer)
		if n > 0 {
			count += uint64(n)
			if count > size {
				tmp.Close()
				return errors.New("source changed during import")
			}
			h.Write(buffer[:n])
			if _, err = tmp.Write(buffer[:n]); err != nil {
				tmp.Close()
				return err
			}
		}
		if e == io.EOF {
			break
		}
		if e != nil {
			tmp.Close()
			return e
		}
	}
	if count != size || !bytes.Equal(h.Sum(nil), digest) {
		tmp.Close()
		return errors.New("source changed during import")
	}
	err = tmp.Sync()
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	// Publish without replacing an existing import artifact.
	if err = os.Link(name, to); err != nil {
		return err
	}
	return nil
}
func sqlColumn(name string, value any) (*pb.ImportedSqlColumn, error) {
	c := &pb.ImportedSqlColumn{Name: name}
	switch v := value.(type) {
	case nil:
		c.Value = &pb.ImportedSqlColumn_NullValue{NullValue: &pb.SqlNull{}}
	case string:
		c.Value = &pb.ImportedSqlColumn_TextValue{TextValue: v}
	case []byte:
		c.Value = &pb.ImportedSqlColumn_BlobValue{BlobValue: append([]byte(nil), v...)}
	case int64:
		c.Value = &pb.ImportedSqlColumn_IntegerValue{IntegerValue: v}
	case float64:
		c.Value = &pb.ImportedSqlColumn_RealValue{RealValue: v}
	default:
		return nil, fmt.Errorf("unsupported SQLite value %T", value)
	}
	return c, nil
}

// Stage is restartable by manifest digest. Partial batches remain isolated under
// this import ID; neither a completed nor partial import grants write ownership.
func Stage(ctx context.Context, store *storage.Store, bundle *Bundle) (*pb.MigrationImportReport, error) {
	importID := hex.EncodeToString(bundle.Digest[:])
	relative := "migration-imports/" + importID
	destination := filepath.Join(filepath.Dir(store.Path()), filepath.FromSlash(relative))
	reportKey := storage.Key{Kind: "migration.report", ID: importID}
	if entity, err := store.Read(ctx, reportKey); err == nil && !entity.Deleted {
		report := new(pb.MigrationImportReport)
		if err = proto.Unmarshal(entity.Payload, report); err != nil {
			return nil, err
		}
		return report, nil
	} else if err != nil && !errors.Is(err, storage.ErrNotFound) {
		return nil, err
	}
	stage, err := store.GetStaging(ctx, importID)
	if errors.Is(err, storage.ErrNotFound) {
		stage, err = store.PutStaging(ctx, storage.Staging{ID: importID, OwnerID: store.HostID(), Purpose: "migration.import", RelativePath: relative, LeaseUntilMS: math.MaxInt64, Metadata: bundle.Digest[:]}, "", 0)
	}
	if err != nil {
		return nil, err
	}
	if stage.OwnerID != store.HostID() || stage.RelativePath != relative || stage.Active || !bytes.Equal(stage.Metadata, bundle.Digest[:]) {
		return nil, storage.ErrOwnership
	}
	if _, err = ensureDirectory(filepath.Dir(store.Path()), relative); err != nil {
		return nil, err
	}
	source, err := relativeFile(bundle.Directory, "source.sqlite")
	if err != nil {
		return nil, err
	}
	if err = copyFile(ctx, source, filepath.Join(destination, "source.sqlite"), bundle.Manifest.DatabaseSha256, bundle.Manifest.DatabaseBytes); err != nil {
		return nil, err
	}
	for _, asset := range bundle.Manifest.Assets {
		if !asset.Copied {
			continue
		}
		source, err = relativeFile(bundle.Directory, asset.BundlePath)
		if err != nil {
			return nil, err
		}
		parent := strings.TrimSuffix(asset.BundlePath, "/"+filepath.Base(asset.BundlePath))
		if _, err = ensureDirectory(destination, parent); err != nil {
			return nil, err
		}
		if err = copyFile(ctx, source, filepath.Join(destination, filepath.FromSlash(asset.BundlePath)), asset.Sha256, asset.Bytes); err != nil {
			return nil, err
		}
	}
	source, err = relativeFile(bundle.Directory, "manifest.pb")
	if err != nil {
		return nil, err
	}
	if err = copyFile(ctx, source, filepath.Join(destination, "manifest.pb"), bundle.Digest[:], uint64(len(bundle.raw))); err != nil {
		return nil, err
	}
	db, err := openSnapshot(filepath.Join(destination, "source.sqlite"))
	if err != nil {
		return nil, err
	}
	defer db.Close()
	if err = validateDatabase(ctx, db, bundle.Manifest); err != nil {
		return nil, err
	}
	boardWorkspaces := map[string]string{}
	sessionWorkspaces := map[string]string{}
	for table, mapping := range map[string]map[string]string{"boards": boardWorkspaces, "terminal_sessions": sessionWorkspaces} {
		rows, e := db.QueryContext(ctx, "SELECT id,workspace_id FROM "+quote(table))
		if e != nil {
			return nil, e
		}
		for rows.Next() {
			var id, workspace string
			if e = rows.Scan(&id, &workspace); e != nil {
				rows.Close()
				return nil, e
			}
			mapping[id] = workspace
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
	}
	report := &pb.MigrationImportReport{ImportId: importID, ExportId: bundle.Manifest.ExportId, HostId: store.HostID(), ManifestSha256: bundle.Digest[:], Tables: bundle.Manifest.Tables, Issues: bundle.Manifest.Issues, State: "staged"}
	names := make([]string, 0, len(bundle.Manifest.Tables))
	for _, table := range bundle.Manifest.Tables {
		names = append(names, table.Name)
	}
	sort.Strings(names)
	batch := []storage.Change{}
	batchBytes := 0
	batchIndex := 0
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		result, err := store.Apply(ctx, fmt.Sprintf("migration/%s/batch/%d", importID, batchIndex), batch)
		if err != nil {
			return err
		}
		report.LastEventSequence = result.LastSequence
		batchIndex++
		batch = nil
		batchBytes = 0
		return nil
	}
	for _, table := range names {
		info, err := db.QueryContext(ctx, "PRAGMA table_info("+quote(table)+")")
		if err != nil {
			return nil, err
		}
		primary := map[int]string{}
		projections := []string{}
		for info.Next() {
			var cid, notNull, pk int
			var name, typ string
			var def any
			if err = info.Scan(&cid, &name, &typ, &notNull, &def, &pk); err != nil {
				info.Close()
				return nil, err
			}
			// CASE retains the SQLite storage class but removes declared-type
			// conversion (e.g. TIMESTAMP -> time.Time) in database/sql drivers.
			projections = append(projections, "CASE WHEN 1 THEN "+quote(name)+" END AS "+quote(name))
			if pk > 0 {
				primary[pk] = name
			}
		}
		err = info.Err()
		info.Close()
		if err != nil {
			return nil, err
		}
		if len(primary) == 0 {
			return nil, fmt.Errorf("table %s has no stable primary key", table)
		}
		order := []string{}
		for i := 1; i <= len(primary); i++ {
			order = append(order, quote(primary[i]))
		}
		rows, err := db.QueryContext(ctx, "SELECT "+strings.Join(projections, ",")+" FROM "+quote(table)+" ORDER BY "+strings.Join(order, ","))
		if err != nil {
			return nil, err
		}
		columns, err := rows.Columns()
		if err != nil {
			rows.Close()
			return nil, err
		}
		for rows.Next() {
			values := make([]any, len(columns))
			dest := make([]any, len(columns))
			for i := range values {
				dest[i] = &values[i]
			}
			if err = rows.Scan(dest...); err != nil {
				rows.Close()
				return nil, err
			}
			row := &pb.ImportedSqlRow{Table: table}
			key := &pb.ImportedSqlRow{Table: table}
			workspace := ""
			for i, name := range columns {
				column, e := sqlColumn(name, values[i])
				if e != nil {
					rows.Close()
					return nil, e
				}
				row.Columns = append(row.Columns, column)
				if name == "workspace_id" {
					workspace = column.GetTextValue()
				}
				if table == "workspaces" && name == "id" {
					workspace = column.GetTextValue()
				}
				if (table == "nodes" || table == "edges") && name == "board_id" {
					workspace = boardWorkspaces[column.GetTextValue()]
				}
				if table == "terminal_logs" && name == "session_id" {
					workspace = sessionWorkspaces[column.GetTextValue()]
				}
				for _, p := range primary {
					if name == p {
						key.Columns = append(key.Columns, column)
					}
				}
			}
			encoded, e := proto.Marshal(row)
			if e != nil {
				rows.Close()
				return nil, e
			}
			keyBytes, e := proto.Marshal(key)
			if e != nil {
				rows.Close()
				return nil, e
			}
			sum := sha256.Sum256(keyBytes)
			if len(encoded) > storage.MaxPayloadBytes {
				rows.Close()
				return nil, errors.New("legacy row exceeds storage entity limit")
			}
			if len(batch) >= storage.MaxChanges || batchBytes+len(encoded) > storage.MaxBatchBytes-(1<<16) {
				if err = flush(); err != nil {
					rows.Close()
					return nil, err
				}
			}
			batch = append(batch, storage.Change{Key: storage.Key{Kind: "legacy." + table, ID: importID + "." + hex.EncodeToString(sum[:]), WorkspaceID: workspace}, Payload: encoded})
			batchBytes += len(encoded)
			report.EntityCount++
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	if err = flush(); err != nil {
		return nil, err
	}
	if _, err = verifyFile(destination, "source.sqlite", bundle.Manifest.DatabaseBytes, bundle.Manifest.DatabaseSha256, maxDatabase); err != nil {
		return nil, err
	}
	if !bundle.Manifest.AssetsComplete {
		report.Issues = append(append([]*pb.ExportIssue(nil), report.Issues...), &pb.ExportIssue{Code: "assets_incomplete", Severity: "error", Entity: "import", Detail: "Managed assets require repair before ownership can change"})
	}
	payload, err := proto.Marshal(report)
	if err != nil {
		return nil, err
	}
	if _, err = store.Apply(ctx, "migration/"+importID+"/complete", []storage.Change{{Key: reportKey, Payload: payload}}); err != nil {
		return nil, err
	}
	return report, nil
}
