// Package hoststate owns the local host identity and its process-lifetime lock.
// The lock is advisory: every Armadra host using a directory must acquire it.
package hoststate

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
)

const identityName = "identity.json"
const lockName = "host.lock"

var validID = regexp.MustCompile(`^[0-9a-f]{32}$`)

// ErrLocked means another host owns this data directory. Never remove its lock
// file: removing it would allow a second process to lock a different inode.
var ErrLocked = errors.New("host data directory is already locked")

// State holds the advisory lock until Close. ID survives process restarts.
type State struct {
	ID       string
	file     *os.File
	once     sync.Once
	closeErr error
}

// DefaultDir locates per-user host data, separate from the canvas database.
func DefaultDir() (string, error) {
	var base string
	if runtime.GOOS == "windows" {
		base = os.Getenv("LOCALAPPDATA")
	}
	if base == "" {
		var err error
		base, err = os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("locate host data directory: %w", err)
		}
	}
	if !filepath.IsAbs(base) {
		return "", errors.New("host data directory base must be absolute")
	}
	return filepath.Join(base, "Armadra", "host"), nil
}

// Open exclusively owns dir before inspecting or creating identity.json.
// Damaged, unsupported, linked or non-regular identities are never replaced.
func Open(dir string) (*State, error) {
	if dir == "" {
		return nil, errors.New("host data directory is empty")
	}
	dir = filepath.Clean(dir)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create host data directory: %w", err)
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("host data directory must be a real directory")
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, fmt.Errorf("protect host data directory: %w", err)
	}
	file, err := openRegular(filepath.Join(dir, lockName), true)
	if err != nil {
		return nil, fmt.Errorf("open host lock: %w", err)
	}
	if err := lock(file); err != nil {
		file.Close()
		return nil, err
	}
	state := &State{file: file}
	success := false
	defer func() {
		if !success {
			_ = state.Close()
		}
	}()
	path := filepath.Join(dir, identityName)
	info, err = os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() {
			return nil, errors.New("host identity must be a regular file, not a link")
		}
		state.ID, err = readIdentity(path)
	} else if errors.Is(err, os.ErrNotExist) {
		state.ID, err = createIdentity(dir)
	}
	if err != nil {
		return nil, fmt.Errorf("host identity: %w", err)
	}
	success = true
	return state, nil
}

// Close releases the OS lock exactly once. The lock file intentionally remains.
func (s *State) Close() error {
	if s == nil {
		return nil
	}
	s.once.Do(func() {
		if s.file != nil {
			s.closeErr = errors.Join(unlock(s.file), s.file.Close())
		}
	})
	return s.closeErr
}

func readIdentity(path string) (string, error) {
	file, err := openRegular(path, false)
	if err != nil {
		return "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil {
		return "", err
	}
	if len(data) > 4096 {
		return "", errors.New("identity exceeds size limit")
	}
	// Parse members explicitly to reject duplicate keys as well as unknown fields.
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return "", errors.New("identity must be a JSON object")
	}
	seen := map[string]bool{}
	var version int
	var id string
	for decoder.More() {
		token, err = decoder.Token()
		if err != nil {
			return "", err
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return "", errors.New("invalid or duplicate identity field")
		}
		seen[key] = true
		switch key {
		case "version":
			err = decoder.Decode(&version)
		case "id":
			err = decoder.Decode(&id)
		default:
			return "", fmt.Errorf("unknown identity field %q", key)
		}
		if err != nil {
			return "", err
		}
	}
	if _, err = decoder.Token(); err != nil {
		return "", err
	}
	if _, err = decoder.Token(); !errors.Is(err, io.EOF) {
		return "", errors.New("trailing identity data")
	}
	if version != 1 {
		return "", fmt.Errorf("unsupported identity version %d", version)
	}
	if !validID.MatchString(id) {
		return "", errors.New("identity id must be 32 lowercase hexadecimal characters")
	}
	return id, nil
}

func createIdentity(dir string) (string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	id := hex.EncodeToString(random[:])
	data, err := json.Marshal(struct {
		Version int    `json:"version"`
		ID      string `json:"id"`
	}{1, id})
	if err != nil {
		return "", err
	}
	temporary, err := os.CreateTemp(dir, ".identity-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(temporary.Name())
	defer temporary.Close()
	if err = temporary.Chmod(0600); err != nil {
		return "", err
	}
	if _, err = temporary.Write(append(data, '\n')); err != nil {
		return "", err
	}
	if err = temporary.Sync(); err != nil {
		return "", err
	}
	if err = temporary.Close(); err != nil {
		return "", err
	}
	destination := filepath.Join(dir, identityName)
	// Cooperative writers are excluded by the lock. Also reject an unexpected
	// identity appearing before publication instead of silently replacing it.
	if _, err = os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		return "", errors.New("identity appeared during creation")
	}
	if err = os.Rename(temporary.Name(), destination); err != nil {
		return "", err
	}
	if err = syncDirectory(dir); err != nil {
		return "", err
	}
	return id, nil
}
