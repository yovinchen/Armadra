package storage

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"unsafe"
)

func privateSID() (*windows.SID, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return user.User.Sid.Copy()
}

// Apply and verify an explicit protected DACL. Directory inheritance covers
// SQLite's WAL/SHM/journal files too; no broad inherited grants are retained.
func protectHandle(handle windows.Handle, directory bool) error {
	sid, err := privateSID()
	if err != nil {
		return errors.Join(os.ErrPermission, err)
	}
	owned, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return errors.Join(os.ErrPermission, err)
	}
	owner, _, err := owned.Owner()
	if err != nil || owner == nil || (owner.String() != sid.String() && owner.String() != "S-1-5-18") {
		return errors.Join(os.ErrPermission, errors.New("host storage owner is not current user or SYSTEM"), err)
	}

	flags := ""
	if directory {
		flags = "OICI"
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;" + flags + ";FA;;;SY)(A;" + flags + ";FA;;;" + sid.String() + ")")
	if err != nil {
		return errors.Join(os.ErrPermission, err)
	}
	acl, _, err := descriptor.DACL()
	if err != nil {
		return errors.Join(os.ErrPermission, err)
	}
	err = windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
	if err != nil {
		return errors.Join(os.ErrPermission, err)
	}
	actual, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return errors.Join(os.ErrPermission, err)
	}
	control, _, err := actual.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return errors.Join(os.ErrPermission, errors.New("private DACL is not protected"), err)
	}
	actualACL, _, err := actual.DACL()
	if err != nil || actualACL == nil || actualACL.AceCount != 2 {
		return errors.Join(os.ErrPermission, errors.New("private DACL did not match"), err)
	}
	var expectedACE *windows.ACCESS_ALLOWED_ACE
	if err = windows.GetAce(acl, 0, &expectedACE); err != nil {
		return errors.Join(os.ErrPermission, err)
	}
	expectedFlags := uint8(0)
	if directory {
		expectedFlags = windows.OBJECT_INHERIT_ACE | windows.CONTAINER_INHERIT_ACE
	}
	principals := map[string]bool{}
	for index := uint32(0); index < uint32(actualACL.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err = windows.GetAce(actualACL, index, &ace); err != nil {
			return errors.Join(os.ErrPermission, err)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Mask != expectedACE.Mask || ace.Header.AceFlags&(windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE) != expectedFlags {
			return os.ErrPermission
		}
		principal := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
		if principal != sid.String() && principal != "S-1-5-18" {
			return os.ErrPermission
		}
		principals[principal] = true
	}
	if !principals[sid.String()] || !principals["S-1-5-18"] {
		return os.ErrPermission
	}
	return nil
}

func protectedOpen(path string, directory bool, create bool) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	disposition := uint32(windows.OPEN_EXISTING)
	if create {
		disposition = windows.OPEN_ALWAYS
	}
	flags := uint32(windows.FILE_FLAG_OPEN_REPARSE_POINT)
	if directory {
		flags |= windows.FILE_FLAG_BACKUP_SEMANTICS
	}
	access := uint32(windows.GENERIC_READ | windows.READ_CONTROL | windows.WRITE_DAC)
	if !directory {
		access |= windows.GENERIC_WRITE
	}
	handle, err := windows.CreateFile(name, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, disposition, flags, 0)
	if err != nil {
		return nil, errors.Join(os.ErrPermission, err)
	}
	file := os.NewFile(uintptr(handle), path)
	var info windows.ByHandleFileInformation
	err = windows.GetFileInformationByHandle(handle, &info)
	if err != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (!directory && (info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 || info.NumberOfLinks != 1)) {
		file.Close()
		return nil, errors.Join(os.ErrPermission, errors.New("host storage path is not a regular non-linked object"), err)
	}
	if directory && info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		file.Close()
		return nil, os.ErrPermission
	}
	if err = protectHandle(handle, directory); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func protectDirectory(path string) error {
	file, err := protectedOpen(path, true, false)
	if err != nil {
		return err
	}
	return file.Close()
}
func openPrivateFile(path string) (*os.File, error) { return protectedOpen(path, false, true) }

func openExistingPrivateFile(path string) (*os.File, error) { return protectedOpen(path, false, false) }
