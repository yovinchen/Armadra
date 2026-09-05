package servicedef

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// installed writes a set of files that stand in for installed binaries and
// returns the replacements that would put the candidates over them.
func installed(t *testing.T, names ...string) ([]Replacement, string) {
	t.Helper()
	directory := t.TempDir()
	candidates := t.TempDir()
	replacements := make([]Replacement, 0, len(names))
	for _, name := range names {
		target := filepath.Join(directory, name)
		if err := os.WriteFile(target, []byte("old "+name), 0o755); err != nil {
			t.Fatal(err)
		}
		candidate := filepath.Join(candidates, name)
		if err := os.WriteFile(candidate, []byte("new "+name), 0o755); err != nil {
			t.Fatal(err)
		}
		replacements = append(replacements, Replacement{Component: name, Candidate: candidate, Target: target})
	}
	return replacements, directory
}

func contents(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestReplaceAllInstallsEveryBinaryAndKeepsThePreviousOnes(t *testing.T) {
	replacements, _ := installed(t, "armadra-runtime", "armadra-host")
	transaction, err := ReplaceAll(replacements)
	if err != nil {
		t.Fatal(err)
	}
	if len(transaction.Replaced) != 2 || len(transaction.Targets()) != 2 {
		t.Fatalf("transaction recorded %+v", transaction)
	}
	for _, replacement := range replacements {
		if got := contents(t, replacement.Target); got != "new "+replacement.Component {
			t.Fatalf("%s holds %q", replacement.Component, got)
		}
		// The displaced binary stays until the next successful upgrade,
		// because a rollback needs something to go back to.
		if got := contents(t, replacement.Target+PreviousSuffix); got != "old "+replacement.Component {
			t.Fatalf("%s%s holds %q", replacement.Component, PreviousSuffix, got)
		}
	}
	if !RollbackAvailable(transaction) {
		t.Fatal("a successful transaction left nothing to roll back to")
	}
	// Nothing staged is left lying about next to the installed files.
	entries, err := os.ReadDir(filepath.Dir(replacements[0].Target))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 4 {
		t.Fatalf("the directory holds %d entries after a clean upgrade", len(entries))
	}
}

// Half the components at each version is a combination nobody declared
// compatible. A candidate that cannot be staged must therefore leave every
// installed file untouched, not just the ones after it.
func TestReplaceAllLeavesEveryTargetAloneWhenOneCandidateIsBad(t *testing.T) {
	replacements, directory := installed(t, "armadra-runtime", "armadra-host")
	replacements[1].Candidate = filepath.Join(t.TempDir(), "absent")
	if _, err := ReplaceAll(replacements); err == nil {
		t.Fatal("accepted a transaction with a missing candidate")
	}
	for _, name := range []string{"armadra-runtime", "armadra-host"} {
		if got := contents(t, filepath.Join(directory, name)); got != "old "+name {
			t.Fatalf("%s changed to %q", name, got)
		}
		if _, err := os.Lstat(filepath.Join(directory, name+PreviousSuffix)); err == nil {
			t.Fatalf("%s was moved aside by a refused transaction", name)
		}
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("a refused transaction left %d entries behind", len(entries))
	}
}

// The rename half can fail too. Making the target's directory unwritable after
// the first rename forces the second one to fail, and the first must be undone.
func TestReplaceAllUndoesEarlierRenamesWhenALaterOneFails(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory permissions do not stop a rename on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("the superuser is not stopped by directory permissions")
	}
	replacements, first := installed(t, "armadra-runtime")
	second, secondDir := installed(t, "armadra-host")
	replacements = append(replacements, second...)
	// Stage both, then take away the second directory's write bit: staging has
	// already happened, so only the rename can fail.
	if err := os.Chmod(secondDir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(secondDir, 0o700) })
	if _, err := ReplaceAll(replacements); err == nil {
		t.Fatal("accepted a transaction whose second rename could not happen")
	}
	if got := contents(t, filepath.Join(first, "armadra-runtime")); got != "old armadra-runtime" {
		t.Fatalf("the first target was left at %q after a failed transaction", got)
	}
}

func TestRollbackRestoresEveryBinaryAndKeepsTheFailedOne(t *testing.T) {
	replacements, directory := installed(t, "armadra-runtime", "armadra-host")
	transaction, err := ReplaceAll(replacements)
	if err != nil {
		t.Fatal(err)
	}
	if err := Rollback(transaction); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"armadra-runtime", "armadra-host"} {
		if got := contents(t, filepath.Join(directory, name)); got != "old "+name {
			t.Fatalf("%s came back as %q", name, got)
		}
		// The binary that failed is moved aside rather than deleted: it is the
		// only copy of what went wrong.
		if got := contents(t, filepath.Join(directory, name+".failed")); got != "new "+name {
			t.Fatalf("%s.failed holds %q", name, got)
		}
	}
}

func TestRollbackNeedsEveryPreviousBinary(t *testing.T) {
	replacements, directory := installed(t, "armadra-runtime", "armadra-host")
	transaction, err := ReplaceAll(replacements)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(directory, "armadra-host"+PreviousSuffix)); err != nil {
		t.Fatal(err)
	}
	// A rollback that could restore only some of them would leave exactly the
	// mixed-version state the transaction exists to avoid.
	if RollbackAvailable(transaction) {
		t.Fatal("reported a rollback as available with one saved binary missing")
	}
	if err := Rollback(transaction); err == nil {
		t.Fatal("rolled back with one saved binary missing")
	}
	if err := Rollback(Transaction{}); !errors.Is(err, ErrUpgradeRefused) {
		t.Fatalf("an empty transaction produced %v", err)
	}
	if RollbackAvailable(Transaction{}) {
		t.Fatal("an empty transaction claimed a rollback was available")
	}
}

// A database the new build already migrated is a one-way door: the previous
// binary refuses an unknown schema, so putting it back would turn a failed
// upgrade into a deployment that will not start at all.
func TestAMigratedDatabaseStopsAnAutomaticRollback(t *testing.T) {
	if err := SafeToRollback(4, 4); err != nil {
		t.Fatalf("an unchanged ledger refused a rollback: %v", err)
	}
	if err := SafeToRollback(4, 3); err != nil {
		t.Fatalf("a ledger that did not advance refused a rollback: %v", err)
	}
	err := SafeToRollback(4, 5)
	if !errors.Is(err, ErrMaintenanceRequired) {
		t.Fatalf("a migrated database produced %v", err)
	}
	var maintenance Maintenance
	if !errors.As(err, &maintenance) || maintenance.MigratedTo != 5 || maintenance.InstalledBefore != 4 {
		t.Fatalf("the maintenance answer did not carry both schema versions: %v", err)
	}
	if got := err.Error(); got == "" || !errors.Is(err, ErrMaintenanceRequired) {
		t.Fatalf("maintenance error text is %q", got)
	}
}

func TestReplaceAllRefusesAnEmptyTransaction(t *testing.T) {
	if _, err := ReplaceAll(nil); !errors.Is(err, ErrUpgradeRefused) {
		t.Fatalf("an empty transaction produced %v", err)
	}
}
