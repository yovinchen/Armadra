//go:build darwin || linux || freebsd || openbsd || netbsd || dragonfly

package localipc

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// Endpoint resolves aliases before deriving the same-user private socket name.
func Endpoint(dataDir string) (string, error) {
	canonical, err := resolveDataDir(dataDir)
	if err != nil {
		return "", err
	}
	if err := privateDirectory(canonical); err != nil {
		return "", err
	}
	// Do not use TMPDIR: it can be arbitrarily long or point into an untrusted
	// hierarchy. /tmp may itself be the system's /private/tmp alias on macOS.
	temporary, err := filepath.EvalSymlinks("/tmp")
	if err != nil {
		return "", err
	}
	principal := strconv.Itoa(os.Geteuid())
	base := filepath.Join(temporary, "armadra-host-"+principal)
	return filepath.Join(base, endpointHash(canonical, principal)+".sock"), nil
}

func privateDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0700 || !ok || stat.Uid != uint32(os.Geteuid()) {
		return errors.New("local IPC directory must be a real 0700 directory owned by the current user")
	}
	return nil
}

func socketInfo(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if info.Mode()&os.ModeSocket == 0 || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0600 || !ok || stat.Uid != uint32(os.Geteuid()) {
		return nil, errors.New("local IPC endpoint must be a 0600 socket owned by the current user")
	}
	return info, nil
}

// sameSocket says whether current is the very socket previous described.
//
// os.SameFile compares device and inode, and Linux hands a freshly unlinked
// inode number straight back to the next socket created on the same
// filesystem — so a replacement listener at the same path looked identical to
// the crashed one it replaced, and closing the old handle deleted the new
// endpoint. The modification time settles it: a socket's mtime is the moment
// it was created, and a replacement is created later. (The field names for
// the change time differ between Darwin and Linux; mtime is portable.)
func sameSocket(previous, current os.FileInfo) bool {
	return os.SameFile(previous, current) && previous.ModTime().Equal(current.ModTime())
}

func removeMatchingSocket(path string, previous os.FileInfo) (bool, error) {
	current, err := socketInfo(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !sameSocket(previous, current) {
		return false, nil
	}
	return true, os.Remove(path)
}

func Listen(dataDir string) (net.Listener, error) {
	endpoint, err := Endpoint(dataDir)
	if err != nil {
		return nil, err
	}
	base := filepath.Dir(endpoint)
	if err := os.Mkdir(base, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	if err := privateDirectory(base); err != nil {
		return nil, err
	}
	old, err := socketInfo(endpoint)
	if err == nil {
		conn, dialErr := net.DialTimeout("unix", endpoint, 100*time.Millisecond)
		if dialErr == nil {
			conn.Close()
			return nil, errors.New("local IPC endpoint is already listening")
		}
		if !errors.Is(dialErr, syscall.ECONNREFUSED) {
			return nil, fmt.Errorf("cannot prove local IPC endpoint is stale: %w", dialErr)
		}
		removed, err := removeMatchingSocket(endpoint, old)
		if err != nil {
			return nil, err
		}
		if !removed {
			return nil, errors.New("local IPC endpoint changed during stale cleanup")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: endpoint, Net: "unix"})
	if err != nil {
		return nil, err
	}
	// Go's default unlink-on-close could remove a newer listener's pathname.
	listener.SetUnlinkOnClose(false)
	created, err := os.Lstat(endpoint)
	if err != nil {
		listener.Close()
		return nil, err
	}
	if err := os.Chmod(endpoint, 0600); err != nil {
		listener.Close()
		if current, statErr := os.Lstat(endpoint); statErr == nil && os.SameFile(created, current) && current.Mode()&os.ModeSocket != 0 {
			_ = os.Remove(endpoint)
		}
		return nil, err
	}
	info, err := socketInfo(endpoint)
	if err != nil {
		listener.Close()
		return nil, err
	}
	return &unixListener{UnixListener: listener, path: endpoint, info: info}, nil
}

type unixListener struct {
	*net.UnixListener
	path string
	info os.FileInfo
	once sync.Once
	err  error
}

func (listener *unixListener) Close() error {
	listener.once.Do(func() {
		listener.err = listener.UnixListener.Close()
		// A renamed/replaced endpoint belongs to someone else. Leave it untouched.
		current, err := os.Lstat(listener.path)
		if errors.Is(err, os.ErrNotExist) {
			return
		}
		if err != nil {
			listener.err = errors.Join(listener.err, err)
			return
		}
		if !sameSocket(listener.info, current) {
			return
		}
		_, err = removeMatchingSocket(listener.path, listener.info)
		listener.err = errors.Join(listener.err, err)
	})
	return listener.err
}

func Dial(ctx context.Context, dataDir string) (net.Conn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	endpoint, err := Endpoint(dataDir)
	if err != nil {
		return nil, unavailable(err)
	}
	if err := privateDirectory(filepath.Dir(endpoint)); err != nil {
		return nil, unavailable(err)
	}
	if _, err := socketInfo(endpoint); err != nil {
		return nil, unavailable(err)
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", endpoint)
	if errors.Is(err, syscall.ECONNREFUSED) {
		return nil, errors.Join(ErrNotRunning, err)
	}
	return conn, unavailable(err)
}
