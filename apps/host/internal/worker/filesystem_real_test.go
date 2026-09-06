package worker

import (
	"context"
	"crypto/sha512"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// The filesystem read against a real Rust Runtime
// (Go Host 业务所有权迁移 §2.9, action 26).
//
// Every other test of this frame talks to a fake, which proves the Go client
// and nothing about whether the two sides agree on what a workspace root is.
// This one runs the real binary over the real Worker channel and asserts the
// thing that cannot be faked: the rows the Runtime reports are the rows the
// Runtime has, with the execution host and the three permission bits intact.
//
// It matters because a handback is verified against exactly this answer. A
// Runtime that reported permissions it did not hold would let a rollback be
// declared successful while a workspace was left open or closed wrongly.
//
// Opt-in: ARMADRA_TEST_REAL_WORKER must name an already built native Runtime,
// so an ordinary `go test ./...` needs no Rust toolchain.
func TestRealRustWorkerReportsItsWorkspaceRoots(t *testing.T) {
	executable := os.Getenv("ARMADRA_TEST_REAL_WORKER")
	if executable == "" {
		t.Skip("set ARMADRA_TEST_REAL_WORKER to an existing native Runtime binary")
	}
	database := filepath.Join(t.TempDir(), "canvas.db")
	buildRuntimeDatabase(t, database)

	client, err := Start(context.Background(), Options{
		Executable: executable, HostID: fixtureHost, CanvasDatabase: database,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if !client.SupportsFilesystem() {
		t.Fatal("the real Runtime does not advertise the filesystem capability")
	}
	roots, err := client.WorkspaceRoots(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 2 {
		t.Fatalf("the Runtime reported %d roots, expected 2", len(roots))
	}
	byID := map[string]int{}
	for index, root := range roots {
		byID[root.GetWorkspaceId()] = index
	}
	local := roots[byID["workspace-local"]]
	if local.GetCanonicalPath() != "/原始/项目" || local.GetExecutionHostId() != "" {
		t.Fatalf("the local root is not the stored one: %+v", local)
	}
	if !local.GetPermissions().GetRead() || !local.GetPermissions().GetWrite() || local.GetPermissions().GetExecute() {
		t.Fatalf("the local permissions are not the stored ones: %+v", local.GetPermissions())
	}
	remote := roots[byID["workspace-remote"]]
	if remote.GetCanonicalPath() != "/srv/项目" || remote.GetExecutionHostId() != "构建机" {
		t.Fatalf("the remote root is not the stored one: %+v", remote)
	}
	if !remote.GetPermissions().GetRead() || remote.GetPermissions().GetWrite() {
		t.Fatalf("the remote permissions are not the stored ones: %+v", remote.GetPermissions())
	}
	// The Host's own facts are never invented by the Runtime: a revision, a
	// registration proof and a registration time it has nowhere to store come
	// back empty rather than filled in with something plausible.
	for _, root := range roots {
		if root.GetRevision() != 0 || len(root.GetProofSha256()) != 0 || root.GetRegisteredAtUnixMs() != 0 {
			t.Fatalf("the Runtime invented a Host-side fact: %+v", root)
		}
	}
	t.Logf("verified native Rust Worker filesystem frame: %d roots, execution hosts and permissions intact", len(roots))
}

// buildRuntimeDatabase writes a Runtime-shaped database from the Runtime's own
// numbered migrations, so the Worker validates a real ledger rather than a
// schema this test invented.
func buildRuntimeDatabase(t *testing.T, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)&mode=rwc")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec := func(statements string, args ...any) {
		t.Helper()
		if _, err := db.Exec(statements, args...); err != nil {
			t.Fatalf("%v: %s", err, statements)
		}
	}
	exec(`CREATE TABLE _sqlx_migrations (
 version BIGINT PRIMARY KEY, description TEXT NOT NULL,
 installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)`)
	names := []string{
		"0001_initial.sql", "0002_agent_mailbox.sql", "0003_retire_kanban.sql",
		"0004_agent_handoffs.sql", "0005_browser_sessions.sql", "0006_agent_prompt_deliveries.sql",
		"0007_handoff_attempts.sql", "0008_write_ownership.sql", "0009_workspace_execution_host.sql",
		"0010_host_imports.sql", "0011_domain_ownership.sql",
	}
	for index, name := range names {
		statements, err := os.ReadFile(filepath.Join("..", "migration", "legacy", name))
		if err != nil {
			t.Fatal(err)
		}
		exec(string(statements))
		checksum := sha512.Sum384(statements)
		exec("INSERT INTO _sqlx_migrations(version,description,installed_on,success,checksum,execution_time) VALUES(?,?,'2026-09-01T10:00:00Z',1,?,?)", index+1, name, checksum[:], int64(index+1))
	}
	exec("INSERT INTO workspaces(id,name,root_path,color,permissions_json,created_at,updated_at,last_opened_at) VALUES(?,?,?,?,?,?,?,?)",
		"workspace-local", "本地", "/原始/项目", "#5B5BD6", `{"read":true,"write":true,"execute":false}`,
		"2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z")
	exec("INSERT INTO workspaces(id,name,root_path,color,permissions_json,execution_host_id,created_at,updated_at,last_opened_at) VALUES(?,?,?,?,?,?,?,?,?)",
		"workspace-remote", "远端", "/srv/项目", "#5B5BD6", `{"read":true,"write":false,"execute":false}`, "构建机",
		"2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z")
}
