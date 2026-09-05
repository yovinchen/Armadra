package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"armadra.local/host/internal/servicedef"
)

// fakeRegistrar records what would have been run. No test in this package
// registers a service on the machine running it: the real registrar is a thin
// exec wrapper, and everything that decides whether to call it is asserted here
// and in servicedef's own tests.
type fakeRegistrar struct {
	ran []string
	err error
}

func (f *fakeRegistrar) Run(_ context.Context, command servicedef.Command) (string, string, error) {
	f.ran = append(f.ran, command.String())
	return "", "manager output", f.err
}

// withRegistrar substitutes the recorder and says whether this process should
// pretend to be elevated.
func withRegistrar(t *testing.T, asElevated bool) *fakeRegistrar {
	t.Helper()
	fake := &fakeRegistrar{}
	originalRegistrar, originalElevated := registrar, elevated
	registrar, elevated = fake, func() bool { return asElevated }
	t.Cleanup(func() { registrar, elevated = originalRegistrar, originalElevated })
	return fake
}

// canonicalInstall generates a definition in the directory this platform's
// service manager actually reads, using a fake home so nothing outside the
// test's own temporary directories is written.
func canonicalInstall(t *testing.T, scope string, extra ...string) (config, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	directory, err := servicedef.CanonicalDir(runtime.GOOS, scope, home)
	if err != nil {
		t.Skipf("this platform has no canonical %s directory: %v", scope, err)
	}
	if directory == "" {
		t.Skip("this platform registers from a command rather than a directory")
	}
	if !strings.HasPrefix(directory, home) {
		t.Skip("the canonical directory for this scope is outside the test's control")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	dataDir := hostDataDir(t)
	args := append(installArgs(dataDir, directory, runtime.GOOS), extra...)
	c, err := parseConfig(args)
	if err != nil {
		t.Fatal(err)
	}
	return c, filepath.Join(directory, servicedef.Spec{Identifier: c.service.identifier, Platform: c.service.platform}.FileName())
}

// Without --register nothing on the machine is touched, which is what install
// has always done.
func TestInstallWithoutRegisterRunsNoServiceManager(t *testing.T) {
	fake := withRegistrar(t, true)
	dataDir := hostDataDir(t)
	c, err := parseConfig(installArgs(dataDir, t.TempDir(), servicedef.PlatformLinux))
	if err != nil {
		t.Fatal(err)
	}
	output, err := captureStdout(t, func() error { return installService(context.Background(), c) })
	if err != nil {
		t.Fatal(err)
	}
	var result installResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("install printed %q: %v", output, err)
	}
	if result.Registered || len(result.Planned) != 0 || len(fake.ran) != 0 {
		t.Fatalf("install touched the service manager: %+v %v", result, fake.ran)
	}
}

// --register without --confirm prints the exact commands and changes nothing.
// "Show me what you would do" is the only way an operator can review a
// machine-wide change before it happens.
func TestRegisterWithoutConfirmOnlyPrintsThePlan(t *testing.T) {
	fake := withRegistrar(t, false)
	c, _ := canonicalInstall(t, servicedef.ScopeUser, "--register", "--scope", "user")
	output, err := captureStdout(t, func() error { return installService(context.Background(), c) })
	if err != nil {
		t.Fatal(err)
	}
	var result installResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("install printed %q: %v", output, err)
	}
	if len(result.Planned) == 0 {
		t.Fatal("a dry run printed no commands")
	}
	if result.Registered || len(fake.ran) != 0 {
		t.Fatalf("a dry run ran %v", fake.ran)
	}
	if !strings.Contains(result.Note, "--confirm") {
		t.Fatalf("the note does not say how to proceed: %q", result.Note)
	}
}

// A system service needs elevation, and this command never elevates itself: a
// program that does has decided for the operator.
func TestRegisteringASystemServiceNeedsElevation(t *testing.T) {
	fake := withRegistrar(t, false)
	dataDir := hostDataDir(t)
	c, err := parseConfig(append(installArgs(dataDir, t.TempDir(), servicedef.PlatformLinux), "--register", "--confirm"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = captureStdout(t, func() error { return installService(context.Background(), c) })
	if !errors.Is(err, servicedef.ErrRegister) {
		t.Fatalf("an unelevated system registration produced %v", err)
	}
	if len(fake.ran) != 0 {
		t.Fatalf("ran %v before refusing", fake.ran)
	}
}

// A definition somebody edited is theirs. Registering it would act on their
// intent without asking, and regenerating it would lose the change.
func TestRegisterRefusesADriftedDefinition(t *testing.T) {
	fake := withRegistrar(t, true)
	// Install without --confirm so the file exists and nothing was registered,
	// then edit it and put the edited file through the same preflight.
	c, path := canonicalInstall(t, servicedef.ScopeUser, "--register", "--scope", "user")
	if _, err := captureStdout(t, func() error { return installService(context.Background(), c) }); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(content, []byte("\n# edited\n")...), 0o644); err != nil {
		t.Fatal(err)
	}
	// install regenerates the file, so point the registration at the edited one
	// directly through the preflight the command uses.
	spec := servicedef.Spec{
		Identifier: c.service.identifier, Platform: c.service.platform,
		Executable: filepath.Join(t.TempDir(), "armadra-host"), RunAs: c.service.runAs,
		DataDir: c.dataDir, Listen: c.address,
	}
	if err := spec.Normalize(); err != nil {
		t.Fatal(err)
	}
	home, _ := os.UserHomeDir()
	if err := servicedef.PreflightRegister(spec, path, servicedef.ScopeUser, true, home); !errors.Is(err, servicedef.ErrRegister) {
		t.Fatalf("a drifted definition produced %v", err)
	}
	_ = fake
}

// uninstall --unregister stops and unregisters before removing the file: a
// manager asked to delete a running service leaves it running, and removing a
// registered definition leaves the manager pointing at a file that is gone.
func TestUnregisterStopsBeforeRemovingTheDefinition(t *testing.T) {
	fake := withRegistrar(t, true)
	c, path := canonicalInstall(t, servicedef.ScopeUser, "--register", "--scope", "user")
	if _, err := captureStdout(t, func() error { return installService(context.Background(), c) }); err != nil {
		t.Fatal(err)
	}
	removal, err := parseConfig([]string{
		"uninstall", "--data-dir", c.dataDir, "--service-dir", filepath.Dir(path),
		"--target-platform", c.service.platform, "--unregister", "--scope", "user", "--confirm",
	})
	if err != nil {
		t.Fatal(err)
	}
	output, err := captureStdout(t, func() error { return uninstallService(context.Background(), removal) })
	if err != nil {
		t.Fatal(err)
	}
	var result uninstallResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("uninstall printed %q: %v", output, err)
	}
	if !result.Unregistered || !result.Removed {
		t.Fatalf("uninstall reported %+v", result)
	}
	if len(fake.ran) == 0 || !strings.Contains(fake.ran[0], "disable") && !strings.Contains(fake.ran[0], "bootout") {
		t.Fatalf("the first command was not a stop: %v", fake.ran)
	}
	if _, err := os.Lstat(path); err == nil {
		t.Fatal("the definition survived uninstall")
	}
	// The data directory is a separate concern from the deployment and is
	// never removed with it.
	if _, err := os.Lstat(c.dataDir); err != nil {
		t.Fatalf("uninstall touched the data directory: %v", err)
	}
}

func TestUninstallWithUnregisterButNoConfirmChangesNothing(t *testing.T) {
	fake := withRegistrar(t, true)
	c, path := canonicalInstall(t, servicedef.ScopeUser, "--register", "--scope", "user")
	if _, err := captureStdout(t, func() error { return installService(context.Background(), c) }); err != nil {
		t.Fatal(err)
	}
	removal, err := parseConfig([]string{
		"uninstall", "--data-dir", c.dataDir, "--service-dir", filepath.Dir(path),
		"--target-platform", c.service.platform, "--unregister", "--scope", "user",
	})
	if err != nil {
		t.Fatal(err)
	}
	fake.ran = nil
	if _, err := captureStdout(t, func() error { return uninstallService(context.Background(), removal) }); err != nil {
		t.Fatal(err)
	}
	if len(fake.ran) != 0 {
		t.Fatalf("a dry run ran %v", fake.ran)
	}
	if _, err := os.Lstat(path); err != nil {
		t.Fatal("a dry run removed the definition")
	}
}

func TestScopeMustBeSystemOrUser(t *testing.T) {
	dataDir := hostDataDir(t)
	if _, err := parseConfig(append(installArgs(dataDir, t.TempDir(), servicedef.PlatformLinux), "--scope", "everyone")); err == nil {
		t.Fatal("accepted an unknown scope")
	}
}
