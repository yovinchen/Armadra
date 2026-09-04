package hoststate

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestIdentityAndLockLifecycle(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "host")
	first, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if !validID.MatchString(first.ID) {
		t.Fatalf("invalid id %q", first.ID)
	}
	if second, err := Open(dir); !errors.Is(err, ErrLocked) {
		if second != nil {
			second.Close()
		}
		t.Fatalf("second open: %v", err)
	}
	other, err := Open(filepath.Join(t.TempDir(), "other"))
	if err != nil {
		t.Fatal(err)
	}
	if other.ID == first.ID {
		t.Fatal("independent hosts shared an identity")
	}
	other.Close()
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.ID != first.ID {
		t.Fatalf("identity changed: %s -> %s", first.ID, reopened.ID)
	}
	if runtime.GOOS != "windows" {
		for path, want := range map[string]os.FileMode{dir: 0700, filepath.Join(dir, identityName): 0600, filepath.Join(dir, lockName): 0600} {
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != want {
				t.Fatalf("%s permissions %o, want %o", path, info.Mode().Perm(), want)
			}
		}
	}
}

func TestCorruptIdentityIsNeverReplaced(t *testing.T) {
	const id = "0123456789abcdef0123456789abcdef"
	cases := []string{"", "{", "null", `{"version":2,"id":"` + id + `"}`, `{"version":1,"id":"INVALID"}`, `{"version":1,"id":"` + id + `","extra":1}`, `{"version":1,"version":1,"id":"` + id + `"}`, `{"version":1,"id":"` + id + `"} {}`, strings.Repeat(" ", 4097)}
	for i, content := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, identityName)
			if err := os.WriteFile(path, []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
			for attempt := 0; attempt < 2; attempt++ {
				state, err := Open(dir)
				if err == nil {
					state.Close()
					t.Fatal("accepted corrupt identity")
				}
				if errors.Is(err, ErrLocked) {
					t.Fatal("failed open leaked lock")
				}
			}
			got, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(got, []byte(content)) {
				t.Fatal("corrupt identity was changed")
			}
		})
	}
}

func TestRejectNonRegularPaths(t *testing.T) {
	for _, name := range []string{identityName, lockName} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.Mkdir(filepath.Join(dir, name), 0700); err != nil {
				t.Fatal(err)
			}
			if state, err := Open(dir); err == nil {
				state.Close()
				t.Fatal("accepted directory in place of file")
			}
		})
	}
	for _, name := range []string{identityName, lockName} {
		t.Run("symlink-"+name, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(t.TempDir(), "target")
			original := []byte(`{"version":1,"id":"0123456789abcdef0123456789abcdef"}`)
			if err := os.WriteFile(target, original, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, filepath.Join(dir, name)); err != nil {
				t.Skipf("symlink unavailable: %v", err)
			}
			if state, err := Open(dir); err == nil {
				state.Close()
				t.Fatal("accepted symlink")
			}
			got, err := os.ReadFile(target)
			if err != nil || !bytes.Equal(got, original) {
				t.Fatal("symlink target modified")
			}
		})
	}
	t.Run("directory-symlink", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "linked")
		if err := os.Symlink(t.TempDir(), path); err != nil {
			t.Skipf("symlink unavailable: %v", err)
		}
		if state, err := Open(path + string(os.PathSeparator)); err == nil {
			state.Close()
			t.Fatal("accepted directory symlink")
		}
	})
}

func TestLockProcessHelper(t *testing.T) {
	mode := os.Getenv("ARMADRA_HOSTSTATE_TEST_HELPER")
	if mode == "" {
		return
	}
	state, err := Open(os.Getenv("ARMADRA_HOSTSTATE_TEST_DIR"))
	if mode == "contend" {
		if errors.Is(err, ErrLocked) {
			os.Exit(21)
		}
		if state != nil {
			state.Close()
		}
		os.Exit(22)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(23)
	}
	fmt.Println(state.ID)
	_, _ = io.Copy(io.Discard, os.Stdin)
	_ = state.Close()
	os.Exit(0)
}

func helperCommand(t *testing.T, mode, dir string) *exec.Cmd {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestLockProcessHelper$")
	command.Env = append(os.Environ(), "ARMADRA_HOSTSTATE_TEST_HELPER="+mode, "ARMADRA_HOSTSTATE_TEST_DIR="+dir)
	return command
}

func TestCrossProcessLockAndCrashRecovery(t *testing.T) {
	dir := t.TempDir()
	command := helperCommand(t, "hold", dir)
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	defer func() {
		if !waited {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}()
	ready := make(chan string, 1)
	go func() { line, _ := bufio.NewReader(stdout).ReadString('\n'); ready <- strings.TrimSpace(line) }()
	var id string
	select {
	case id = <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("helper startup timeout")
	}
	if !validID.MatchString(id) {
		t.Fatalf("helper did not acquire lock: %q", id)
	}
	state, err := Open(dir)
	if state != nil {
		state.Close()
	}
	if !errors.Is(err, ErrLocked) {
		t.Fatalf("parent acquired child lock: %v", err)
	}
	contender := helperCommand(t, "contend", dir)
	err = contender.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 21 {
		t.Fatalf("contender result: %v", err)
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = command.Wait()
	waited = true
	restored, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if restored.ID != id {
		t.Fatal("host identity changed after forced process termination")
	}
	if _, err := os.Stat(filepath.Join(dir, lockName)); err != nil {
		t.Fatal("lock file must remain on disk")
	}
}

func TestDefaultDirectory(t *testing.T) {
	root := t.TempDir()
	if runtime.GOOS == "windows" {
		t.Setenv("LOCALAPPDATA", root)
	} else if runtime.GOOS == "darwin" {
		t.Setenv("HOME", root)
		root = filepath.Join(root, "Library", "Application Support")
	} else {
		t.Setenv("XDG_CONFIG_HOME", root)
	}
	got, err := DefaultDir()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, "Armadra", "host"); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestLockedDirectoryDoesNotCreateIdentity(t *testing.T) {
	dir := t.TempDir()
	file, err := openRegular(filepath.Join(dir, lockName), true)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := lock(file); err != nil {
		t.Fatal(err)
	}
	defer unlock(file)
	state, err := Open(dir)
	if state != nil {
		state.Close()
	}
	if !errors.Is(err, ErrLocked) {
		t.Fatalf("expected locked error, got %v", err)
	}
	if _, err := os.Lstat(filepath.Join(dir, identityName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("identity was created before lock acquisition")
	}
}
