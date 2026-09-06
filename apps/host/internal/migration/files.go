// Package-local filesystem helpers: resolving a package-relative path, hashing
// and verifying a member, and copying one durably into place.

package migration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"armadra.local/host/internal/storage"
)

func relativeFile(root, relative string) (string, error) {
	if relative == "" || strings.ContainsAny(relative, "\\:\x00") || strings.HasPrefix(relative, "/") || strings.Contains(strings.Split(relative, "/")[0], ":") {
		return "", errors.New("invalid package path")
	}
	path := root
	for _, part := range strings.Split(relative, "/") {
		if part == "" || part == "." || part == ".." {
			return "", errors.New("invalid package path")
		}
		path = filepath.Join(path, part)
		info, err := os.Lstat(path)
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("package symlinks are not supported")
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("package entry is not a regular file")
	}
	return path, nil
}
func hashFile(path string, limit int64) ([]byte, uint64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, 0, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, 0, errors.New("package file exceeds its limit")
	}
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, limit+1))
	if err != nil {
		return nil, 0, err
	}
	if n > limit {
		return nil, 0, errors.New("package file exceeds its limit")
	}
	return h.Sum(nil), uint64(n), nil
}
func verifyFile(root, relative string, size uint64, digest []byte, limit int64) (string, error) {
	if len(digest) != 32 {
		return "", errors.New("invalid package digest")
	}
	path, err := relativeFile(root, relative)
	if err != nil {
		return "", err
	}
	actual, n, err := hashFile(path, limit)
	if err != nil {
		return "", err
	}
	if n != size || !bytes.Equal(actual, digest) {
		return "", errors.New("package file checksum or length mismatch")
	}
	return path, nil
}
func ensureDirectory(root, relative string) (string, error) {
	current := root
	for _, part := range strings.Split(relative, "/") {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\:") {
			return "", errors.New("invalid artifact directory")
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			if err = os.Mkdir(current, 0700); err != nil && !errors.Is(err, os.ErrExist) {
				return "", err
			}
			info, err = os.Lstat(current)
		}
		if err != nil {
			return "", err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("import artifact directory is a link or file")
		}
		if err = storage.ProtectArtifactDirectory(current); err != nil {
			return "", err
		}
	}
	return current, nil
}
func copyFile(ctx context.Context, from, to string, digest []byte, size uint64) error {
	if info, err := os.Lstat(to); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("existing import artifact is not a regular file")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if actual, n, err := hashFile(to, maxDatabase); err == nil {
		if n == size && bytes.Equal(actual, digest) {
			return nil
		}
		return errors.New("existing import artifact differs")
	}
	if err := os.MkdirAll(filepath.Dir(to), 0700); err != nil {
		return err
	}
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	tmp, err := os.CreateTemp(filepath.Dir(to), ".copy-*.partial")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	h := sha256.New()
	buffer := make([]byte, 256<<10)
	var count uint64
	for {
		if err = ctx.Err(); err != nil {
			tmp.Close()
			return err
		}
		n, e := src.Read(buffer)
		if n > 0 {
			count += uint64(n)
			if count > size {
				tmp.Close()
				return errors.New("source changed during import")
			}
			h.Write(buffer[:n])
			if _, err = tmp.Write(buffer[:n]); err != nil {
				tmp.Close()
				return err
			}
		}
		if e == io.EOF {
			break
		}
		if e != nil {
			tmp.Close()
			return e
		}
	}
	if count != size || !bytes.Equal(h.Sum(nil), digest) {
		tmp.Close()
		return errors.New("source changed during import")
	}
	err = tmp.Sync()
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	// Publish without replacing an existing import artifact.
	if err = os.Link(name, to); err != nil {
		return err
	}
	return nil
}
