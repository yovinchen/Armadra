package servicedef

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// recorder is the Registrar every test here uses. Registering a real service
// would leave a launchd job or a systemd unit behind on whatever machine ran
// the suite, so the decision logic is exercised and the commands are recorded
// rather than run. The real registrar is one small type in register_exec.go
// with nothing to decide.
type recorder struct {
	ran  []string
	fail int
	err  error
}

func (r *recorder) Run(_ context.Context, command Command) (string, string, error) {
	r.ran = append(r.ran, command.String())
	if r.err != nil && len(r.ran) == r.fail {
		return "", "the service manager said no", r.err
	}
	return "", "", nil
}

func registrableSpec(t *testing.T, platform string) (Spec, string) {
	t.Helper()
	directory := t.TempDir()
	spec := Spec{
		Identifier: "local.armadra.host",
		Platform:   platform,
		Executable: filepath.Join(directory, "armadra-host"),
		RunAs:      "armadra",
		DataDir:    filepath.Join(directory, "data"),
		Listen:     "127.0.0.1:43121",
	}
	if err := spec.Normalize(); err != nil {
		t.Fatal(err)
	}
	path, _, err := Generate(spec, directory)
	if err != nil {
		t.Fatal(err)
	}
	return spec, path
}

func TestCanonicalDirNamesWhatEachManagerReads(t *testing.T) {
	home := "/home/armadra"
	for _, want := range []struct {
		platform, scope, dir string
	}{
		{PlatformDarwin, ScopeSystem, "/Library/LaunchDaemons"},
		{PlatformDarwin, ScopeUser, "/home/armadra/Library/LaunchAgents"},
		{PlatformLinux, ScopeSystem, "/etc/systemd/system"},
		{PlatformLinux, ScopeUser, "/home/armadra/.config/systemd/user"},
		// Windows registers from a command, so there is no directory a wrong
		// choice could hide a service in.
		{PlatformWindows, ScopeSystem, ""},
	} {
		got, err := CanonicalDir(want.platform, want.scope, home)
		if err != nil || got != filepath.FromSlash(want.dir) {
			t.Fatalf("%s/%s produced %q (%v)", want.platform, want.scope, got, err)
		}
	}
	// Windows has no user-level services; inventing one would generate
	// something no service manager reads.
	if _, err := CanonicalDir(PlatformWindows, ScopeUser, home); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("a Windows user service produced %v", err)
	}
	if _, err := CanonicalDir(PlatformLinux, "everyone", home); !errors.Is(err, ErrRegister) {
		t.Fatal("accepted an unknown scope")
	}
	if _, err := CanonicalDir(PlatformDarwin, ScopeUser, ""); !errors.Is(err, ErrRegister) {
		t.Fatal("produced a LaunchAgent directory with no home directory")
	}
}

func TestPlansNameTheCommandsEachManagerNeeds(t *testing.T) {
	for _, want := range []struct {
		platform, scope string
		register        []string
		unregister      []string
	}{
		{PlatformDarwin, ScopeSystem,
			[]string{"launchctl bootstrap system ", "launchctl enable system/local.armadra.host"},
			[]string{"launchctl bootout system/local.armadra.host"}},
		{PlatformLinux, ScopeSystem,
			[]string{"systemctl daemon-reload", "systemctl enable --now local.armadra.host.service"},
			[]string{"systemctl disable --now local.armadra.host.service", "systemctl daemon-reload"}},
		{PlatformLinux, ScopeUser,
			[]string{"systemctl --user daemon-reload", "systemctl --user enable --now local.armadra.host.service"},
			[]string{"systemctl --user disable --now local.armadra.host.service", "systemctl --user daemon-reload"}},
		{PlatformWindows, ScopeSystem,
			[]string{"sc.exe create local-armadra-host", "sc.exe start local-armadra-host"},
			[]string{"sc.exe stop local-armadra-host", "sc.exe delete local-armadra-host"}},
	} {
		spec, path := registrableSpec(t, want.platform)
		plan, err := RegisterPlan(spec, path, want.scope)
		if err != nil {
			t.Fatal(err)
		}
		assertCommands(t, want.platform+"/"+want.scope+" register", plan.Commands, want.register)
		undo, err := UnregisterPlan(spec, path, want.scope)
		if err != nil {
			t.Fatal(err)
		}
		assertCommands(t, want.platform+"/"+want.scope+" unregister", undo.Commands, want.unregister)
	}
}

func assertCommands(t *testing.T, what string, got []Command, wantPrefixes []string) {
	t.Helper()
	if len(got) != len(wantPrefixes) {
		t.Fatalf("%s planned %d commands, expected %d: %v", what, len(got), len(wantPrefixes), got)
	}
	for index, prefix := range wantPrefixes {
		if !strings.HasPrefix(got[index].String(), prefix) {
			t.Fatalf("%s command %d is %q, expected it to start with %q", what, index+1, got[index], prefix)
		}
	}
}

// A password is asked for by sc.exe itself. Passing one as an argument would
// put it in every process listing on the machine.
func TestTheWindowsPlanNeverCarriesAPassword(t *testing.T) {
	spec, path := registrableSpec(t, PlatformWindows)
	plan, err := RegisterPlan(spec, path, ScopeSystem)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Note == "" {
		t.Fatal("the Windows plan does not say who asks for the account password")
	}
	// sc.exe takes "key= value" pairs; the password one is simply never built.
	for _, command := range plan.Commands {
		for _, argument := range command.Args {
			if strings.HasSuffix(argument, "=") && strings.Contains(strings.ToLower(argument), "password") {
				t.Fatalf("the plan names %q", argument)
			}
		}
	}
	if _, err := RegisterPlan(spec, path, ScopeUser); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("a Windows user service produced %v", err)
	}
}

func TestPreflightRefusesWhatWouldRegisterNothingUseful(t *testing.T) {
	home := t.TempDir()
	spec, path := registrableSpec(t, PlatformLinux)

	// The generated directory is a temporary one, so it is never the canonical
	// location: registering from it would produce a service systemd never reads.
	if err := PreflightRegister(spec, path, ScopeSystem, true, home); !errors.Is(err, ErrRegister) {
		t.Fatalf("accepted a definition outside the canonical directory: %v", err)
	}
	if err := PreflightRegister(spec, path, ScopeSystem, false, home); !errors.Is(err, ErrRegister) {
		t.Fatal("accepted a system registration without elevation")
	}
	// A system scope without elevation is refused before anything else, and the
	// message says how to fix it rather than elevating on the operator's behalf.
	err := PreflightRegister(spec, path, ScopeSystem, false, home)
	if !strings.Contains(err.Error(), "re-run this command elevated") {
		t.Fatalf("the elevation refusal reads %q", err)
	}
}

// A hand-edited definition is the operator's, not ours. Registering it would
// act on somebody else's intent, and regenerating it would lose their change.
func TestPreflightRefusesADriftedDefinition(t *testing.T) {
	home := t.TempDir()
	canonical := filepath.Join(home, ".config", "systemd", "user")
	if err := os.MkdirAll(canonical, 0o700); err != nil {
		t.Fatal(err)
	}
	spec := Spec{
		Identifier: "local.armadra.host",
		Platform:   PlatformLinux,
		Executable: filepath.Join(home, "armadra-host"),
		RunAs:      "armadra",
		DataDir:    filepath.Join(home, "data"),
		Listen:     "127.0.0.1:43121",
	}
	if err := spec.Normalize(); err != nil {
		t.Fatal(err)
	}
	path, _, err := Generate(spec, canonical)
	if err != nil {
		t.Fatal(err)
	}
	if err := PreflightRegister(spec, path, ScopeUser, false, home); err != nil {
		t.Fatalf("refused a definition in the canonical directory: %v", err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(content, []byte("\n# edited by hand\n")...), 0o644); err != nil {
		t.Fatal(err)
	}
	err = PreflightRegister(spec, path, ScopeUser, false, home)
	if !errors.Is(err, ErrRegister) || !strings.Contains(err.Error(), "differs from what this binary generates") {
		t.Fatalf("a hand-edited definition produced %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := PreflightRegister(spec, path, ScopeUser, false, home); !errors.Is(err, ErrRegister) {
		t.Fatal("accepted a registration with no definition on disk")
	}
}

func TestExecuteStopsAtTheFirstFailureAndKeepsTheManagersWords(t *testing.T) {
	spec, path := registrableSpec(t, PlatformLinux)
	plan, err := RegisterPlan(spec, path, ScopeSystem)
	if err != nil {
		t.Fatal(err)
	}
	clean := &recorder{}
	if err := Execute(context.Background(), clean, plan); err != nil {
		t.Fatal(err)
	}
	if len(clean.ran) != len(plan.Commands) {
		t.Fatalf("ran %v", clean.ran)
	}
	broken := &recorder{fail: 1, err: errors.New("exit status 1")}
	err = Execute(context.Background(), broken, plan)
	if !errors.Is(err, ErrRegister) {
		t.Fatalf("a failing manager produced %v", err)
	}
	// The manager's own words reach the operator unchanged: a paraphrase is not
	// what they need to debug a refused registration.
	if !strings.Contains(err.Error(), "the service manager said no") {
		t.Fatalf("the failure lost the manager's message: %v", err)
	}
	if len(broken.ran) != 1 {
		t.Fatalf("kept going after a failure: %v", broken.ran)
	}
}

// The real registrar launches programs, so it accepts only the three it knows.
func TestTheSystemRegistrarRunsOnlyServiceManagers(t *testing.T) {
	_, _, err := SystemRegistrar{}.Run(context.Background(), Command{Program: "sh", Args: []string{"-c", "echo hi"}})
	if !errors.Is(err, ErrRegister) {
		t.Fatalf("ran an arbitrary program: %v", err)
	}
	_, _, err = SystemRegistrar{}.Run(context.Background(), Command{})
	if !errors.Is(err, ErrRegister) {
		t.Fatal("ran an empty command")
	}
}
