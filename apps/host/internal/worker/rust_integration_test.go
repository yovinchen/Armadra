package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Opt-in: ARMADRA_TEST_REAL_WORKER must name an already built native Runtime.
// Regular Go tests never depend on a Rust toolchain or the user's running app.
func TestRealRustWorkerReadOnlyPrivatePipes(t *testing.T) {
	executable := os.Getenv("ARMADRA_TEST_REAL_WORKER")
	if executable == "" {
		t.Skip("set ARMADRA_TEST_REAL_WORKER to an existing native Runtime binary")
	}
	base := t.TempDir()
	root := filepath.Join(base, "root 中文 space")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	name := "note 中文' file.txt"
	content := []byte(strings.Repeat("中文🙂", 60000))
	file := filepath.Join(root, name)
	if err := os.WriteFile(file, content, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "子目录"), 0700); err != nil {
		t.Fatal(err)
	}
	dataDir := filepath.Join(base, "unused-runtime-data")
	database := filepath.Join(base, "unused-canvas.db")
	t.Setenv("ARMADRA_DATA_DIR", dataDir)
	t.Setenv("ARMADRA_DATABASE_URL", "sqlite://"+database+"?mode=rwc")
	// Hold the configured legacy HTTP port ourselves. Worker stdio startup must
	// succeed without trying to bind it or initializing any legacy state.
	guard, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Close()
	t.Setenv("ARMADRA_RUNTIME_HOST", "127.0.0.1")
	t.Setenv("ARMADRA_RUNTIME_PORT", strconv.Itoa(guard.Addr().(*net.TCPAddr).Port))
	c, err := Start(context.Background(), Options{Executable: executable, HostID: fixtureHost})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	registered, err := c.RegisterRoot(context.Background(), "real-root", root)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil || registered.CanonicalPath != canonical {
		t.Fatal("cross-language canonical root differs")
	}
	listing, err := c.ListDirectory(context.Background(), "real-root", ".")
	if err != nil || len(listing.Entries) != 2 {
		t.Fatalf("cross-language directory read failed: %v", err)
	}
	found := false
	for _, entry := range listing.Entries {
		if entry.Name == name && entry.Path == name && entry.Size == uint64(len(content)) {
			found = true
		}
	}
	if !found {
		t.Fatal("Unicode file metadata missing")
	}
	first, err := c.ReadFileChunk(context.Background(), ReadOptions{RootID: "real-root", Path: name})
	if err != nil || first.Eof || len(first.Data) != MaxFileChunkBytes {
		t.Fatalf("first Rust chunk failed: %v", err)
	}
	combined := append([]byte(nil), first.Data...)
	offset := uint64(len(first.Data))
	for {
		chunk, err := c.ReadFileChunk(context.Background(), ReadOptions{RootID: "real-root", Path: name, Offset: offset, ExpectedSHA256: first.Sha256})
		if err != nil {
			t.Fatal(err)
		}
		combined = append(combined, chunk.Data...)
		offset += uint64(len(chunk.Data))
		if chunk.Eof {
			break
		}
	}
	expected := sha256.Sum256(content)
	if !bytes.Equal(combined, content) || !bytes.Equal(expected[:], first.Sha256) {
		t.Fatal("real Rust UTF-8 chunks or digest changed")
	}
	if err = os.WriteFile(file, append(content, 'x'), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = c.ReadFileChunk(context.Background(), ReadOptions{RootID: "real-root", Path: name, Offset: uint64(len(first.Data)), ExpectedSHA256: first.Sha256})
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != CodeRemote || failure.RemoteCode != "CONFLICT" {
		t.Fatalf("source mutation was not reported as conflict: %v", err)
	}
	if _, err = c.ListDirectory(context.Background(), "real-root", "."); err != nil {
		t.Fatal("version conflict closed the healthy Rust Worker")
	}
	for _, path := range []string{dataDir, database} {
		if _, err = os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("stdio Worker initialized legacy database/data directory")
		}
	}
	if lsof, err := exec.LookPath("lsof"); err == nil {
		output, err := exec.Command(lsof, "-nP", "-a", "-p", strconv.Itoa(c.cmd.Process.Pid), "-iTCP").Output()
		var exit *exec.ExitError
		if len(output) > 0 || err != nil && (!errors.As(err, &exit) || exit.ExitCode() != 1) {
			t.Fatal("Worker owns an unexpected TCP socket or socket inspection failed")
		}
	} else {
		t.Log("lsof unavailable; occupied legacy-port guard passed, full socket inventory not verified on this platform")
	}
	if err = c.Close(); err != nil {
		t.Fatal(err)
	}
	assertReaped(t, c)
	t.Logf("verified native Rust Worker platform=%s architecture=%s via anonymous pipes; %d UTF-8 bytes, source-change conflict, no legacy DB, child reaped", c.Hello().Platform, c.Hello().Architecture, len(combined))
}
