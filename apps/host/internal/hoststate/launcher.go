package hoststate

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Who started this Host. Two Hosts can share a machine — the one the desktop
// app owns and the one an operator installed as a service — and only their
// own launcher may replace them. The record is written by the process that is
// serving, so it is an observation rather than a guess (design
// docs/design/updates-and-service-install.md §3.4).
const (
	LauncherDesktop = "desktop"
	LauncherService = "service"
	LauncherCLI     = "cli"
)

// LauncherName is the file inside the data directory holding the record. It
// carries no credential: only which kind of launcher is running this Host.
const LauncherName = "launcher.json"

// ErrLauncher marks a launcher value that is not one of the three documented
// kinds. Guessing one would let an upgrade decide it may replace a Host the
// desktop app is holding.
var ErrLauncher = errors.New("launcher must be desktop, service or cli")

// ValidLauncher reports whether value names a launcher this Host records.
func ValidLauncher(value string) bool {
	switch value {
	case LauncherDesktop, LauncherService, LauncherCLI:
		return true
	}
	return false
}

// LauncherRecord is what a serving Host writes about itself.
type LauncherRecord struct {
	// Launcher is desktop, service or cli.
	Launcher string `json:"launcher"`
	// InstanceID is the process incarnation that wrote the record, so a stale
	// file left by a crashed Host can be told from the running one's.
	InstanceID string `json:"hostInstanceId"`
	// Executable is the program image that was running. An upgrade compares it
	// with its own path rather than trusting the launcher name alone.
	Executable string `json:"executable,omitempty"`
}

// LauncherPath is where the data directory records its launcher.
func LauncherPath(dataDir string) string { return filepath.Join(dataDir, LauncherName) }

// WriteLauncher records who started the Host that owns dataDir. It is written
// 0600 beside the Host's own private state and replaced atomically, so a reader
// never sees half a record.
func WriteLauncher(dataDir string, record LauncherRecord) error {
	if !ValidLauncher(record.Launcher) {
		return fmt.Errorf("%w: got %q", ErrLauncher, record.Launcher)
	}
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temporary, err := os.CreateTemp(dataDir, LauncherName+".*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Chmod(temporary.Name(), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), LauncherPath(dataDir))
}

// ReadLauncher returns the recorded launcher, or os.ErrNotExist when no Host
// has written one. An unreadable record is an error rather than an assumed
// "cli": the whole point of the file is to stop an upgrade from acting on a
// Host it does not own.
func ReadLauncher(dataDir string) (LauncherRecord, error) {
	var record LauncherRecord
	data, err := os.ReadFile(LauncherPath(dataDir))
	if err != nil {
		return record, err
	}
	if err := json.Unmarshal(data, &record); err != nil {
		return record, fmt.Errorf("%w: recorded launcher is unreadable", ErrLauncher)
	}
	record.Launcher = strings.TrimSpace(record.Launcher)
	if !ValidLauncher(record.Launcher) {
		return record, fmt.Errorf("%w: recorded %q", ErrLauncher, record.Launcher)
	}
	return record, nil
}

// RemoveLauncher drops the record on a clean shutdown. A missing record is not
// an error: the file only describes a Host that is currently serving.
func RemoveLauncher(dataDir string) error {
	if err := os.Remove(LauncherPath(dataDir)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
