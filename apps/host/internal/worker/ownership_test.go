package worker

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
)

func ownershipClient(t *testing.T, database string) *Client {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	client, err := Start(context.Background(), Options{Executable: executable, HostID: fixtureHost, CanvasDatabase: database})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func ownershipDatabase(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "canvas.db")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

// The handoff persists on the Runtime side and reads back, and a stale expected
// epoch is refused rather than applied out of order.
func TestWriteOwnershipHandoffPersistsAndRefusesStaleEpochs(t *testing.T) {
	database := ownershipDatabase(t)
	client := ownershipClient(t, database)
	ctx := context.Background()
	before, err := client.GetWriteOwnership(ctx, "canvas")
	if err != nil {
		t.Fatal(err)
	}
	if before.Owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME || before.Epoch != 1 {
		t.Fatalf("an untouched Runtime reported %v at epoch %d", before.Owner, before.Epoch)
	}
	after, err := client.SetWriteOwnership(ctx, "canvas", pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST, 2, 1, "ownership.switch.verified")
	if err != nil {
		t.Fatal(err)
	}
	if after.Owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST || after.Epoch != 2 {
		t.Fatalf("the handoff was acknowledged as %v at epoch %d", after.Owner, after.Epoch)
	}
	// An exact repeat is idempotent.
	repeat, err := client.SetWriteOwnership(ctx, "canvas", pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST, 2, 1, "ownership.switch.verified")
	if err != nil {
		t.Fatalf("a repeated handoff failed: %v", err)
	}
	if repeat.Epoch != 2 {
		t.Fatalf("a repeat moved the epoch to %d", repeat.Epoch)
	}
	// A stale expected epoch is refused; the client reports the remote code.
	_, err = client.SetWriteOwnership(ctx, "canvas", pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME, 3, 1, "ownership.rollback")
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != CodeRemote || failure.RemoteCode != "CONFLICT" {
		t.Fatalf("a stale handoff was accepted or misreported: %v", err)
	}
	// The record survives the process that wrote it.
	restarted := ownershipClient(t, database)
	stored, err := restarted.GetWriteOwnership(ctx, "canvas")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Owner != pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST || stored.Epoch != 2 {
		t.Fatalf("the handoff did not persist: %v at epoch %d", stored.Owner, stored.Epoch)
	}
}

// A Worker started without the flag has no ownership surface at all, and the
// client refuses locally rather than sending a request that cannot be answered.
func TestOwnershipRequiresTheCanvasDatabaseFlag(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	client, err := Start(context.Background(), Options{Executable: executable, HostID: fixtureHost})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var failure *Error
	if _, err = client.GetWriteOwnership(context.Background(), "canvas"); !errors.As(err, &failure) || failure.Code != CodeUnsupported {
		t.Fatalf("a plain Worker answered an ownership read: %v", err)
	}
	if _, err = client.SetWriteOwnership(context.Background(), "canvas", pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST, 2, 1, "x"); !errors.As(err, &failure) || failure.Code != CodeUnsupported {
		t.Fatalf("a plain Worker accepted an ownership write: %v", err)
	}
}

// A Worker that silently ignored the flag would look like a successful
// handoff. The capability must be advertised before this client trusts it.
func TestOwnershipRequiresTheAdvertisedCapability(t *testing.T) {
	t.Setenv("ARMADRA_TEST_WORKER_MODE", "ownership-silent")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	_, err = Start(context.Background(), Options{Executable: executable, HostID: fixtureHost, CanvasDatabase: ownershipDatabase(t)})
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != CodeUnsupported {
		t.Fatalf("a Worker that never advertised the capability was trusted: %v", err)
	}
}

// Scheduling and ownership are mutually exclusive modes, so a running command
// Worker can never be used to move write ownership.
func TestOwnershipAndCommandModesAreExclusive(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	stateDir := t.TempDir()
	_, err = Start(context.Background(), Options{Executable: executable, HostID: fixtureHost, StateDir: stateDir, CanvasDatabase: ownershipDatabase(t)})
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != CodeInvalid {
		t.Fatalf("a Worker was started in both modes at once: %v", err)
	}
}

// A relative or empty path is refused before a process is started.
func TestOwnershipDatabaseMustBeAbsolute(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	_, err = Start(context.Background(), Options{Executable: executable, HostID: fixtureHost, CanvasDatabase: "canvas.db"})
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != CodeInvalid {
		t.Fatalf("a relative database path was accepted: %v", err)
	}
}
