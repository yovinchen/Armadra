//go:build !windows

package storage

import (
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"syscall"
)

func protectDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || !ok || stat.Uid != uint32(os.Geteuid()) {
		return errors.Join(os.ErrPermission, errors.New("host storage directory is not owned by the current user"))
	}
	return os.Chmod(path, 0700)
}

func openPrivateFile(path string) (*os.File, error)         { return privateFile(path, true) }
func openExistingPrivateFile(path string) (*os.File, error) { return privateFile(path, false) }
func privateFile(path string, create bool) (*os.File, error) {
	flags := unix.O_RDWR | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK
	if create {
		flags |= unix.O_CREAT
	}
	fd, err := unix.Open(path, flags, 0600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || !ok || stat.Uid != uint32(os.Geteuid()) || stat.Nlink != 1 {
		file.Close()
		return nil, errors.Join(os.ErrPermission, errors.New("host.db must be a private regular file with one link"))
	}
	if err = file.Chmod(0600); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}
