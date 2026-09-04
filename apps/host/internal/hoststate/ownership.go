package hoststate

import (
	"errors"
	"os"
	"path/filepath"
)

// IsLocked probes the existing OS lock, without creating files, reading an
// identity or replacing a damaged state. A missing IPC socket alone cannot
// prove that a Host has finished draining and released ownership.
func IsLocked(dir string) (bool, error) {
	if dir == "" {
		return false, errors.New("host data directory is empty")
	}
	file, err := openExistingLock(filepath.Join(dir, lockName))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := lock(file); err != nil {
		_ = file.Close()
		if errors.Is(err, ErrLocked) {
			return true, nil
		}
		return false, err
	}
	return false, errors.Join(unlock(file), file.Close())
}
