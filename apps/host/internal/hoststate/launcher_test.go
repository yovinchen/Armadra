package hoststate

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestLauncherRecordRoundTrips(t *testing.T) {
	dir := t.TempDir()
	if _, err := ReadLauncher(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("an empty directory reported %v", err)
	}
	want := LauncherRecord{Launcher: LauncherDesktop, InstanceID: "instance-1", Executable: filepath.Join(dir, "armadra-host")}
	if err := WriteLauncher(dir, want); err != nil {
		t.Fatal(err)
	}
	got, err := ReadLauncher(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("read back %+v", got)
	}
	// The record sits beside the Host's own private state and names nobody
	// else's business, so it is not world-readable.
	info, err := os.Lstat(LauncherPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("launcher record mode is %v", info.Mode().Perm())
	}
	if err := RemoveLauncher(dir); err != nil {
		t.Fatal(err)
	}
	// Removing a record that is already gone is what a second clean shutdown
	// does; it is not a failure.
	if err := RemoveLauncher(dir); err != nil {
		t.Fatal(err)
	}
}

// The file exists so an upgrade can refuse a Host it does not own. A value it
// cannot read must therefore be an error, never a default: "cli" would be a
// licence to replace a binary the desktop app is holding.
func TestUnreadableLauncherIsRefusedRatherThanDefaulted(t *testing.T) {
	for _, content := range []string{`{"launcher":"tmux"}`, `{"launcher":""}`, "not json", `{"launcher":"Desktop"}`} {
		dir := t.TempDir()
		if err := os.WriteFile(LauncherPath(dir), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadLauncher(dir); !errors.Is(err, ErrLauncher) {
			t.Fatalf("%s was accepted or misreported: %v", content, err)
		}
	}
	if err := WriteLauncher(t.TempDir(), LauncherRecord{Launcher: "systemd"}); !errors.Is(err, ErrLauncher) {
		t.Fatalf("an unknown launcher was written: %v", err)
	}
}

// Surrounding whitespace is a transport artefact of the file, not a different
// launcher, so it is trimmed rather than refused.
func TestLauncherValueIsTrimmedNotGuessed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(LauncherPath(dir), []byte(`{"launcher":" service "}`), 0o600); err != nil {
		t.Fatal(err)
	}
	record, err := ReadLauncher(dir)
	if err != nil || record.Launcher != LauncherService {
		t.Fatalf("read %+v (%v)", record, err)
	}
}

func TestValidLauncherNamesExactlyThreeKinds(t *testing.T) {
	for _, known := range []string{LauncherDesktop, LauncherService, LauncherCLI} {
		if !ValidLauncher(known) {
			t.Fatalf("refused %q", known)
		}
	}
	for _, unknown := range []string{"", "Desktop", "shell", "launchd"} {
		if ValidLauncher(unknown) {
			t.Fatalf("accepted %q", unknown)
		}
	}
}
