package servicedef

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Registering a generated definition with the platform's service manager.
//
// The rest of this package writes files and touches nothing else. This part is
// the exception, and it is deliberately narrow: it runs one of three known
// programs with arguments derived from a definition this binary generated, and
// only when the operator asked for it in the same breath as `--confirm`.
//
// Every precondition is checked before anything runs, and each of them exists
// because the failure it prevents is silent. A definition in a directory the
// service manager does not read registers a service that never starts. A file
// somebody hand-edited is theirs, not ours, and overwriting it loses whatever
// they changed. And a registration nobody verified afterwards is a service an
// operator believes is running.

// Scope is who the service belongs to.
const (
	// ScopeSystem is the machine's own service, started at boot under a fixed
	// account. It needs root or an administrator.
	ScopeSystem = "system"
	// ScopeUser is a per-user service that lives as long as the user's session
	// (longer on Linux with lingering enabled).
	ScopeUser = "user"
)

// ErrRegister marks a refusal to touch the service manager. Nothing on the
// system has changed when one is returned.
var ErrRegister = errors.New("service registration refused")

// ErrUnsupported is a platform and scope combination that does not exist.
// Windows has no user-level services, and inventing one would mean generating
// something no service manager reads.
var ErrUnsupported = fmt.Errorf("%w: UNSUPPORTED", ErrRegister)

// ValidScope reports whether value names a scope.
func ValidScope(value string) bool { return value == ScopeSystem || value == ScopeUser }

// CanonicalDir is the only directory a definition may be registered from on a
// given platform and scope. Registering from anywhere else produces a service
// the manager never reads, which looks exactly like a service that is
// installed and simply not running.
func CanonicalDir(platform, scope string, home string) (string, error) {
	if !ValidScope(scope) {
		return "", fmt.Errorf("%w: scope must be system or user", ErrRegister)
	}
	switch platform {
	case PlatformDarwin:
		if scope == ScopeSystem {
			return "/Library/LaunchDaemons", nil
		}
		if home == "" {
			return "", fmt.Errorf("%w: no home directory to place a LaunchAgent in", ErrRegister)
		}
		return filepath.Join(home, "Library", "LaunchAgents"), nil
	case PlatformLinux:
		if scope == ScopeSystem {
			return "/etc/systemd/system", nil
		}
		if home == "" {
			return "", fmt.Errorf("%w: no home directory to place a user unit in", ErrRegister)
		}
		return filepath.Join(home, ".config", "systemd", "user"), nil
	case PlatformWindows:
		if scope == ScopeUser {
			return "", fmt.Errorf("%w: Windows has no user-level services", ErrUnsupported)
		}
		// Windows services are registered from a command rather than a
		// directory, so the generated script may live anywhere the operator
		// keeps it. There is nothing for a canonical directory to protect.
		return "", nil
	default:
		return "", fmt.Errorf("%w: unsupported platform %q", ErrRegister, platform)
	}
}

// Command is one service-manager invocation, ready to be shown to an operator
// before it runs. It is a program and its arguments, never a shell string:
// there is no shell involved, so nothing in a path can be interpreted.
type Command struct {
	Program string
	Args    []string
}

func (c Command) String() string {
	return strings.TrimSpace(c.Program + " " + strings.Join(c.Args, " "))
}

// Plan is everything `--register` or `--unregister` would do.
type Plan struct {
	Platform string
	Scope    string
	Path     string
	Commands []Command
	// Note carries what the operator still has to do themselves, e.g. that
	// `sc.exe` asks for an account password interactively.
	Note string
}

// Registrar runs the service manager. Tests substitute a recorder, so the
// decision logic above is exercised without registering anything on the
// machine running the tests.
type Registrar interface {
	Run(ctx context.Context, command Command) (stdout string, stderr string, err error)
}

// RegisterPlan is what registering this definition would run.
func RegisterPlan(spec Spec, path, scope string) (Plan, error) {
	return buildPlan(spec, path, scope, true)
}

// UnregisterPlan is what unregistering would run. Stopping comes before
// removing in every platform's list, because a manager asked to delete a
// running service on Windows marks it for deletion and leaves it running.
func UnregisterPlan(spec Spec, path, scope string) (Plan, error) {
	return buildPlan(spec, path, scope, false)
}

func buildPlan(spec Spec, path, scope string, register bool) (Plan, error) {
	if !ValidScope(scope) {
		return Plan{}, fmt.Errorf("%w: scope must be system or user", ErrRegister)
	}
	plan := Plan{Platform: spec.Platform, Scope: scope, Path: path}
	switch spec.Platform {
	case PlatformDarwin:
		plan.Commands = launchctlCommands(spec, path, scope, register)
	case PlatformLinux:
		plan.Commands = systemctlCommands(spec, scope, register)
	case PlatformWindows:
		if scope == ScopeUser {
			return Plan{}, fmt.Errorf("%w: Windows has no user-level services", ErrUnsupported)
		}
		plan.Commands = scCommands(spec, register)
		plan.Note = "sc.exe asks for the account password interactively; it is never passed as an argument"
	default:
		return Plan{}, fmt.Errorf("%w: unsupported platform %q", ErrRegister, spec.Platform)
	}
	return plan, nil
}

func launchctlDomain(scope string, uid string) string {
	if scope == ScopeSystem {
		return "system"
	}
	return "gui/" + uid
}

func launchctlCommands(spec Spec, path, scope string, register bool) []Command {
	domain := launchctlDomain(scope, currentUID())
	if register {
		return []Command{
			{Program: "launchctl", Args: []string{"bootstrap", domain, path}},
			{Program: "launchctl", Args: []string{"enable", domain + "/" + spec.Identifier}},
		}
	}
	return []Command{
		{Program: "launchctl", Args: []string{"bootout", domain + "/" + spec.Identifier}},
	}
}

func systemctlCommands(spec Spec, scope string, register bool) []Command {
	prefix := []string{}
	if scope == ScopeUser {
		prefix = append(prefix, "--user")
	}
	unit := spec.Identifier + ".service"
	if register {
		return []Command{
			{Program: "systemctl", Args: append(append([]string{}, prefix...), "daemon-reload")},
			{Program: "systemctl", Args: append(append([]string{}, prefix...), "enable", "--now", unit)},
		}
	}
	return []Command{
		{Program: "systemctl", Args: append(append([]string{}, prefix...), "disable", "--now", unit)},
		{Program: "systemctl", Args: append(append([]string{}, prefix...), "daemon-reload")},
	}
}

func scCommands(spec Spec, register bool) []Command {
	name := windowsServiceName(spec.Identifier)
	if register {
		return []Command{
			{Program: "sc.exe", Args: []string{"create", name,
				"binPath=", windowsBinPath(spec),
				"start=", "auto",
				"obj=", spec.RunAs,
				"DisplayName=", "Armadra Host"}},
			{Program: "sc.exe", Args: []string{"start", name}},
		}
	}
	return []Command{
		{Program: "sc.exe", Args: []string{"stop", name}},
		{Program: "sc.exe", Args: []string{"delete", name}},
	}
}

// windowsServiceName is the identifier with dots turned into dashes: sc.exe
// accepts dots but they read as path separators in half the tooling around it.
func windowsServiceName(identifier string) string {
	return strings.ReplaceAll(identifier, ".", "-")
}

func windowsBinPath(spec Spec) string {
	parts := append([]string{spec.Executable}, spec.Arguments()...)
	return strings.Join(parts, " ")
}

// PreflightRegister checks everything that must hold before the service
// manager is touched. Each refusal names what to do about it, because every
// one of them is something the operator can fix.
func PreflightRegister(spec Spec, path, scope string, elevated bool, home string) error {
	if spec.Platform == PlatformWindows && scope == ScopeUser {
		return fmt.Errorf("%w: Windows has no user-level services", ErrUnsupported)
	}
	if scope == ScopeSystem && !elevated {
		return fmt.Errorf("%w: registering a system service needs %s; re-run this command elevated rather than letting it elevate itself",
			ErrRegister, elevationHint())
	}
	canonical, err := CanonicalDir(spec.Platform, scope, home)
	if err != nil {
		return err
	}
	// Windows registers from a command rather than a directory, so there is no
	// canonical location to compare against.
	if canonical != "" && filepath.Clean(filepath.Dir(path)) != filepath.Clean(canonical) {
		return fmt.Errorf("%w: %s is not the directory the %s %s service manager reads; use --service-dir %s",
			ErrRegister, filepath.Dir(path), spec.Platform, scope, canonical)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("%w: no generated definition at %s; run install first", ErrRegister, path)
	}
	expected, err := Render(spec)
	if err != nil {
		return err
	}
	// A definition that differs from what this binary generates may have been
	// edited on purpose. Registering it would be acting on somebody else's
	// intent, and overwriting it would lose whatever they changed.
	if !bytes.Equal(content, expected) {
		return fmt.Errorf("%w: %s differs from what this binary generates; run `armadra-host status` to see the drift and re-run install if the file should be replaced",
			ErrRegister, path)
	}
	if !Owns(content, spec) {
		return fmt.Errorf("%w: %s was not generated by this command", ErrRegister, path)
	}
	return nil
}

func elevationHint() string {
	if runtime.GOOS == "windows" {
		return "an elevated administrator prompt"
	}
	return "root (sudo)"
}

// Execute runs a plan through a registrar, stopping at the first failure. The
// service manager's own stderr is returned unchanged: an operator debugging a
// refused registration needs what the manager said, not a paraphrase.
func Execute(ctx context.Context, registrar Registrar, plan Plan) error {
	for _, command := range plan.Commands {
		_, stderr, err := registrar.Run(ctx, command)
		if err != nil {
			trimmed := strings.TrimSpace(stderr)
			if trimmed == "" {
				return fmt.Errorf("%w: %s: %w", ErrRegister, command, err)
			}
			return fmt.Errorf("%w: %s: %w: %s", ErrRegister, command, err, trimmed)
		}
	}
	return nil
}
