// Package localipc provides a same-user OS transport for the host control protocol.
// Listen's caller must hold the hoststate data-directory lock for its lifetime.
// Endpoint and Dial never create directories, remove endpoints or mutate state.
package localipc

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
)

// ErrNotRunning denotes a missing endpoint/data directory or connection refusal.
// Permission, invalid filesystem objects, busy pipes and timeouts are distinct.
var ErrNotRunning = errors.New("local host is not running")
var ErrUnsupported = errors.New("local IPC is unsupported on this platform")

func resolveDataDir(dir string) (string, error) {
	if dir == "" {
		return "", errors.New("host data directory is empty")
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	canonical, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(canonical)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("host data path must resolve to a directory")
	}
	return canonical, nil
}

func endpointHash(canonical, principal string) string {
	sum := sha256.Sum256([]byte(principal + "\x00" + canonical))
	// 192 bits retain ample collision resistance and fit macOS sockaddr_un even
	// with a maximum-length Unix UID in the private directory name.
	return hex.EncodeToString(sum[:24])
}

func unavailable(err error) error {
	if errors.Is(err, os.ErrNotExist) {
		return errors.Join(ErrNotRunning, err)
	}
	return err
}
