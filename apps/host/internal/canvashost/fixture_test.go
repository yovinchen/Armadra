package canvashost

import (
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/migration"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"

	_ "modernc.org/sqlite"
)

// A real Runtime export, built from the Runtime's own numbered migrations and
// carrying the content C02 names: tldraw drawings, an image asset, nested
// frames, context links and a whiteboard snapshot. The tests below migrate it
// into the Host and then compare every one of those item by item.
const (
	fixtureHost = "0123456789abcdef0123456789abcdef"
	workspaceID = "019ff7d1-0d12-7421-833d-2c5e8d64ee01"
	canvasID    = "019ff7d1-0d12-7421-833d-2c5e8d64ee11"
	outerFrame  = "019ff7d1-0d12-7421-833d-2c5e8d64ee21"
	innerFrame  = "019ff7d1-0d12-7421-833d-2c5e8d64ee22"
	terminalID  = "019ff7d1-0d12-7421-833d-2c5e8d64ee23"
	stickyID    = "019ff7d1-0d12-7421-833d-2c5e8d64ee24"
	imageID     = "019ff7d1-0d12-7421-833d-2c5e8d64ee25"
	sessionID   = "019ff7d1-0d12-7421-833d-2c5e8d64ee31"
	linkID      = "019ff7d1-0d12-7421-833d-2c5e8d64ee41"

	fixtureTime = "2026-09-05T01:02:03.004+08:00"

	// A whiteboard snapshot with real tldraw-shaped records: freehand ink, a
	// geometric shape, text and a managed image asset. Nothing decodes it; the
	// test asserts the bytes and the digest arrive unchanged.
	whiteboardJSON = `{"schemaVersion":2,"records":[` +
		`{"id":"shape:draw1","typeName":"shape","type":"draw","x":12.5,"y":-4.25,"props":{"segments":[{"type":"free","points":[{"x":0,"y":0},{"x":3.5,"y":9.75}]}]}},` +
		`{"id":"shape:geo1","typeName":"shape","type":"geo","x":100,"y":200,"props":{"geo":"rectangle","w":64,"h":32,"text":"几何 📐"}},` +
		`{"id":"shape:text1","typeName":"shape","type":"text","props":{"text":"手写文字 note"}},` +
		`{"id":"asset:image1","typeName":"asset","type":"image","meta":{"armadra":{"path":".armadra/assets/proof.png"}},"props":{"src":".armadra/assets/proof.png","w":8,"h":8}}]}`

	stickyLabels = `["需要复核","中文"]`
	stickyNote   = "Keep exact whitespace.\n第二行 'quote'."
	imageData    = `{"kind":"files","preview":{"path":".armadra/assets/proof.png"}}`
)

var fixtureContext = context.Background()

// Deliberately not a valid PNG: the migration compares digests, and inventing
// a real image would only make the fixture larger without testing more.
var fixtureAsset = []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff}

type fixture struct {
	t         *testing.T
	dir       string
	store     *storage.Store
	service   *Service
	bundle    string
	importID  string
	manifest  *pb.MigrationExportManifest
	clock     time.Time
	assetPath string
}

func openFixtureSQL(t *testing.T, path, mode string) *sql.DB {
	t.Helper()
	uri, err := storage.SQLiteReadOnlyURI(path)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(uri)
	if err != nil {
		t.Fatal(err)
	}
	parsed.RawQuery = url.Values{"mode": {mode}, "_pragma": {"foreign_keys(1)", "busy_timeout(5000)"}}.Encode()
	db, err := sql.Open("sqlite", parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	return db
}

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.ExecContext(fixtureContext, query, args...); err != nil {
		t.Fatalf("%v: %s", err, query)
	}
}

func quoteName(value string) string { return `"` + strings.ReplaceAll(value, `"`, `""`) + `"` }

// buildExport writes a Runtime-shaped database and its export package. The
// migrations applied are the Runtime's own files, so the importer validates a
// real ledger rather than a schema this test invented.
func buildExport(t *testing.T, root string) (string, *pb.MigrationExportManifest) {
	t.Helper()
	bundle := filepath.Join(root, "export")
	if err := os.Mkdir(bundle, 0700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "canvas.db")
	db := openFixtureSQL(t, source, "rwc")
	mustExec(t, db, `CREATE TABLE _sqlx_migrations (
 version BIGINT PRIMARY KEY, description TEXT NOT NULL,
 installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)`)
	names := []string{
		"0001_initial.sql", "0002_agent_mailbox.sql", "0003_retire_kanban.sql",
		"0004_agent_handoffs.sql", "0005_browser_sessions.sql", "0006_agent_prompt_deliveries.sql",
		"0007_handoff_attempts.sql", "0008_write_ownership.sql", "0009_workspace_execution_host.sql",
	}
	descriptions := []string{"initial", "agent mailbox", "retire kanban", "agent handoffs", "browser sessions", "agent prompt deliveries", "handoff attempts", "write ownership", "workspace execution host"}
	for index, name := range names {
		statements, err := os.ReadFile(filepath.Join("..", "migration", "legacy", name))
		if err != nil {
			t.Fatal(err)
		}
		mustExec(t, db, string(statements))
		checksum := sha512.Sum384(statements)
		mustExec(t, db, "INSERT INTO _sqlx_migrations(version,description,installed_on,success,checksum,execution_time) VALUES(?,?,?,1,?,?)", index+1, descriptions[index], fixtureTime, checksum[:], int64(index+1))
	}
	mustExec(t, db, "INSERT INTO workspaces(id,name,root_path,color,created_at,updated_at,last_opened_at) VALUES(?,?,?,?,?,?,?)",
		workspaceID, "原始项目 📦", "/原始/项目", "#5B5BD6", fixtureTime, fixtureTime, fixtureTime)
	mustExec(t, db, "INSERT INTO boards(id,workspace_id,name,sort_order,viewport_json,whiteboard_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
		canvasID, workspaceID, "默认画布", 7, `{"x":-12.5,"y":4.25,"zoom":1.5}`, whiteboardJSON, fixtureTime, fixtureTime)
	// Nested frames: inner sits inside outer, and both terminal and sticky sit
	// inside the inner one. The migration has to keep all three levels.
	nodes := []struct {
		id, kind, parent, labels, note, data string
		width, height                        any
		collapsed                            int
	}{
		{outerFrame, "group", "", "[]", "", `{"kind":"group"}`, 800.0, 600.0, 0},
		{innerFrame, "group", outerFrame, "[]", "", `{"kind":"group"}`, 400.0, 300.0, 0},
		{terminalID, "terminal", innerFrame, "[]", "", `{"kind":"terminal","sessionId":"` + sessionID + `"}`, nil, nil, 1},
		{stickyID, "sticky", innerFrame, stickyLabels, stickyNote, `{"kind":"sticky","content":"原始正文"}`, 240.0, 180.0, 0},
		{imageID, "files", outerFrame, "[]", "", imageData, nil, 240.0, 0},
	}
	for index, node := range nodes {
		mustExec(t, db, "INSERT INTO nodes(id,board_id,type,x,y,width,height,title,color,collapsed,expanded_height,parent_id,labels_json,note,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			node.id, canvasID, node.kind, float64(index)*10.5, -float64(index)*3.25, node.width, node.height,
			"节点 "+node.kind, "#0a84ff", node.collapsed, nil, nullable(node.parent), node.labels, node.note, node.data, fixtureTime, fixtureTime)
	}
	mustExec(t, db, "INSERT INTO edges(id,board_id,source_node_id,target_node_id,kind,created_at,updated_at) VALUES(?,?,?,?,'link',?,?)",
		linkID, canvasID, terminalID, stickyID, fixtureTime, fixtureTime)
	mustExec(t, db, "INSERT INTO terminal_sessions(id,workspace_id,owner_node_id,session_key,cwd,shell,status,generation,created_at) VALUES(?,?,?,?,?,'/bin/sh','running',3,?)",
		sessionID, workspaceID, terminalID, terminalID, "/原始/项目", fixtureTime)

	snapshot := filepath.Join(bundle, "source.sqlite")
	mustExec(t, db, "VACUUM INTO ?", snapshot)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(bundle, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bundle, "assets", "proof.png"), fixtureAsset, 0600); err != nil {
		t.Fatal(err)
	}
	manifest := buildManifest(t, snapshot)
	raw, err := proto.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(bundle, "manifest.pb"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	return bundle, manifest
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func buildManifest(t *testing.T, snapshot string) *pb.MigrationExportManifest {
	t.Helper()
	db := openFixtureSQL(t, snapshot, "ro")
	defer db.Close()
	manifest := &pb.MigrationExportManifest{
		FormatVersion:    1,
		ExportId:         "canvas-fixture-export",
		ExportedAtUnixMs: 1788560523004,
		ProducerVersion:  "0.1.0-test",
		DatabaseFile:     "source.sqlite",
		AssetsComplete:   true,
	}
	rows, err := db.Query("SELECT version,checksum,success,description FROM _sqlx_migrations ORDER BY version")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		value := new(pb.ExportMigration)
		if err = rows.Scan(&value.Version, &value.Checksum, &value.Success, &value.Description); err != nil {
			t.Fatal(err)
		}
		manifest.Migrations = append(manifest.Migrations, value)
	}
	rows.Close()
	rows, err = db.Query("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
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
	rows.Close()
	for _, table := range manifest.Tables {
		if err = db.QueryRow("SELECT count(*) FROM " + quoteName(table.Name)).Scan(&table.RowCount); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"workspaces", "boards", "nodes", "terminal_sessions", "edges"} {
		set := &pb.ExportIdSet{Table: name}
		ids, err := db.Query("SELECT id FROM " + quoteName(name) + " ORDER BY id")
		if err != nil {
			t.Fatal(err)
		}
		for ids.Next() {
			var id string
			if err = ids.Scan(&id); err != nil {
				t.Fatal(err)
			}
			set.Ids = append(set.Ids, id)
		}
		ids.Close()
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
	rows.Close()
	sum := sha256.Sum256(fixtureAsset)
	manifest.Assets = []*pb.ExportAsset{{
		WorkspaceId:  workspaceID,
		RelativePath: ".armadra/assets/proof.png",
		BundlePath:   "assets/proof.png",
		Bytes:        uint64(len(fixtureAsset)),
		Sha256:       sum[:],
		Copied:       true,
		// Both a node payload and the whiteboard snapshot name this file, which
		// is what a real export of an image dropped on the canvas produces.
		ReferencedBy: []string{"boards/" + canvasID + "/whiteboard_json", "nodes/" + imageID + "/data_json"},
	}}
	data, err := os.ReadFile(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	manifest.DatabaseSha256 = digest[:]
	manifest.DatabaseBytes = uint64(len(data))
	return manifest
}

// newFixture builds the export, stages it into a fresh Host and returns the
// assembled canvas service. Nothing here moves ownership.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	root := t.TempDir()
	bundle, manifest := buildExport(t, root)
	dataDir := filepath.Join(root, "host")
	if err := os.Mkdir(dataDir, 0700); err != nil {
		t.Fatal(err)
	}
	store, err := storage.Open(dataDir, fixtureHost)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	clock := time.UnixMilli(1788560523004)
	service, err := New(Options{Store: store, HostID: fixtureHost, Now: func() time.Time { return clock }})
	if err != nil {
		t.Fatal(err)
	}
	result := &fixture{t: t, dir: dataDir, store: store, service: service, bundle: bundle, manifest: manifest, clock: clock, assetPath: filepath.Join(bundle, "assets", "proof.png")}
	return result
}

// stage runs the real inspect/stage path, exactly as `armadra-host import`.
func (f *fixture) stage() string {
	f.t.Helper()
	inspected, err := migration.Inspect(fixtureContext, f.bundle)
	if err != nil {
		f.t.Fatal(err)
	}
	report, err := migration.Stage(fixtureContext, f.store, inspected)
	if err != nil {
		f.t.Fatal(err)
	}
	f.importID = report.ImportId
	return report.ImportId
}

func (f *fixture) caller(permissions ...string) Caller {
	scopes := make([]auth.Scope, 0, len(permissions))
	for _, permission := range permissions {
		scopes = append(scopes, auth.Scope{Permission: permission, WorkspaceID: workspaceID, ExecutionHostID: fixtureHost})
	}
	return Caller{PrincipalID: "principal-1", DeviceID: "device-1", DeviceEpoch: 1, WorkspaceID: workspaceID, Scopes: scopes}
}

// fakeRuntime stands in for the Rust Runtime's stored ownership row. It
// enforces the same rules the Runtime does — monotonic epoch, CAS on the
// expected epoch — so the Host's state machine is exercised against a peer that
// refuses the same requests a real one would.
type fakeRuntime struct {
	owner    pb.CanvasOwnershipOwner
	epoch    uint64
	reason   string
	setErr   error
	getErr   error
	setCalls int
	getCalls int
	// applyBeforeError stores the request even when the reply is reported as
	// lost, which is the case a resumed switch has to converge on.
	applyBeforeError bool
}

func newFakeRuntime() *fakeRuntime {
	return &fakeRuntime{owner: pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME, epoch: 1, reason: "ownership.initial"}
}

func (f *fakeRuntime) GetWriteOwnership(context.Context, string) (*pb.WorkerWriteOwnership, error) {
	f.getCalls++
	if f.getErr != nil {
		return nil, f.getErr
	}
	return &pb.WorkerWriteOwnership{Domain: storage.OwnershipDomainCanvas, Owner: f.owner, Epoch: f.epoch, ReasonCode: f.reason, UpdatedAtUnixMs: 1788560523004}, nil
}

func (f *fakeRuntime) SetWriteOwnership(_ context.Context, domain string, owner pb.CanvasOwnershipOwner, epoch, expected uint64, reason string) (*pb.WorkerWriteOwnership, error) {
	f.setCalls++
	if domain != storage.OwnershipDomainCanvas {
		return nil, errors.New("unsupported domain")
	}
	if f.setErr != nil {
		if f.applyBeforeError {
			f.owner, f.epoch, f.reason = owner, epoch, reason
		}
		return nil, f.setErr
	}
	if owner == f.owner && epoch == f.epoch {
		return &pb.WorkerWriteOwnership{Domain: domain, Owner: f.owner, Epoch: f.epoch, ReasonCode: f.reason}, nil
	}
	if expected != f.epoch || epoch <= f.epoch {
		return nil, errors.New("stale ownership epoch")
	}
	f.owner, f.epoch, f.reason = owner, epoch, reason
	return &pb.WorkerWriteOwnership{Domain: domain, Owner: f.owner, Epoch: f.epoch, ReasonCode: f.reason}, nil
}
