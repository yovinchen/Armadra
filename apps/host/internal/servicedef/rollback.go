package servicedef

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

// Replacing several binaries as one act, and putting them all back.
//
// The Host, the Worker and the Hook speak one protocol to each other. Half of
// them at the new version and half at the old is a combination nobody tested
// and nobody declared compatible, so they move together or not at all: every
// candidate is written beside its target first, and only when all of them are
// on disk and closed does anything get renamed. A failure part-way through
// undoes the renames in reverse.
//
// The displaced binaries stay as `<target>.previous` until the next successful
// upgrade, because the rollback in §3.3 needs something to go back to.

// PreviousSuffix is what a displaced binary is renamed to.
const PreviousSuffix = ".previous"

// Replacement pairs one verified candidate with the installed file it takes
// the place of.
type Replacement struct {
	// Component is what this binary is, for the operator-facing report.
	Component string
	// Candidate is the verified file to install. Target is the installed path.
	Candidate, Target string
}

// Transaction records what a successful ReplaceAll did, so the same set can be
// rolled back later.
type Transaction struct {
	Replaced []Replacement
}

// Targets lists the installed paths a transaction touched.
func (t Transaction) Targets() []string {
	paths := make([]string, 0, len(t.Replaced))
	for _, replacement := range t.Replaced {
		paths = append(paths, replacement.Target)
	}
	return paths
}

// ReplaceAll installs every candidate over its target, or leaves every target
// exactly as it was.
//
// Staging happens first for all of them: a disk that fills up, a directory
// that is not writable or a candidate that cannot be read is discovered before
// any installed file has moved. The current binary is renamed aside rather
// than overwritten, because Windows refuses to overwrite a file that is being
// executed but allows renaming it — which is also what leaves `.previous`
// behind for a rollback.
func ReplaceAll(replacements []Replacement) (Transaction, error) {
	var transaction Transaction
	if len(replacements) == 0 {
		return transaction, fmt.Errorf("%w: nothing to replace", ErrUpgradeRefused)
	}
	staged := make([]string, len(replacements))
	defer func() {
		for _, path := range staged {
			if path != "" {
				os.Remove(path)
			}
		}
	}()
	for index, replacement := range replacements {
		path, err := stage(replacement)
		if err != nil {
			return transaction, err
		}
		staged[index] = path
	}
	// Every candidate is now written, synced and closed. From here the only
	// operations are renames, which are the cheapest thing that can fail.
	done := make([]Replacement, 0, len(replacements))
	for index, replacement := range replacements {
		previous := replacement.Target + PreviousSuffix
		_ = os.Remove(previous)
		if err := os.Rename(replacement.Target, previous); err != nil {
			return transaction, errors.Join(err, undo(done))
		}
		if err := os.Rename(staged[index], replacement.Target); err != nil {
			// Put this one back before undoing the earlier ones, so the caller
			// finds every target as it was.
			restore := os.Rename(previous, replacement.Target)
			return transaction, errors.Join(err, restore, undo(done))
		}
		staged[index] = ""
		done = append(done, replacement)
	}
	transaction.Replaced = done
	return transaction, nil
}

// stage writes one candidate beside its target and returns the staged path.
func stage(replacement Replacement) (path string, err error) {
	source, err := os.Open(replacement.Candidate)
	if err != nil {
		return "", err
	}
	defer source.Close()
	info, err := os.Lstat(replacement.Target)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%w: %s is not a regular file", ErrUpgradeRefused, replacement.Target)
	}
	staged, err := os.CreateTemp(filepath.Dir(replacement.Target), filepath.Base(replacement.Target)+".next-*")
	if err != nil {
		return "", err
	}
	name := staged.Name()
	defer func() {
		if err != nil {
			os.Remove(name)
		}
	}()
	if _, err = io.Copy(staged, source); err != nil {
		staged.Close()
		return "", err
	}
	if err = staged.Sync(); err != nil {
		staged.Close()
		return "", err
	}
	if err = staged.Close(); err != nil {
		return "", err
	}
	mode := info.Mode().Perm()
	if runtime.GOOS != "windows" {
		mode |= 0o100
	}
	if err = os.Chmod(name, mode); err != nil {
		return "", err
	}
	return name, nil
}

// undo puts already-renamed targets back, newest first.
func undo(done []Replacement) error {
	var failures error
	for index := len(done) - 1; index >= 0; index-- {
		target := done[index].Target
		previous := target + PreviousSuffix
		if _, err := os.Lstat(previous); err != nil {
			failures = errors.Join(failures, fmt.Errorf("no saved binary for %s", target))
			continue
		}
		// The new file is in the way; removing it is safe because the saved one
		// is the file that was running.
		_ = os.Remove(target)
		if err := os.Rename(previous, target); err != nil {
			failures = errors.Join(failures, err)
		}
	}
	return failures
}

// Rollback puts every target back to the binary it displaced. It is the only
// way down from a release: this Host never installs an older version over a
// newer one, because a database that has already migrated cannot be handed to
// a build that does not know the migration.
func Rollback(transaction Transaction) error {
	if len(transaction.Replaced) == 0 {
		return fmt.Errorf("%w: nothing was replaced, so nothing can be rolled back", ErrUpgradeRefused)
	}
	var failures error
	for index := len(transaction.Replaced) - 1; index >= 0; index-- {
		replacement := transaction.Replaced[index]
		previous := replacement.Target + PreviousSuffix
		info, err := os.Lstat(previous)
		if err != nil {
			failures = errors.Join(failures, fmt.Errorf("%s has no saved previous binary", replacement.Target))
			continue
		}
		if !info.Mode().IsRegular() {
			failures = errors.Join(failures, fmt.Errorf("%s%s is not a regular file", replacement.Target, PreviousSuffix))
			continue
		}
		// Move the failed binary aside rather than deleting it: it is the only
		// copy of what went wrong, and an operator will want to look at it.
		failed := replacement.Target + ".failed"
		_ = os.Remove(failed)
		if err := os.Rename(replacement.Target, failed); err != nil && !errors.Is(err, os.ErrNotExist) {
			failures = errors.Join(failures, err)
			continue
		}
		if err := os.Rename(previous, replacement.Target); err != nil {
			failures = errors.Join(failures, err)
		}
	}
	return failures
}

// RollbackAvailable reports whether every target still has the binary it
// displaced. A rollback that could only restore some of them would leave the
// mixed-version combination this package exists to avoid.
func RollbackAvailable(transaction Transaction) bool {
	if len(transaction.Replaced) == 0 {
		return false
	}
	for _, replacement := range transaction.Replaced {
		info, err := os.Lstat(replacement.Target + PreviousSuffix)
		if err != nil || !info.Mode().IsRegular() {
			return false
		}
	}
	return true
}

// ErrMaintenanceRequired is the answer when the new version failed its health
// check but rolling back is not safe: the database has already migrated, and
// the previous binary would refuse to open it. Reinstalling the old binary
// there would turn a failed upgrade into an unstartable deployment, so the
// operator is told what happened instead of being quietly put in that state.
var ErrMaintenanceRequired = errors.New("MAINTENANCE_REQUIRED")

// Maintenance describes why an automatic rollback was refused.
type Maintenance struct {
	// MigratedTo is the schema version the new binary advanced the database to.
	MigratedTo uint64
	// InstalledBefore is the schema version the previous binary understood.
	InstalledBefore uint64
}

func (m Maintenance) Error() string {
	return fmt.Sprintf("%s: the database advanced to schema %d and the previous binary understands %d; restore a backup or install a build that migrates forward",
		ErrMaintenanceRequired.Error(), m.MigratedTo, m.InstalledBefore)
}

func (m Maintenance) Unwrap() error { return ErrMaintenanceRequired }

// SafeToRollback reports whether the binaries may be put back. A database that
// the new version migrated is a one-way door: the ledger moved, and the
// previous build refuses an unknown schema rather than guessing at it.
func SafeToRollback(before, after uint64) error {
	if after > before {
		return Maintenance{MigratedTo: after, InstalledBefore: before}
	}
	return nil
}
