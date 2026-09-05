package storage

import (
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"testing"
	"unsafe"
)

// A real Windows run is required to validate ACL application. Cross-compiling
// this test only verifies that the Windows security API usage builds.
func TestWindowsDatabaseDACLOnlyAllowsUserAndSystem(t *testing.T) {
	store, dir := openTestStore(t)
	create(t, store, "acl")
	sid, err := privateSID()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{dir, store.Path(), store.Path() + "-wal", store.Path() + "-shm"} {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			continue
		}
		descriptor, err := windows.GetNamedSecurityInfo(filepath.Clean(path), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			t.Fatal(err)
		}
		acl, _, err := descriptor.DACL()
		if err != nil || acl == nil {
			t.Fatal("missing DACL")
		}
		found := map[string]bool{}
		for index := uint32(0); index < uint32(acl.AceCount); index++ {
			var ace *windows.ACCESS_ALLOWED_ACE
			if err := windows.GetAce(acl, index, &ace); err != nil {
				t.Fatal(err)
			}
			if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
				t.Fatal("unexpected ACE type")
			}
			principal := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
			if principal != sid.String() && principal != "S-1-5-18" {
				t.Fatalf("unexpected principal in %s", path)
			}
			found[principal] = true
		}
		if !found[sid.String()] || !found["S-1-5-18"] {
			t.Fatal("private principals missing")
		}
	}
}
