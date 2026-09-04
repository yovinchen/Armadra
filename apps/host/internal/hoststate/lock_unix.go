//go:build darwin || linux || freebsd || openbsd || netbsd || dragonfly

package hoststate

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func openRegular(path string, create bool) (*os.File, error) {
	flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK
	if create {
		flags = unix.O_RDWR | unix.O_CREAT | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK
	}
	fd, err := unix.Open(path, flags, 0600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, errors.New("host state path must be a regular file")
	}
	if create {
		if err := file.Chmod(0600); err != nil {
			file.Close()
			return nil, err
		}
	}
	return file, nil
}

func lock(file *os.File) error {
	err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
		return ErrLocked
	}
	if err != nil {
		return fmt.Errorf("acquire host lock: %w", err)
	}
	return nil
}
func unlock(file *os.File) error { return unix.Flock(int(file.Fd()), unix.LOCK_UN) }
func syncDirectory(dir string) error {
	file, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}
