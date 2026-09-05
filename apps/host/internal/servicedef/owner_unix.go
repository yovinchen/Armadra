//go:build !windows

package servicedef

import (
	"fmt"
	"os"
	"syscall"
)

// verifyOwner accepts only a candidate this account or the superuser owns.
// Another user's file could be replaced between this check and the copy, so a
// foreign owner is a refusal rather than a warning.
func verifyOwner(info os.FileInfo) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("%w: candidate ownership is unreadable", ErrUpgradeRefused)
	}
	owner := int(stat.Uid)
	if owner != os.Getuid() && owner != 0 {
		return fmt.Errorf("%w: candidate is owned by uid %d", ErrUpgradeRefused, owner)
	}
	return nil
}

// probeEnvironment is the environment the candidate is executed with. Unix
// binaries need nothing from the parent to print their own version.
func probeEnvironment() []string { return []string{} }
