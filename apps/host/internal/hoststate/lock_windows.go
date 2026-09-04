package hoststate

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

func openRegular(path string, create bool) (*os.File, error) {
	access, disposition := uint32(windows.GENERIC_READ), uint32(windows.OPEN_EXISTING)
	if create {
		access |= windows.GENERIC_WRITE
		disposition = windows.OPEN_ALWAYS
	}
	return openStateFile(path, access, disposition)
}

func openExistingLock(path string) (*os.File, error) {
	return openStateFile(path, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.OPEN_EXISTING)
}

func openStateFile(path string, access, disposition uint32) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	// Open the reparse point itself so links cannot redirect the lock/identity.
	handle, err := windows.CreateFile(name, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, disposition, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(handle), path)
	var info windows.ByHandleFileInformation
	err = windows.GetFileInformationByHandle(handle, &info)
	if err != nil || info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		file.Close()
		return nil, errors.New("host state path must be a regular file, not a reparse point")
	}
	kind, err := windows.GetFileType(handle)
	if err != nil || kind != windows.FILE_TYPE_DISK {
		file.Close()
		return nil, errors.New("host state path must be a disk file")
	}
	return file, nil
}
func lock(file *os.File) error {
	err := windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return ErrLocked
	}
	if err != nil {
		return fmt.Errorf("acquire host lock: %w", err)
	}
	return nil
}
func unlock(file *os.File) error {
	return windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, &windows.Overlapped{})
}

// Directory fsync is not provided by os.File.Sync on Windows. The identity file
// is flushed before rename; no cross-platform crash-atomic rename is claimed.
func syncDirectory(string) error { return nil }
