package migration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const (
	fixtureHost    = "0123456789abcdef0123456789abcdef"
	workspaceA     = "019ff7d1-0d12-7421-833d-2c5e8d64ed01"
	workspaceB     = "019ff7d1-0d12-7421-833d-2c5e8d64ed02"
	canvasA        = "019ff7d1-0d12-7421-833d-2c5e8d64ed11"
	canvasB        = "019ff7d1-0d12-7421-833d-2c5e8d64ed12"
	nodeA          = "019ff7d1-0d12-7421-833d-2c5e8d64ed21"
	nodeB          = "019ff7d1-0d12-7421-833d-2c5e8d64ed22"
	nodeC          = "019ff7d1-0d12-7421-833d-2c5e8d64ed23"
	terminalA      = "019ff7d1-0d12-7421-833d-2c5e8d64ed31"
	edgeA          = "019ff7d1-0d12-7421-833d-2c5e8d64ed41"
	timestampText  = "2026-09-05 01:02:03.004+08:00"
	largeInteger   = int64(9007199254740993)
	whiteboardText = `{ "records": [{"id":"asset:proof","typeName":"asset","props":{"src":".armadra/assets/proof.bin"}}, {"text":"中文白板 原样"}] }`
	kanbanText     = `{ "columns": [{"id":"old","title":"归档列"}], "cards": {} }`
	labelsText     = `[ "needs review", "中文" ]`
	noteText       = "Keep exact whitespace.\n第二行 'quote'."
)

var fixtureContext = context.Background()
var fixtureAsset = []byte{0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a}

type exportFixture struct {
	directory, original, snapshot string
	manifest                      *pb.MigrationExportManifest
}

func fixtureSQL(t *testing.T, path string) *sql.DB {
	t.Helper()
	uri, err := storage.SQLiteReadOnlyURI(path)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(uri)
	if err != nil {
		t.Fatal(err)
	}
	parsed.RawQuery = url.Values{"mode": {"rwc"}, "_pragma": {"foreign_keys(1)", "busy_timeout(5000)"}}.Encode()
	db, err := sql.Open("sqlite", parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	return db
}
func fixtureExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.ExecContext(fixtureContext, query, args...); err != nil {
		t.Fatal(err)
	}
}
func fixtureIdentifier(value string) string { return `"` + strings.ReplaceAll(value, `"`, `""`) + `"` }

func newExportFixture(t *testing.T, version, logs int) *exportFixture {
	t.Helper()
	root := t.TempDir()
	directory := filepath.Join(root, "export # 中文")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(root, "canvas.db")
	db := fixtureSQL(t, original)
	fixtureExec(t, db, `CREATE TABLE _sqlx_migrations (
 version BIGINT PRIMARY KEY, description TEXT NOT NULL,
 installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)`)
	for index, name := range []string{"legacy/0001_initial.sql", "legacy/0002_agent_mailbox.sql"} {
		if index >= version {
			break
		}
		source, err := legacy.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		fixtureExec(t, db, string(source))
		checksum := sha512.Sum384(source)
		description := []string{"initial", "agent mailbox"}[index]
		fixtureExec(t, db, "INSERT INTO _sqlx_migrations(version,description,installed_on,success,checksum,execution_time) VALUES(?,?,?,1,?,?)", index+1, description, timestampText, checksum[:], largeInteger+int64(index))
	}
	for _, workspace := range []struct{ id, root string }{{workspaceA, "/original/项目"}, {workspaceB, "/original/other"}} {
		fixtureExec(t, db, "INSERT INTO workspaces(id,name,root_path,created_at,updated_at) VALUES(?,?,?,?,?)", workspace.id, "原始项目", workspace.root, timestampText, timestampText)
	}
	for _, board := range []struct{ id, workspace string }{{canvasA, workspaceA}, {canvasB, workspaceB}} {
		fixtureExec(t, db, "INSERT INTO boards(id,workspace_id,name,sort_order,whiteboard_json,kanban_json,created_at,updated_at) VALUES(?,?,?,7,?,?,?,?)", board.id, board.workspace, "原画布", whiteboardText, kanbanText, timestampText, timestampText)
	}
	for index, node := range []struct{ id, board, kind string }{{nodeA, canvasA, "sticky"}, {nodeB, canvasA, "terminal"}, {nodeC, canvasB, "sticky"}} {
		data := `{"kind":"sticky","content":"原始正文"}`
		if node.kind == "terminal" {
			data = `{"kind":"terminal"}`
		}
		fixtureExec(t, db, "INSERT INTO nodes(id,board_id,type,x,y,width,height,title,labels_json,note,data_json,created_at,updated_at) VALUES(?,?,?,123.25,-9.5,NULL,240,?,?,?,?,?,?)", node.id, node.board, node.kind, fmt.Sprintf("节点 %d", index), labelsText, noteText, data, timestampText, timestampText)
	}
	fixtureExec(t, db, "INSERT INTO edges(id,board_id,source_node_id,target_node_id,kind,created_at,updated_at) VALUES(?,?,?,?,'link',?,?)", edgeA, canvasA, nodeA, nodeB, timestampText, timestampText)
	fixtureExec(t, db, "INSERT INTO terminal_sessions(id,workspace_id,owner_node_id,session_key,cwd,shell,command,status,generation,created_at) VALUES(?,?,?,?,?,'/bin/sh',NULL,'running',3,?)", terminalA, workspaceA, nodeB, nodeB, "/original/项目", timestampText)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < logs; index++ {
		if _, err = tx.Exec("INSERT INTO terminal_logs(id,session_id,stream,content,created_at) VALUES(?,?,'stdout',?,?)", fmt.Sprintf("log-%04d", index), terminalA, fmt.Sprintf("line %d 中文\n", index), timestampText); err != nil {
			tx.Rollback()
			t.Fatal(err)
		}
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if version >= 2 {
		fixtureExec(t, db, "INSERT INTO agent_mailbox(id,workspace_id,source_node_id,target_node_id,message_key,body,created_at,expires_at) VALUES('mail-1',?,?,?,'key','message 原样',?,?)", workspaceA, nodeA, nodeB, largeInteger, largeInteger+100)
	}
	if version >= 3 {
		source, err := legacy.ReadFile("legacy/0003_retire_kanban.sql")
		if err != nil {
			t.Fatal(err)
		}
		fixtureExec(t, db, string(source))
		checksum := sha512.Sum384(source)
		fixtureExec(t, db, "INSERT INTO _sqlx_migrations(version,description,installed_on,success,checksum,execution_time) VALUES(3,'retire kanban',?,1,?,?)", timestampText, checksum[:], largeInteger+2)
	}
	if version >= 4 {
		source, err := legacy.ReadFile("legacy/0004_agent_handoffs.sql")
		if err != nil {
			t.Fatal(err)
		}
		fixtureExec(t, db, string(source))
		checksum := sha512.Sum384(source)
		fixtureExec(t, db, "INSERT INTO _sqlx_migrations(version,description,installed_on,success,checksum,execution_time) VALUES(4,'agent handoffs',?,1,?,?)", timestampText, checksum[:], largeInteger+3)
		fixtureExec(t, db, "INSERT INTO agent_handoffs(id,workspace_id,source_node_id,source_session_id,source_generation,target_node_id,target_session_id,target_generation,bundle_json,bundle_digest,state,created_at,updated_at) VALUES('handoff-fixture',?,?,?,3,?,?,4,?,?,'unknownOutcome',?,?)", workspaceA, nodeA, terminalA, nodeB, terminalA, `{ "frozen": "原始交接资料" }`, "digest-fixture", timestampText, timestampText)
		fixtureExec(t, db, "INSERT INTO agent_handoff_outbox(handoff_id,state,created_at) VALUES('handoff-fixture','unknown',?)", timestampText)
	}
	snapshot := filepath.Join(directory, "source.sqlite")
	fixtureExec(t, db, "VACUUM INTO ?", snapshot)
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(directory, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(directory, "assets", "proof.bin"), fixtureAsset, 0600); err != nil {
		t.Fatal(err)
	}
	result := &exportFixture{directory: directory, original: original, snapshot: snapshot}
	result.manifest = fixtureManifest(t, result)
	writeFixtureManifest(t, result)
	return result
}

// Construct producer metadata from the real fixture database, not from the
// importer's validation helpers. Assertions below also compare source SQL values.
func fixtureManifest(t *testing.T, fixture *exportFixture) *pb.MigrationExportManifest {
	t.Helper()
	db := fixtureSQL(t, fixture.snapshot)
	defer db.Close()
	manifest := &pb.MigrationExportManifest{FormatVersion: 1, ExportId: "fixture-export", ExportedAtUnixMs: 1788560523004, ProducerVersion: "0.1.0-test", DatabaseFile: "source.sqlite", AssetsComplete: true}
	migrations, err := db.Query("SELECT version,checksum,success,description FROM _sqlx_migrations ORDER BY version")
	if err != nil {
		t.Fatal(err)
	}
	for migrations.Next() {
		value := new(pb.ExportMigration)
		if err = migrations.Scan(&value.Version, &value.Checksum, &value.Success, &value.Description); err != nil {
			t.Fatal(err)
		}
		manifest.Migrations = append(manifest.Migrations, value)
	}
	if err = migrations.Err(); err != nil {
		t.Fatal(err)
	}
	migrations.Close()
	rows, err := db.Query("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var name, statement string
		if err = rows.Scan(&name, &statement); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256([]byte(statement))
		manifest.Tables = append(manifest.Tables, &pb.ExportTable{Name: name, SchemaSha256: sum[:], Readable: true})
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	for _, table := range manifest.Tables {
		if err = db.QueryRow("SELECT count(*) FROM " + fixtureIdentifier(table.Name)).Scan(&table.RowCount); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"workspaces", "boards", "nodes", "terminal_sessions", "edges"} {
		set := &pb.ExportIdSet{Table: name}
		rows, err = db.Query("SELECT id FROM " + fixtureIdentifier(name) + " ORDER BY id")
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				t.Fatal(err)
			}
			set.Ids = append(set.Ids, id)
		}
		if err = rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		manifest.Identities = append(manifest.Identities, set)
	}
	rows, err = db.Query("SELECT id,workspace_id,whiteboard_json,kanban_json FROM boards ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		canvas := new(pb.ExportCanvas)
		var whiteboard, kanban string
		if err = rows.Scan(&canvas.CanvasId, &canvas.WorkspaceId, &whiteboard, &kanban); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256([]byte(whiteboard))
		canvas.WhiteboardSha256 = sum[:]
		canvas.WhiteboardBytes = uint64(len(whiteboard))
		canvas.KanbanJson = []byte(kanban)
		manifest.Canvases = append(manifest.Canvases, canvas)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	rows, err = db.Query("SELECT id,board_id,labels_json,note FROM nodes ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		annotation := new(pb.ExportNodeAnnotation)
		if err = rows.Scan(&annotation.NodeId, &annotation.CanvasId, &annotation.LabelsJson, &annotation.NoteUtf8); err != nil {
			t.Fatal(err)
		}
		manifest.Annotations = append(manifest.Annotations, annotation)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	sum := sha256.Sum256(fixtureAsset)
	manifest.Assets = []*pb.ExportAsset{{WorkspaceId: workspaceA, RelativePath: ".armadra/assets/proof.bin", BundlePath: "assets/proof.bin", Bytes: uint64(len(fixtureAsset)), Sha256: sum[:], Copied: true, ReferencedBy: []string{canvasA}}}
	return manifest
}

func writeFixtureManifest(t *testing.T, fixture *exportFixture) {
	t.Helper()
	data, err := os.ReadFile(fixture.snapshot)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	fixture.manifest.DatabaseSha256 = sum[:]
	fixture.manifest.DatabaseBytes = uint64(len(data))
	raw, err := proto.Marshal(fixture.manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(fixture.directory, "manifest.pb"), raw, 0600); err != nil {
		t.Fatal(err)
	}
}
func newImportStore(t *testing.T) *storage.Store {
	t.Helper()
	store, err := storage.Open(t.TempDir(), fixtureHost)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}
func allImportEvents(t *testing.T, store *storage.Store) []storage.Event {
	t.Helper()
	var cursor uint64
	var events []storage.Event
	for {
		page, err := store.GetEvents(fixtureContext, storage.EventQuery{After: cursor, Limit: 1000, ByteBudget: storage.MaxPageBytes})
		if err != nil || page.Status != storage.CursorOK {
			t.Fatalf("events: %+v %v", page, err)
		}
		events = append(events, page.Events...)
		if !page.HasMore {
			return events
		}
		cursor = page.NextCursor
	}
}
func importedRows(t *testing.T, events []storage.Event) map[string][]*pb.ImportedSqlRow {
	t.Helper()
	rows := map[string][]*pb.ImportedSqlRow{}
	for _, event := range events {
		if !strings.HasPrefix(event.Kind, "legacy.") {
			continue
		}
		row := new(pb.ImportedSqlRow)
		if err := proto.Unmarshal(event.Payload, row); err != nil {
			t.Fatal(err)
		}
		rows[row.Table] = append(rows[row.Table], row)
	}
	return rows
}
func column(row *pb.ImportedSqlRow, name string) *pb.ImportedSqlColumn {
	for _, column := range row.Columns {
		if column.Name == name {
			return column
		}
	}
	return nil
}
func rowWithID(t *testing.T, rows []*pb.ImportedSqlRow, id string) *pb.ImportedSqlRow {
	t.Helper()
	for _, row := range rows {
		if column(row, "id").GetTextValue() == id {
			return row
		}
	}
	t.Fatalf("missing imported id %s", id)
	return nil
}

// SQLite itself supplies an independent storage-class and literal-value oracle.
// In particular, expressions avoid driver TIMESTAMP-to-time.Time conversion.
func assertRowSQLValues(t *testing.T, source *sql.DB, row *pb.ImportedSqlRow, where string, args ...any) {
	t.Helper()
	columns, err := source.Query("PRAGMA table_info(" + fixtureIdentifier(row.Table) + ")")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for columns.Next() {
		var cid, notNull, pk int
		var name, typ string
		var def any
		if err = columns.Scan(&cid, &name, &typ, &notNull, &def, &pk); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	if err = columns.Err(); err != nil {
		t.Fatal(err)
	}
	columns.Close()
	if len(row.Columns) != len(names) {
		t.Fatalf("lost columns for %s", row.Table)
	}
	for _, name := range names {
		value := column(row, name)
		if value == nil {
			t.Fatalf("lost column %s.%s", row.Table, name)
		}
		var scalar any
		switch typed := value.Value.(type) {
		case *pb.ImportedSqlColumn_NullValue:
			scalar = nil
		case *pb.ImportedSqlColumn_TextValue:
			scalar = typed.TextValue
		case *pb.ImportedSqlColumn_IntegerValue:
			scalar = typed.IntegerValue
		case *pb.ImportedSqlColumn_RealValue:
			scalar = typed.RealValue
		case *pb.ImportedSqlColumn_BlobValue:
			scalar = typed.BlobValue
		default:
			t.Fatalf("missing typed SQL value %s", name)
		}
		var wantType, wantLiteral, gotType, gotLiteral string
		if err = source.QueryRow("SELECT typeof("+fixtureIdentifier(name)+"),quote("+fixtureIdentifier(name)+") FROM "+fixtureIdentifier(row.Table)+" WHERE "+where, args...).Scan(&wantType, &wantLiteral); err != nil {
			t.Fatal(err)
		}
		if err = source.QueryRow("SELECT typeof(?),quote(?)", scalar, scalar).Scan(&gotType, &gotLiteral); err != nil {
			t.Fatal(err)
		}
		if wantType != gotType || wantLiteral != gotLiteral {
			t.Fatalf("changed %s.%s: source(%s,%s), imported(%s,%s)", row.Table, name, wantType, wantLiteral, gotType, gotLiteral)
		}
	}
}

func TestInspectAndStagePreserveRawSQLValuesAndIsolation(t *testing.T) {
	fixture := newExportFixture(t, 4, 300)
	originalBefore, _ := os.ReadFile(fixture.original)
	snapshotBefore, _ := os.ReadFile(fixture.snapshot)
	bundle, err := Inspect(fixtureContext, fixture.directory)
	if err != nil {
		t.Fatal(err)
	}
	store := newImportStore(t)
	report, err := Stage(fixtureContext, store, bundle)
	if err != nil {
		t.Fatal(err)
	}
	if report.State != "staged" || report.HostId != fixtureHost || report.ImportId != hex.EncodeToString(bundle.Digest[:]) {
		t.Fatalf("invalid stage report %+v", report)
	}
	stage, err := store.GetStaging(fixtureContext, report.ImportId)
	if err != nil || stage.Active {
		t.Fatal("staging was activated")
	}
	events := allImportEvents(t, store)
	rows := importedRows(t, events)
	var expected uint64
	for _, table := range fixture.manifest.Tables {
		expected += table.RowCount
		if uint64(len(rows[table.Name])) != table.RowCount {
			t.Fatalf("row count changed for %s", table.Name)
		}
	}
	if report.EntityCount != expected || len(events) != int(expected)+1 {
		t.Fatal("rows or completion event missing")
	}
	transactions := map[uint64]bool{}
	for _, event := range events {
		transactions[event.TransactionID] = true
		if event.Kind != "migration.report" && (!strings.HasPrefix(event.Kind, "legacy.") || !strings.HasPrefix(event.ID, report.ImportId+".")) {
			t.Fatal("legacy row escaped its isolated namespace")
		}
	}
	if len(transactions) < 3 {
		t.Fatal("fixture did not exercise multiple data batches plus completion")
	}
	source := fixtureSQL(t, fixture.snapshot)
	defer source.Close()
	n := rowWithID(t, rows["nodes"], nodeA)
	assertRowSQLValues(t, source, n, "id=?", nodeA)
	if column(n, "width").GetNullValue() == nil || column(n, "x").GetRealValue() != 123.25 || column(n, "note").GetTextValue() != noteText || column(n, "labels_json").GetTextValue() != labelsText {
		t.Fatal("node types/annotations were changed")
	}
	b := rowWithID(t, rows["boards"], canvasA)
	assertRowSQLValues(t, source, b, "id=?", canvasA)
	if column(b, "whiteboard_json").GetTextValue() != whiteboardText || column(b, "kanban_json").GetTextValue() != kanbanText {
		t.Fatal("canvas archive changed")
	}
	if len(rows["legacy_kanban_archives"]) != 2 || len(rows["legacy_node_label_archives"]) != 3 {
		t.Fatal("retirement archives were not imported")
	}
	for _, archived := range rows["legacy_kanban_archives"] {
		if column(archived, "kanban_json").GetTextValue() != kanbanText {
			t.Fatal("raw historical board changed")
		}
		assertRowSQLValues(t, source, archived, "canvas_id=?", column(archived, "canvas_id").GetTextValue())
	}
	for _, archived := range rows["legacy_node_label_archives"] {
		assertRowSQLValues(t, source, archived, "node_id=?", column(archived, "node_id").GetTextValue())
	}
	for _, m := range rows["_sqlx_migrations"] {
		version := column(m, "version").GetIntegerValue()
		assertRowSQLValues(t, source, m, "version=?", version)
		if column(m, "installed_on").GetTextValue() != timestampText || column(m, "execution_time").GetIntegerValue() != largeInteger+version-1 || len(column(m, "checksum").GetBlobValue()) != 48 {
			t.Fatal("TIMESTAMP/int64/blob fidelity lost")
		}
	}
	assertRowSQLValues(t, source, rowWithID(t, rows["terminal_sessions"], terminalA), "id=?", terminalA)
	assertRowSQLValues(t, source, rowWithID(t, rows["terminal_logs"], "log-0000"), "id=?", "log-0000")
	for _, event := range events {
		if event.Kind == "legacy.nodes" || event.Kind == "legacy.edges" || event.Kind == "legacy.terminal_logs" {
			row := new(pb.ImportedSqlRow)
			proto.Unmarshal(event.Payload, row)
			want := workspaceA
			if column(row, "id").GetTextValue() == nodeC {
				want = workspaceB
			}
			if event.WorkspaceID != want {
				t.Fatalf("workspace provenance missing for %s: got %q want %q", event.Kind, event.WorkspaceID, want)
			}
		}
	}
	active, err := store.List(fixtureContext, storage.ListOptions{WorkspaceID: workspaceA, Kind: "canvas.node"})
	if err != nil || len(active.Entities) != 0 {
		t.Fatal("staged data became active business entities")
	}
	asset, _ := os.ReadFile(filepath.Join(filepath.Dir(store.Path()), filepath.FromSlash(stage.RelativePath), "assets", "proof.bin"))
	if !bytes.Equal(asset, fixtureAsset) {
		t.Fatal("asset copy changed")
	}
	second, err := Stage(fixtureContext, store, bundle)
	if err != nil || !proto.Equal(report, second) {
		t.Fatalf("replay report differs: %v", err)
	}
	if !reflect.DeepEqual(events, allImportEvents(t, store)) {
		t.Fatal("replayed import added rows/events")
	}
	originalAfter, _ := os.ReadFile(fixture.original)
	snapshotAfter, _ := os.ReadFile(fixture.snapshot)
	if !bytes.Equal(originalBefore, originalAfter) || !bytes.Equal(snapshotBefore, snapshotAfter) {
		t.Fatal("source database was changed")
	}
}

func TestPartialBatchesResumeWithoutDuplicatesOrActivation(t *testing.T) {
	fixture := newExportFixture(t, 2, 300)
	bundle, err := Inspect(fixtureContext, fixture.directory)
	if err != nil {
		t.Fatal(err)
	}
	store := newImportStore(t)
	control := fixtureSQL(t, store.Path())
	defer control.Close()
	// Fault injection at completion, after earlier entity batches committed.
	fixtureExec(t, control, `CREATE TRIGGER test_completion_failure BEFORE INSERT ON operations WHEN NEW.operation_id LIKE 'migration/%/complete' BEGIN SELECT RAISE(ABORT,'injected completion failure'); END`)
	_, err = Stage(fixtureContext, store, bundle)
	if err == nil || !strings.Contains(err.Error(), "injected completion failure") {
		t.Fatalf("did not reach injected failure: %v", err)
	}
	before := allImportEvents(t, store)
	if len(before) <= storage.MaxChanges {
		t.Fatal("no committed partial batches to resume")
	}
	id := hex.EncodeToString(bundle.Digest[:])
	stage, err := store.GetStaging(fixtureContext, id)
	if err != nil || stage.Active {
		t.Fatal("partial import activated")
	}
	if _, err = store.Read(fixtureContext, storage.Key{Kind: "migration.report", ID: id}); !errors.Is(err, storage.ErrNotFound) {
		t.Fatal("failed completion report committed")
	}
	fixtureExec(t, control, "DROP TRIGGER test_completion_failure")
	report, err := Stage(fixtureContext, store, bundle)
	if err != nil {
		t.Fatal(err)
	}
	after := allImportEvents(t, store)
	if len(after) != len(before)+1 || !reflect.DeepEqual(before, after[:len(before)]) || report.EntityCount != uint64(len(before)) {
		t.Fatal("resume repeated data writes or lost a prior batch")
	}
	if after[len(after)-1].Kind != "migration.report" {
		t.Fatal("completion missing")
	}
}

func TestInspectRejectsTamperedManifestData(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*pb.MigrationExportManifest)
	}{
		{"format", func(m *pb.MigrationExportManifest) { m.FormatVersion = 2 }},
		{"ownership", func(m *pb.MigrationExportManifest) { m.OwnershipSwitchAllowed = true }},
		{"migration checksum", func(m *pb.MigrationExportManifest) { m.Migrations[0].Checksum = make([]byte, 48) }},
		{"table schema", func(m *pb.MigrationExportManifest) { m.Tables[0].SchemaSha256 = make([]byte, 32) }},
		{"row count", func(m *pb.MigrationExportManifest) { m.Tables[0].RowCount++ }},
		{"identity", func(m *pb.MigrationExportManifest) { m.Identities[0].Ids[0] = "wrong-id" }},
		{"whiteboard", func(m *pb.MigrationExportManifest) { m.Canvases[0].WhiteboardSha256 = make([]byte, 32) }},
		{"whiteboard byte count", func(m *pb.MigrationExportManifest) { m.Canvases[0].WhiteboardBytes++ }},
		{"compatibility archive", func(m *pb.MigrationExportManifest) { m.Canvases[0].KanbanJson = []byte("{}") }},
		{"note", func(m *pb.MigrationExportManifest) { m.Annotations[0].NoteUtf8 = []byte("changed") }},
		{"labels", func(m *pb.MigrationExportManifest) { m.Annotations[0].LabelsJson = []byte("[]") }},
		{"asset hash", func(m *pb.MigrationExportManifest) { m.Assets[0].Sha256 = make([]byte, 32) }},
		{"asset length", func(m *pb.MigrationExportManifest) { m.Assets[0].Bytes++ }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			fixture := newExportFixture(t, 2, 0)
			test.mutate(fixture.manifest)
			writeFixtureManifest(t, fixture)
			before, _ := os.ReadFile(fixture.snapshot)
			if _, err := Inspect(fixtureContext, fixture.directory); err == nil {
				t.Fatal("accepted modified manifest")
			}
			after, _ := os.ReadFile(fixture.snapshot)
			if !bytes.Equal(before, after) {
				t.Fatal("modified source on rejection")
			}
		})
	}
}

func TestInspectRejectsChangedFilesAndUnverifiedJournals(t *testing.T) {
	for _, name := range []string{"manifest.pb", "source.sqlite", "assets/proof.bin", "source.sqlite-wal", "source.sqlite-shm", "source.sqlite-journal"} {
		t.Run(name, func(t *testing.T) {
			fixture := newExportFixture(t, 2, 0)
			path := filepath.Join(fixture.directory, filepath.FromSlash(name))
			if err := os.WriteFile(path, []byte("changed or unverified"), 0600); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(path)
			if _, err := Inspect(fixtureContext, fixture.directory); err == nil {
				t.Fatalf("accepted %s", name)
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(before, after) {
				t.Fatal("rejection changed input file")
			}
		})
	}
}

func TestInspectRejectsUnknownSchemaEvenWithFreshManifestHashes(t *testing.T) {
	for _, statement := range []string{"ALTER TABLE nodes ADD COLUMN extra TEXT", "ALTER TABLE _sqlx_migrations ADD COLUMN extra TEXT", "ALTER TABLE _sqlx_migrations ADD COLUMN hidden_payload TEXT GENERATED ALWAYS AS ('shadow') VIRTUAL", "CREATE TABLE unexpected(value TEXT)"} {
		t.Run(statement, func(t *testing.T) {
			fixture := newExportFixture(t, 2, 0)
			db := fixtureSQL(t, fixture.snapshot)
			fixtureExec(t, db, statement)
			db.Close()
			fixture.manifest = fixtureManifest(t, fixture)
			writeFixtureManifest(t, fixture)
			before, _ := os.ReadFile(fixture.snapshot)
			if _, err := Inspect(fixtureContext, fixture.directory); err == nil {
				t.Fatal("accepted unknown schema after manifest was rehashed")
			}
			after, _ := os.ReadFile(fixture.snapshot)
			if !bytes.Equal(before, after) {
				t.Fatal("unknown schema was changed")
			}
		})
	}
}

func TestInspectRejectsAssetTraversalAndSourceSymlinks(t *testing.T) {
	for _, path := range []string{"../outside.bin", "assets/../../outside.bin", "/absolute/proof.bin", "assets/a/../proof.bin", "assets/proof:stream.bin"} {
		t.Run(path, func(t *testing.T) {
			fixture := newExportFixture(t, 2, 0)
			if strings.Contains(path, ":") {
				if err := os.WriteFile(filepath.Join(fixture.directory, filepath.FromSlash(path)), fixtureAsset, 0600); err != nil {
					t.Skipf("colon filename unavailable: %v", err)
				}
			}
			fixture.manifest.Assets[0].BundlePath = path
			writeFixtureManifest(t, fixture)
			if _, err := Inspect(fixtureContext, fixture.directory); err == nil {
				t.Fatal("accepted unsafe asset path")
			}
		})
	}
	fixture := newExportFixture(t, 2, 0)
	asset := filepath.Join(fixture.directory, "assets", "proof.bin")
	outside := filepath.Join(t.TempDir(), "outside.bin")
	if err := os.WriteFile(outside, fixtureAsset, 0600); err != nil {
		t.Fatal(err)
	}
	os.Remove(asset)
	if err := os.Symlink(outside, asset); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := Inspect(fixtureContext, fixture.directory); err == nil {
		t.Fatal("followed a source asset symlink")
	}
}

func TestStageRejectsExistingTargetWithoutReplacingIt(t *testing.T) {
	for _, kind := range []string{"different-file", "matching-file-symlink", "directory-symlink"} {
		t.Run(kind, func(t *testing.T) {
			fixture := newExportFixture(t, 2, 0)
			bundle, err := Inspect(fixtureContext, fixture.directory)
			if err != nil {
				t.Fatal(err)
			}
			store := newImportStore(t)
			base := filepath.Join(filepath.Dir(store.Path()), "migration-imports")
			if err = os.Mkdir(base, 0700); err != nil {
				t.Fatal(err)
			}
			destination := filepath.Join(base, hex.EncodeToString(bundle.Digest[:]))
			outside := t.TempDir()
			target := filepath.Join(destination, "source.sqlite")
			var protected string
			if kind == "directory-symlink" {
				protected = filepath.Join(outside, "source.sqlite")
				if err = os.WriteFile(protected, []byte("keep outside"), 0600); err != nil {
					t.Fatal(err)
				}
				if err = os.Symlink(outside, destination); err != nil {
					t.Skipf("symlink unavailable: %v", err)
				}
			} else {
				if err = os.Mkdir(destination, 0700); err != nil {
					t.Fatal(err)
				}
				if kind == "different-file" {
					protected = target
					if err = os.WriteFile(target, []byte("keep existing target"), 0600); err != nil {
						t.Fatal(err)
					}
				} else {
					protected = filepath.Join(outside, "same-snapshot")
					data, _ := os.ReadFile(fixture.snapshot)
					if err = os.WriteFile(protected, data, 0600); err != nil {
						t.Fatal(err)
					}
					if err = os.Symlink(protected, target); err != nil {
						t.Skipf("symlink unavailable: %v", err)
					}
				}
			}
			before, _ := os.ReadFile(protected)
			if _, err = Stage(fixtureContext, store, bundle); err == nil {
				t.Fatal("accepted unsafe preexisting target")
			}
			after, _ := os.ReadFile(protected)
			if !bytes.Equal(before, after) {
				t.Fatal("existing target was overwritten")
			}
			if len(allImportEvents(t, store)) != 0 {
				t.Fatal("published rows after artifact rejection")
			}
		})
	}
}

func TestOlderExportAndMissingAssetsRemainExplicitlyInactive(t *testing.T) {
	fixture := newExportFixture(t, 1, 0)
	fixture.manifest.AssetsComplete = false
	fixture.manifest.Assets[0].Copied = false
	fixture.manifest.Issues = []*pb.ExportIssue{{Code: "asset_missing", Severity: "error", Entity: canvasA, Detail: "source asset unavailable"}}
	writeFixtureManifest(t, fixture)
	os.Remove(filepath.Join(fixture.directory, "assets", "proof.bin"))
	bundle, err := Inspect(fixtureContext, fixture.directory)
	if err != nil {
		t.Fatal(err)
	}
	store := newImportStore(t)
	report, err := Stage(fixtureContext, store, bundle)
	if err != nil {
		t.Fatal(err)
	}
	codes := []string{}
	for _, issue := range report.Issues {
		codes = append(codes, issue.Code)
	}
	sort.Strings(codes)
	if report.State != "staged" || !reflect.DeepEqual(codes, []string{"asset_missing", "assets_incomplete"}) {
		t.Fatalf("missing assets hidden: %+v", report)
	}
	stage, err := store.GetStaging(fixtureContext, report.ImportId)
	if err != nil || stage.Active {
		t.Fatal("missing-asset import activated")
	}
}

func TestInspectRejectsNonCanonicalLedgerSuccess(t *testing.T) {
	for _, value := range []any{int64(2), "true"} {
		t.Run(fmt.Sprint(value), func(t *testing.T) {
			fixture := newExportFixture(t, 2, 0)
			db := fixtureSQL(t, fixture.snapshot)
			fixtureExec(t, db, "UPDATE _sqlx_migrations SET success=? WHERE version=1", value)
			db.Close()
			// The producer's boolean field cannot represent the noncanonical SQL value.
			// A forgiving driver must not normalize it into an accepted INTEGER 1.
			writeFixtureManifest(t, fixture)
			if _, err := Inspect(fixtureContext, fixture.directory); err == nil {
				t.Fatal("normalized noncanonical ledger success into a valid migration")
			}
		})
	}
}
