package storage

import (
	"errors"
	"os"
	"path/filepath"
)

func databaseFile(dir string) (string, *os.File, error) {
	if dir == "" {
		return "", nil, ErrInvalid
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return "", nil, err
	}
	if err = os.MkdirAll(absolute, 0700); err != nil {
		return "", nil, err
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return "", nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", nil, errors.Join(os.ErrPermission, errors.New("host storage directory must not be a link"))
	}
	if err = protectDirectory(absolute); err != nil {
		return "", nil, err
	}
	canonical, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", nil, err
	}
	path := filepath.Join(canonical, "host.db")
	file, err := openPrivateFile(path)
	if err != nil {
		return "", nil, err
	}
	return path, file, nil
}

func verifyFileIdentity(file *os.File, path string) error {
	opened, err := file.Stat()
	if err != nil {
		return err
	}
	current, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !current.Mode().IsRegular() || !os.SameFile(opened, current) {
		return errors.Join(os.ErrPermission, errors.New("host database file changed while opening"))
	}
	return nil
}

// SQLite may consult companion files even on a read-only open. Refuse existing
// links or non-files before handing their predictable names to the driver.
func verifyCompanions(path string) error {
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		info, err := os.Lstat(path + suffix)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.Join(os.ErrPermission, errors.New("SQLite companion must be a regular file"))
		}
		file, err := openExistingPrivateFile(path + suffix)
		if err != nil {
			return err
		}
		if err = file.Close(); err != nil {
			return err
		}

	}
	return nil
}

// ProtectArtifactDirectory applies the same private permissions/DACL as host.db
// storage without opening a database. Callers must first constrain this existing
// directory beneath their Host data root; symlink leaves are always rejected.
func ProtectArtifactDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.Join(os.ErrPermission, errors.New("artifact directory must not be a link or file"))
	}
	return protectDirectory(path)
}
