package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"armadra.local/host/internal/daemon"
	"armadra.local/host/internal/hoststate"
	"armadra.local/host/internal/servicedef"
)

// install and uninstall.
//
// Without --register these commands only write and delete a file, which is
// what they have always done: the operator reviews the definition and hands it
// to the service manager themselves. With --register they also talk to
// launchd, systemd or the Windows service manager, and every precondition for
// that lives in servicedef.PreflightRegister, so the decision can be tested
// without one.
//
// --register alone changes nothing either. It prints the exact command lines it
// would run and exits successfully, because "show me what you would do" is the
// only way an operator can review a machine-wide change before it happens.

// registrar is what actually runs a service manager. It is a variable so a
// test can record the commands instead of registering a service on the machine
// running the tests.
var registrar servicedef.Registrar = servicedef.SystemRegistrar{}

// elevated reports whether this process may make a machine-wide change. Also a
// variable, for the same reason.
var elevated = servicedef.Elevated

type installResult struct {
	Command    string   `json:"command"`
	Platform   string   `json:"platform"`
	Path       string   `json:"path"`
	Identifier string   `json:"identifier"`
	RunAs      string   `json:"runAs"`
	LogPath    string   `json:"logPath"`
	Scope      string   `json:"scope,omitempty"`
	Registered bool     `json:"registered"`
	Planned    []string `json:"plannedCommands,omitempty"`
	Note       string   `json:"note"`
}

// installService writes the definition and records it beside the Host's own
// state, then registers it only if asked to. Without --register the note says
// nothing was registered, in both formats: an operator who believes a service
// is running when it is not would discover it at the worst moment.
func installService(ctx context.Context, c config) error {
	// A release source may carry a credential in its URL, and the definition is
	// a file the service manager and every operator can read. Refuse to copy it
	// there rather than writing a secret into a world-readable unit.
	if c.updatesSource != "" {
		return fmt.Errorf("--updates-source is not written into a service definition: a release source can carry a credential; add it to the installed unit yourself")
	}
	executable, err := hostExecutable()
	if err != nil {
		return err
	}
	spec := specFromConfig(c, executable)
	if err := spec.Normalize(); err != nil {
		return err
	}
	if err := os.MkdirAll(c.dataDir, 0o700); err != nil {
		return err
	}
	path, _, err := servicedef.Generate(spec, c.service.dir)
	if err != nil {
		return err
	}
	if err := servicedef.WriteMarker(c.dataDir, servicedef.Marker{Spec: spec, Path: path}); err != nil {
		return err
	}
	result := installResult{
		Command: "install", Platform: spec.Platform, Path: path, Identifier: spec.Identifier,
		RunAs: spec.RunAs, LogPath: spec.LogPath, Registered: false,
		Note: "definition written only; nothing was registered, enabled or started",
	}
	if c.service.registerService {
		result.Scope = c.service.scope
		if err := applyRegistration(ctx, c, spec, path, &result); err != nil {
			return err
		}
	}
	if c.output == "json" {
		return writeJSON(result)
	}
	fmt.Printf("Wrote %s service definition: %s\n", result.Platform, result.Path)
	fmt.Printf("Runs %s as %s, logging to %s\n", executable, result.RunAs, result.LogPath)
	for _, command := range result.Planned {
		fmt.Printf("  %s\n", command)
	}
	fmt.Println(result.Note)
	return nil
}

// applyRegistration runs, or merely reports, the registration plan.
func applyRegistration(ctx context.Context, c config, spec servicedef.Spec, path string, result *installResult) error {
	home, _ := os.UserHomeDir()
	if err := servicedef.PreflightRegister(spec, path, c.service.scope, elevated(), home); err != nil {
		return err
	}
	plan, err := servicedef.RegisterPlan(spec, path, c.service.scope)
	if err != nil {
		return err
	}
	for _, command := range plan.Commands {
		result.Planned = append(result.Planned, command.String())
	}
	if !c.service.confirm {
		result.Note = "nothing was registered; re-run with --confirm to run the commands above"
		if plan.Note != "" {
			result.Note += ". " + plan.Note
		}
		return nil
	}
	if err := servicedef.Execute(ctx, registrar, plan); err != nil {
		return err
	}
	// A registration nobody checked is a service an operator believes is
	// running. Ask the Host itself, and only report registered when the answer
	// came from a Host that says a service manager started it.
	launcher, err := awaitRegistered(ctx, c.dataDir)
	if err != nil {
		result.Note = fmt.Sprintf("the service manager accepted the definition, but the Host did not report itself as started by a service within %s: %v", registrationDeadline, err)
		return nil
	}
	result.Registered = true
	result.Note = fmt.Sprintf("registered and running; the Host reports launcher=%s", launcher)
	return nil
}

// registrationDeadline bounds the self-check after registering. `systemctl
// enable --now` returns once the unit is active, but launchd and sc.exe return
// as soon as they have accepted the job.
const registrationDeadline = 30 * time.Second

// awaitRegistered polls until the Host that owns the data directory answers and
// says a service manager launched it. Anything else — nothing running, or a
// Host somebody started at a shell — is not a registered service.
func awaitRegistered(parent context.Context, dataDir string) (string, error) {
	ctx, cancel := context.WithTimeout(parent, registrationDeadline)
	defer cancel()
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	var last error
	for {
		status, err := daemon.Status(ctx, dataDir)
		switch {
		case err == nil:
			record, readErr := hoststate.ReadLauncher(dataDir)
			if readErr == nil && record.InstanceID == status.GetHostInstanceId() {
				if record.Launcher != hoststate.LauncherService {
					return "", fmt.Errorf("the running Host reports launcher=%s, so it was not started by the service manager", record.Launcher)
				}
				return record.Launcher, nil
			}
			last = fmt.Errorf("the running Host has not recorded which launcher started it")
		case errors.Is(err, daemon.ErrNotRunning):
			last = errors.New("no Host is running")
		default:
			last = err
		}
		select {
		case <-ctx.Done():
			return "", last
		case <-tick.C:
		}
	}
}

type uninstallResult struct {
	Command      string   `json:"command"`
	Path         string   `json:"path"`
	Identifier   string   `json:"identifier"`
	Scope        string   `json:"scope,omitempty"`
	Unregistered bool     `json:"unregistered"`
	Removed      bool     `json:"removed"`
	Planned      []string `json:"plannedCommands,omitempty"`
	Note         string   `json:"note"`
}

// uninstallService deletes only the file this command generated. It reads the
// file first and refuses anything that does not carry our generation marker,
// our identifier and our program path, so an operator's own unit that happens
// to share a name is never removed.
//
// With --unregister it stops and unregisters first, because a manager asked to
// delete a running service leaves it running, and removing the definition of a
// registered service leaves the manager pointing at a file that is gone. The
// data directory, its credentials and its sessions are never touched: they are
// separate from the deployment on purpose.
func uninstallService(ctx context.Context, c config) error {
	executable, err := hostExecutable()
	if err != nil {
		return err
	}
	spec := servicedef.Spec{Identifier: c.service.identifier, Platform: c.service.platform, Executable: executable}
	path := ""
	marker, markerErr := servicedef.ReadMarker(c.dataDir)
	switch {
	case c.service.dir != "":
		path = filepath.Join(c.service.dir, spec.FileName())
	case markerErr == nil:
		path, spec = marker.Path, marker.Spec
	case errors.Is(markerErr, os.ErrNotExist):
		return fmt.Errorf("no service definition was generated for %s; pass --service-dir to point at one", c.dataDir)
	default:
		return markerErr
	}
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("no service definition at %s", path)
	}
	if err != nil {
		return err
	}
	if !servicedef.Owns(content, spec) {
		return fmt.Errorf("refusing to remove %s: it was not generated by this command for %s", path, spec.Identifier)
	}
	result := uninstallResult{
		Command: "uninstall", Path: path, Identifier: spec.Identifier,
		Note: "definition file removed; no service was stopped or unregistered",
	}
	if c.service.registerService {
		result.Scope = c.service.scope
		plan, err := servicedef.UnregisterPlan(spec, path, c.service.scope)
		if err != nil {
			return err
		}
		for _, command := range plan.Commands {
			result.Planned = append(result.Planned, command.String())
		}
		if !c.service.confirm {
			result.Note = "nothing was unregistered or removed; re-run with --confirm to run the commands above and delete the definition"
			if c.output == "json" {
				return writeJSON(result)
			}
			for _, command := range result.Planned {
				fmt.Printf("  %s\n", command)
			}
			fmt.Println(result.Note)
			return nil
		}
		if !elevated() && c.service.scope == servicedef.ScopeSystem {
			return fmt.Errorf("%w: unregistering a system service needs elevation", servicedef.ErrRegister)
		}
		if err := servicedef.Execute(ctx, registrar, plan); err != nil {
			return err
		}
		result.Unregistered = true
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	result.Removed = true
	if markerErr == nil && marker.Path == path {
		if err := servicedef.RemoveMarker(c.dataDir); err != nil {
			return err
		}
	}
	if result.Unregistered {
		result.Note = "service stopped and unregistered, definition removed; the data directory, its credentials and its sessions are untouched"
	}
	if c.output == "json" {
		return writeJSON(result)
	}
	fmt.Printf("Removed %s\n", path)
	fmt.Println(result.Note)
	return nil
}
