package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"armadra.local/host/internal/servicedef"
)

// captureStdout redirects the process's stdout into a file for the duration of
// one command, so a test can assert on what an operator would see.
func captureStdout(t *testing.T, invoke func() error) (string, error) {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "stdout-*")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	original := os.Stdout
	os.Stdout = file
	invokeErr := invoke()
	os.Stdout = original
	data, err := os.ReadFile(file.Name())
	if err != nil {
		t.Fatal(err)
	}
	return string(data), invokeErr
}

// hostDataDir is a temporary data directory with the 0700 mode the Host's own
// control IPC requires; t.TempDir leaves its directories group-readable.
func hostDataDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

// installArgs generates a definition into serviceDir for a data directory the
// test owns. The listener is a port nothing in this repository binds.
func installArgs(dataDir, serviceDir, platform string, extra ...string) []string {
	args := []string{
		"install", "--data-dir", dataDir, "--service-dir", serviceDir,
		"--run-as", "armadra", "--listen", "127.0.0.1:45993", "--target-platform", platform,
	}
	return append(args, extra...)
}

func TestInstallWritesADefinitionAndRegistersNothing(t *testing.T) {
	dataDir, serviceDir := hostDataDir(t), filepath.Join(t.TempDir(), "definitions")
	output, err := captureStdout(t, func() error {
		return run(installArgs(dataDir, serviceDir, servicedef.PlatformLinux))
	})
	if err != nil {
		t.Fatal(err)
	}
	var result installResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("install printed %q: %v", output, err)
	}
	if result.Registered {
		t.Fatal("install reported that it registered the service")
	}
	if result.RunAs != "armadra" || filepath.Dir(result.Path) != serviceDir {
		t.Fatalf("unexpected result: %+v", result)
	}
	content, err := os.ReadFile(result.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "User=armadra") || !strings.Contains(string(content), dataDir) {
		t.Fatalf("definition does not describe this deployment:\n%s", content)
	}
	if _, err := servicedef.ReadMarker(dataDir); err != nil {
		t.Fatalf("install did not record the definition: %v", err)
	}
}

func TestInstallRequiresAnExplicitAccountAndDirectory(t *testing.T) {
	dataDir, serviceDir := hostDataDir(t), t.TempDir()
	cases := map[string][]string{
		"no service directory": {"install", "--data-dir", dataDir, "--run-as", "armadra"},
		"relative directory":   {"install", "--data-dir", dataDir, "--service-dir", "definitions", "--run-as", "armadra"},
		"no account":           {"install", "--data-dir", dataDir, "--service-dir", serviceDir},
		"blank account":        {"install", "--data-dir", dataDir, "--service-dir", serviceDir, "--run-as", "  "},
		"superuser account":    {"install", "--data-dir", dataDir, "--service-dir", serviceDir, "--run-as", "root"},
		// A release source can carry a credential in its URL; it must not be
		// copied into a file the service manager and operators can read.
		"release source": {"install", "--data-dir", dataDir, "--service-dir", serviceDir, "--run-as", "armadra", "--updates-source", "https://api.github.com/repos/owner/repo"},
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := captureStdout(t, func() error { return run(args) }); err == nil {
				t.Fatal("accepted an under-specified install")
			}
			if entries, err := os.ReadDir(serviceDir); err != nil {
				t.Fatal(err)
			} else if len(entries) != 0 {
				t.Fatal("a refused install still wrote a file")
			}
		})
	}
}

func TestStatusReportsTheDefinitionAndKeepsItsShapeWithout(t *testing.T) {
	dataDir, serviceDir := hostDataDir(t), filepath.Join(t.TempDir(), "definitions")
	plain, err := captureStdout(t, func() error { return run([]string{"status", "--data-dir", dataDir}) })
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(plain) != `{"state":"stopped"}` {
		t.Fatalf("status without a definition printed %q", plain)
	}
	if _, err := captureStdout(t, func() error {
		return run(installArgs(dataDir, serviceDir, runtime.GOOS))
	}); err != nil {
		t.Fatal(err)
	}
	output, err := captureStdout(t, func() error { return run([]string{"status", "--data-dir", dataDir}) })
	if err != nil {
		t.Fatal(err)
	}
	var reported statusWithService
	if err := json.Unmarshal([]byte(output), &reported); err != nil {
		t.Fatalf("status printed %q: %v", output, err)
	}
	if reported.State != "stopped" {
		t.Fatalf("status changed the host state to %q", reported.State)
	}
	if !reported.Service.Present || !reported.Service.Matches || reported.Service.RunAs != "armadra" {
		t.Fatalf("status did not describe the definition: %+v", reported.Service)
	}
	// A hand-edited definition is reported as drift, never repaired.
	if err := os.WriteFile(reported.Service.Path, []byte("edited by the operator\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	output, err = captureStdout(t, func() error { return run([]string{"status", "--data-dir", dataDir}) })
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(output), &reported); err != nil {
		t.Fatal(err)
	}
	if reported.Service.Matches || reported.Service.Detail == "" {
		t.Fatalf("edited definition was reported as matching: %+v", reported.Service)
	}
}

func TestUninstallRemovesOnlyItsOwnDefinition(t *testing.T) {
	dataDir, serviceDir := hostDataDir(t), filepath.Join(t.TempDir(), "definitions")
	if _, err := captureStdout(t, func() error {
		return run(installArgs(dataDir, serviceDir, runtime.GOOS))
	}); err != nil {
		t.Fatal(err)
	}
	marker, err := servicedef.ReadMarker(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	foreign := []byte("someone else's service definition\n")
	if err := os.WriteFile(marker.Path, foreign, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := captureStdout(t, func() error { return run([]string{"uninstall", "--data-dir", dataDir}) }); err == nil {
		t.Fatal("removed a definition it did not generate")
	}
	if content, err := os.ReadFile(marker.Path); err != nil || string(content) != string(foreign) {
		t.Fatalf("the foreign file was modified: %v", err)
	}
	// Regenerate ours, then remove it.
	if _, err := captureStdout(t, func() error {
		return run(installArgs(dataDir, serviceDir, runtime.GOOS))
	}); err != nil {
		t.Fatal(err)
	}
	output, err := captureStdout(t, func() error { return run([]string{"uninstall", "--data-dir", dataDir}) })
	if err != nil {
		t.Fatal(err)
	}
	var removed uninstallResult
	if err := json.Unmarshal([]byte(output), &removed); err != nil {
		t.Fatalf("uninstall printed %q: %v", output, err)
	}
	if !removed.Removed || removed.Path != marker.Path {
		t.Fatalf("unexpected uninstall result: %+v", removed)
	}
	if _, err := os.Lstat(marker.Path); !os.IsNotExist(err) {
		t.Fatalf("definition still present: %v", err)
	}
	// A second run has nothing to remove and says so instead of succeeding.
	if _, err := captureStdout(t, func() error { return run([]string{"uninstall", "--data-dir", dataDir}) }); err == nil {
		t.Fatal("uninstall succeeded twice")
	}
}

func TestLogsTailsTheDiagnosticFile(t *testing.T) {
	dataDir := hostDataDir(t)
	if _, err := captureStdout(t, func() error { return run([]string{"logs", "--data-dir", dataDir}) }); err == nil {
		t.Fatal("logs succeeded with no log file")
	}
	path := filepath.Join(dataDir, "startup-abc.log")
	if err := os.WriteFile(path, []byte("first\nsecond\nthird\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	output, err := captureStdout(t, func() error { return run([]string{"logs", "--data-dir", dataDir, "--lines", "2"}) })
	if err != nil {
		t.Fatal(err)
	}
	if output != "second\nthird\n" {
		t.Fatalf("logs printed %q", output)
	}
	output, err = captureStdout(t, func() error {
		return run([]string{"logs", "--data-dir", dataDir, "--lines", "1", "--output", "json"})
	})
	if err != nil {
		t.Fatal(err)
	}
	var result logsResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("logs printed %q: %v", output, err)
	}
	if result.Path != path || len(result.Lines) != 1 || result.Lines[0] != "third" {
		t.Fatalf("unexpected logs result: %+v", result)
	}
}

func TestVersionReportsTheProtocolWithoutState(t *testing.T) {
	output, err := captureStdout(t, func() error { return run([]string{"version"}) })
	if err != nil {
		t.Fatal(err)
	}
	var reported versionReport
	if err := json.Unmarshal([]byte(output), &reported); err != nil {
		t.Fatalf("version printed %q: %v", output, err)
	}
	if reported.Component != servicedef.ComponentName || reported.ProtocolMajor == 0 {
		t.Fatalf("unexpected version report: %+v", reported)
	}
}

// candidate writes an executable that answers `version` the way a Host binary
// does. Upgrade tests never touch a real installed binary: hostExecutable is
// pointed at a copy the test owns.
func candidate(t *testing.T, body string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the candidate is a shell script; upgrade refusals are covered on Unix")
	}
	path := filepath.Join(t.TempDir(), "armadra-host-next")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func installedCopy(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "armadra-host")
	if err := os.WriteFile(path, []byte("installed binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	original := hostExecutable
	hostExecutable = func() (string, error) { return path, nil }
	t.Cleanup(func() { hostExecutable = original })
	return path
}

func upgradeConfig(t *testing.T, binary string, confirm bool) config {
	t.Helper()
	return config{
		command: "upgrade", dataDir: hostDataDir(t), output: "json",
		service: serviceFlags{binary: binary, confirm: confirm},
	}
}

func TestUpgradeWithoutConfirmChangesNothing(t *testing.T) {
	next := candidate(t, `echo '{"component":"armadra-host","protocolMajor":1,"protocolMinor":1}'`)
	target := installedCopy(t)
	output, err := captureStdout(t, func() error {
		return upgradeHost(context.Background(), upgradeConfig(t, next, false))
	})
	if err != nil {
		t.Fatal(err)
	}
	var result upgradeResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("upgrade printed %q: %v", output, err)
	}
	if result.Applied || result.Restarted {
		t.Fatalf("a dry run reported a change: %+v", result)
	}
	if content, err := os.ReadFile(target); err != nil || string(content) != "installed binary" {
		t.Fatalf("the installed binary was touched: %q (%v)", content, err)
	}
}

func TestUpgradeRefusalsLeaveTheBinaryInPlace(t *testing.T) {
	cases := map[string]func(t *testing.T) string{
		"protocol mismatch": func(t *testing.T) string {
			return candidate(t, `echo '{"component":"armadra-host","protocolMajor":9,"protocolMinor":0}'`)
		},
		"foreign component": func(t *testing.T) string {
			return candidate(t, `echo '{"component":"some-other-host","protocolMajor":1}'`)
		},
		"silent candidate": func(t *testing.T) string { return candidate(t, `exit 1`) },
		"not executable": func(t *testing.T) string {
			path := filepath.Join(t.TempDir(), "candidate")
			if err := os.WriteFile(path, []byte("binary"), 0o644); err != nil {
				t.Fatal(err)
			}
			return path
		},
		"missing candidate": func(t *testing.T) string { return filepath.Join(t.TempDir(), "absent") },
	}
	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			next := build(t)
			target := installedCopy(t)
			// --confirm is set: the refusal has to come from verification, not
			// from the missing confirmation.
			if _, err := captureStdout(t, func() error {
				return upgradeHost(context.Background(), upgradeConfig(t, next, true))
			}); err == nil {
				t.Fatalf("accepted %s", name)
			}
			if content, err := os.ReadFile(target); err != nil || string(content) != "installed binary" {
				t.Fatalf("the installed binary changed: %q (%v)", content, err)
			}
		})
	}
}

func TestUpgradeRefusesToReplaceItselfWithItself(t *testing.T) {
	target := installedCopy(t)
	if _, err := captureStdout(t, func() error {
		return upgradeHost(context.Background(), upgradeConfig(t, target, true))
	}); err == nil {
		t.Fatal("accepted the installed binary as its own candidate")
	}
}
