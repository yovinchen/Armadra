package hoststate

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOwnershipProbeDoesNotCreateOrRepairIdentity(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "absent")
	if locked, err := IsLocked(dir); err != nil || locked {
		t.Fatalf("absent probe: %v %v", locked, err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("probe created directory")
	}
	state, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	if locked, err := IsLocked(dir); err != nil || !locked {
		t.Fatalf("held probe: %v %v", locked, err)
	}
	if err := state.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, identityName)
	if err := os.WriteFile(path, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if locked, err := IsLocked(dir); err != nil || locked {
		t.Fatalf("released probe: %v %v", locked, err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "broken" {
		t.Fatal("probe repaired identity")
	}
}
