//go:build darwin || linux || freebsd || openbsd || netbsd || dragonfly

package localipc

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func privateTemp(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestPrivateSocketRoundTripAndClose(t *testing.T) {
	dir := privateTemp(t)
	listener, err := Listen(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	endpoint, err := Endpoint(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := privateDirectory(filepath.Dir(endpoint)); err != nil {
		t.Fatal(err)
	}
	if _, err := socketInfo(endpoint); err != nil {
		t.Fatal(err)
	}
	if other, err := Listen(dir); err == nil {
		other.Close()
		t.Fatal("replaced live listener")
	}
	done := make(chan error, 1)
	go func() {
		// The duplicate Listen liveness probe connects and closes without payload.
		for {
			conn, err := listener.Accept()
			if err != nil {
				done <- err
				return
			}
			_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
			data := make([]byte, 4)
			_, err = io.ReadFull(conn, data)
			if errors.Is(err, io.EOF) {
				conn.Close()
				continue
			}
			if err == nil {
				_, err = conn.Write(data)
			}
			conn.Close()
			done <- err
			return
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := Dial(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	data := make([]byte, 4)
	if _, err := io.ReadFull(conn, data); err != nil || string(data) != "ping" {
		t.Fatalf("round trip %q, %v", data, err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(endpoint); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("owned socket was not removed")
	}
}

func TestLongAndAliasedDataDirectory(t *testing.T) {
	root := privateTemp(t)
	dir := filepath.Join(root, strings.Repeat("a", 90), strings.Repeat("b", 90))
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	endpoint, err := Endpoint(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(endpoint) >= 104 {
		t.Fatalf("socket path too long: %d", len(endpoint))
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(dir, alias); err != nil {
		t.Fatal(err)
	}
	aliasEndpoint, err := Endpoint(alias)
	if err != nil || endpoint != aliasEndpoint {
		t.Fatalf("alias endpoint differs: %q %q %v", endpoint, aliasEndpoint, err)
	}
	listener, err := Listen(alias)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	conn, err := Dial(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
}

func TestDialDoesNotCreateAndHonorsContext(t *testing.T) {
	missing := filepath.Join(privateTemp(t), "missing")
	if _, err := Dial(context.Background(), missing); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("missing directory: %v", err)
	}
	if _, err := os.Lstat(missing); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("Dial created directory")
	}
	dir := privateTemp(t)
	endpoint, err := Endpoint(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Dial(context.Background(), dir); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("missing endpoint: %v", err)
	}
	if _, err := os.Lstat(endpoint); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("Dial created endpoint")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Dial(ctx, dir); !errors.Is(err, context.Canceled) || errors.Is(err, ErrNotRunning) {
		t.Fatalf("cancellation classification: %v", err)
	}
	expired, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if _, err := Dial(expired, dir); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline: %v", err)
	}
}

func TestStaleSocketOnlyCleanup(t *testing.T) {
	dir := privateTemp(t)
	original, err := Listen(dir)
	if err != nil {
		t.Fatal(err)
	}
	endpoint, _ := Endpoint(dir)
	// Simulate a crashed process by closing its fd without wrapper unlink.
	if err := original.(*unixListener).UnixListener.Close(); err != nil {
		t.Fatal(err)
	}
	defer original.Close()
	if _, err := Dial(context.Background(), dir); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("stale socket: %v", err)
	}
	replacement, err := Listen(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer replacement.Close()
	if err := original.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		t.Fatal(err)
	}
	if _, err := os.Lstat(endpoint); err != nil {
		t.Fatal("old listener deleted new socket")
	}
}

func TestClosePreservesReplacementFiles(t *testing.T) {
	for _, replacement := range []string{"file", "socket", "symlink"} {
		t.Run(replacement, func(t *testing.T) {
			dir := privateTemp(t)
			listener, err := Listen(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			endpoint, _ := Endpoint(dir)
			if err := os.Remove(endpoint); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Remove(endpoint) })
			switch replacement {
			case "file":
				err = os.WriteFile(endpoint, []byte("keep"), 0600)
			case "symlink":
				err = os.Symlink(filepath.Join(privateTemp(t), "target"), endpoint)
			case "socket":
				other, e := net.ListenUnix("unix", &net.UnixAddr{Name: endpoint, Net: "unix"})
				err = e
				if other != nil {
					other.SetUnlinkOnClose(false)
					defer other.Close()
					_ = os.Chmod(endpoint, 0600)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			before, err := os.Lstat(endpoint)
			if err != nil {
				t.Fatal(err)
			}
			if err := listener.Close(); err != nil {
				t.Fatal(err)
			}
			after, err := os.Lstat(endpoint)
			if err != nil || !os.SameFile(before, after) {
				t.Fatal("replacement was removed or changed")
			}
		})
	}
}

func TestRejectUnsafeFilesystemObjects(t *testing.T) {
	for _, kind := range []string{"file", "directory", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			dir := privateTemp(t)
			endpoint, err := Endpoint(dir)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(filepath.Dir(endpoint), 0700); err != nil && !errors.Is(err, os.ErrExist) {
				t.Fatal(err)
			}
			switch kind {
			case "file":
				err = os.WriteFile(endpoint, []byte("keep"), 0600)
			case "directory":
				err = os.Mkdir(endpoint, 0700)
			case "symlink":
				err = os.Symlink(filepath.Join(privateTemp(t), "target"), endpoint)
			}
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Remove(endpoint) })
			before, _ := os.Lstat(endpoint)
			if listener, err := Listen(dir); err == nil {
				listener.Close()
				t.Fatal("Listen accepted unsafe object")
			}
			if conn, err := Dial(context.Background(), dir); err == nil || errors.Is(err, ErrNotRunning) {
				if conn != nil {
					conn.Close()
				}
				t.Fatalf("Dial misclassified unsafe object: %v", err)
			}
			after, err := os.Lstat(endpoint)
			if err != nil || !os.SameFile(before, after) {
				t.Fatal("unsafe object was deleted")
			}
		})
	}
	dir := privateTemp(t)
	if err := os.Chmod(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := Endpoint(dir); err == nil {
		t.Fatal("accepted non-private data directory")
	}
	if err := privateDirectory(dir); err == nil {
		t.Fatal("accepted non-private socket directory")
	}
	alias := filepath.Join(privateTemp(t), "linked")
	if err := os.Symlink(privateTemp(t), alias); err != nil {
		t.Fatal(err)
	}
	if err := privateDirectory(alias); err == nil {
		t.Fatal("accepted socket-directory symlink")
	}
}
