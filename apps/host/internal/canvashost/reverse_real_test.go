package canvashost

import (
	"context"
	"crypto/sha512"
	"os"
	"path/filepath"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/worker"
)

// The closed loop with a real Rust Runtime (Go Host 业务所有权迁移 §2.12).
//
// Every other test here talks to a fake Runtime, which proves the Host's own
// state machine and nothing about whether the two projections agree. This one
// runs the real binary over the real Worker channel and asserts the thing that
// cannot be faked: the canonical digest the Runtime computes from its own rows,
// after applying the package, is the digest the Host wrote into the index.
//
// If the Go and Rust projections ever disagree by one field, this fails and
// every fake-backed test still passes — which is exactly why it exists.
//
// Opt-in: ARMADRA_TEST_REAL_WORKER must name an already built native Runtime,
// so an ordinary `go test ./...` needs no Rust toolchain.
func TestRealRuntimeCompletesTheExportImportVerifyLoop(t *testing.T) {
	executable := os.Getenv("ARMADRA_TEST_REAL_WORKER")
	if executable == "" {
		t.Skip("set ARMADRA_TEST_REAL_WORKER to an existing native Runtime binary")
	}
	f, importID := migrated(t)
	// The fixture's Runtime-shaped database is the one the export was taken
	// from, so the rollback lands back where the migration started. It carries
	// the Runtime's own numbered migrations; the reverse import ledger is the
	// one migration this batch adds, applied from the authoritative file.
	database := filepath.Join(filepath.Dir(f.dir), "canvas.db")
	ledger, err := os.ReadFile(filepath.Join("..", "..", "..", "runtime", "migrations", "0010_host_imports.sql"))
	if err != nil {
		t.Fatal(err)
	}
	db := openFixtureSQL(t, database, "rw")
	mustExec(t, db, string(ledger))
	checksum := sha512.Sum384(ledger)
	mustExec(t, db, "INSERT INTO _sqlx_migrations(version,description,installed_on,success,checksum,execution_time) VALUES(10,'host imports',?,1,?,10)", fixtureTime, checksum[:])
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}

	client, err := worker.Start(context.Background(), worker.Options{
		Executable: executable, HostID: fixtureHost, CanvasDatabase: database,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if !client.SupportsReverseImport() {
		t.Fatal("the real Runtime does not advertise the reverse import capability")
	}

	switched, err := f.service.Switch(fixtureContext, SwitchRequest{
		Target: pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST, ImportID: importID, Handoff: client,
	})
	if err != nil {
		t.Fatalf("the switch to the real Runtime failed: %v", err)
	}
	if switched.Ownership.Epoch != 2 {
		t.Fatalf("the switch settled on epoch %d", switched.Ownership.Epoch)
	}
	// A change that exists only on the Host, which is what the package has to
	// carry back for the rollback to mean anything.
	hostEdit(t, f, "回滚前在 Host 上改名")

	directory := filepath.Join(t.TempDir(), "reverse")
	result, err := f.service.Switch(fixtureContext, SwitchRequest{
		Target:  pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME,
		Handoff: client, Importer: client, ExportDirectory: directory,
	})
	if err != nil {
		t.Fatalf("the real rollback failed: %v", err)
	}
	if result.Ownership.Owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME || result.Ownership.Epoch != 3 {
		t.Fatalf("the rollback settled on the wrong state: %v", result.Ownership)
	}
	for _, check := range result.Report.Checks {
		if !check.Matched {
			t.Fatalf("the real Runtime's re-read differs: %v", check)
		}
	}

	db = openFixtureSQL(t, database, "ro")
	defer db.Close()
	var owner string
	var epoch uint64
	if err = db.QueryRowContext(fixtureContext, "SELECT owner, epoch FROM write_ownership WHERE domain = 'canvas'").Scan(&owner, &epoch); err != nil {
		t.Fatal(err)
	}
	if owner != "runtime" || epoch != 3 {
		t.Fatalf("the Runtime did not take the canvas back: %s at %d", owner, epoch)
	}
	// The Host's change is in the Runtime's own rows now, not only in the
	// package. That is the whole difference from an export-only rollback.
	var name string
	if err = db.QueryRowContext(fixtureContext, "SELECT name FROM boards WHERE id = ?", canvasID).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "回滚前在 Host 上改名" {
		t.Fatalf("the Host's change did not travel back: %q", name)
	}
	for _, expected := range []struct {
		query string
		count int
	}{
		{"SELECT count(*) FROM workspaces", 1},
		{"SELECT count(*) FROM boards", 1},
		{"SELECT count(*) FROM nodes", 5},
		{"SELECT count(*) FROM edges", 1},
		{"SELECT count(*) FROM host_imports", 1},
		// Execution facts were never part of the canvas domain, and an import
		// that recreated the workspace row would have cascaded this away.
		{"SELECT count(*) FROM terminal_sessions", 1},
	} {
		var count int
		if err = db.QueryRowContext(fixtureContext, expected.query).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != expected.count {
			t.Fatalf("%s returned %d, expected %d", expected.query, count, expected.count)
		}
	}
}
