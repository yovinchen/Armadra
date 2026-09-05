package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/daemon"
	"armadra.local/host/internal/hoststate"
	"armadra.local/host/internal/server"
	"armadra.local/host/internal/servicedef"
)

// upgrade.
//
// Three modes: a local candidate the operator points at, a release fetched
// from the configured source, and a rollback to whatever the last successful
// upgrade displaced. All of them share one rule — every check runs before
// anything on disk changes, and without --confirm nothing changes at all.

type upgradeResult struct {
	Command   string        `json:"command"`
	Mode      string        `json:"mode"`
	Candidate string        `json:"candidate"`
	Target    string        `json:"target"`
	Protocol  versionReport `json:"candidateVersion"`
	// Components lists every binary a release upgrade replaced. A local
	// candidate replaces only the Host, so it stays empty there.
	Components []string       `json:"components,omitempty"`
	WasRunning bool           `json:"hostWasRunning"`
	Managed    bool           `json:"serviceManaged"`
	Applied    bool           `json:"applied"`
	Restarted  bool           `json:"restarted"`
	RolledBack bool           `json:"rolledBack"`
	Status     *statusSummary `json:"status,omitempty"`
	Note       string         `json:"note"`
}

// upgradeHost dispatches to the mode the operator chose. normalizeUpgrade has
// already refused every combination but one, so exactly one of these runs.
func upgradeHost(parent context.Context, c config) error {
	if err := refuseForeignHost(c.dataDir); err != nil {
		return err
	}
	switch {
	case c.service.rollback:
		return rollbackHost(parent, c)
	case c.service.fromRelease:
		return upgradeFromRelease(parent, c)
	default:
		return upgradeFromBinary(parent, c)
	}
}

// refuseForeignHost stops an upgrade from touching a Host this command does not
// own. The desktop app ships its own Host inside its bundle and replaces it
// when the app updates; replacing that binary here would leave the app running
// a Host it did not install, and the next app update would silently undo it.
//
// The check reads what the running Host recorded about itself rather than
// guessing from paths alone, and then also refuses a binary that lives inside a
// desktop installation — because a Host that is not running has recorded
// nothing, and an application bundle is still not ours to edit.
func refuseForeignHost(dataDir string) error {
	if record, err := hoststate.ReadLauncher(dataDir); err == nil && record.Launcher == hoststate.LauncherDesktop {
		return fmt.Errorf("refusing to upgrade a Host owned by the desktop app; update the app instead")
	}
	executable, err := hostExecutable()
	if err != nil {
		return err
	}
	if insideDesktopInstall(executable) {
		return fmt.Errorf("refusing to upgrade a Host owned by the desktop app; update the app instead (%s is inside an application bundle)", executable)
	}
	return nil
}

// insideDesktopInstall reports whether a path sits inside an installed desktop
// application. The shapes are the ones each platform's installer produces.
func insideDesktopInstall(executable string) bool {
	normalized := filepath.ToSlash(executable)
	for _, marker := range []string{".app/Contents/MacOS/", ".app/Contents/Resources/", "/Applications/"} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

// upgradeFromBinary replaces this binary with a verified local candidate. Every
// check runs before anything on disk changes, and without --confirm the command
// only reports what it would do. A running Host is stopped through the control
// protocol first — never by signalling a PID from disk — because the file being
// replaced is the image it is executing.
func upgradeFromBinary(parent context.Context, c config) error {
	target, err := hostExecutable()
	if err != nil {
		return err
	}
	candidate := filepath.Clean(c.service.binary)
	if candidate == target {
		return fmt.Errorf("candidate and installed binary are the same file")
	}
	if _, err := servicedef.VerifyCandidate(candidate); err != nil {
		return err
	}
	version, err := servicedef.Probe(parent, candidate)
	if err != nil {
		return err
	}
	if err := servicedef.CheckCompatible(version, server.ProtocolMajor); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	running, err := runningStatus(ctx, c.dataDir)
	if err != nil {
		return err
	}
	marker, markerErr := servicedef.ReadMarker(c.dataDir)
	if running != nil && markerErr != nil {
		// Restarting means choosing the listener, origins and Worker paths the
		// Host had. Guessing them would silently change the service's exposure,
		// so an unrecorded configuration is a refusal, not a default.
		return fmt.Errorf("Host is running and no service definition records its configuration; run `armadra-host stop` first, then upgrade")
	}
	result := upgradeResult{
		Command: "upgrade", Mode: "binary", Candidate: candidate, Target: target,
		Protocol:   versionReport{Component: version.Component, Version: version.Version, Channel: version.Channel, ProtocolMajor: version.ProtocolMajor, ProtocolMinor: version.ProtocolMinor},
		WasRunning: running != nil,
	}
	if !c.service.confirm {
		result.Note = "no change was made; re-run with --confirm to replace the binary"
		if c.output == "json" {
			return writeJSON(result)
		}
		fmt.Printf("Would replace %s with %s (protocol %d.%d)\n", target, candidate, version.ProtocolMajor, version.ProtocolMinor)
		if running != nil {
			fmt.Println("The running Host would be stopped and started again from the recorded service definition.")
		}
		fmt.Println("Nothing changed. Re-run with --confirm to apply.")
		return nil
	}
	if running != nil {
		if err := stopForUpgrade(ctx, c.dataDir, running.HostInstanceId); err != nil {
			return err
		}
	}
	if _, err := servicedef.ReplaceAll([]servicedef.Replacement{{Component: "host", Candidate: candidate, Target: target}}); err != nil {
		return err
	}
	result.Applied = true
	result.Note = "binary replaced"
	if running != nil {
		status, restarted, err := restartAfterUpgrade(ctx, c.dataDir, target, marker.Spec)
		if err != nil {
			return err
		}
		result.Restarted = restarted
		result.Status = summarize(status)
		if !restarted {
			result.Note = "binary replaced; the Host was restarted by its service manager"
		}
	}
	if c.output == "json" {
		return writeJSON(result)
	}
	fmt.Printf("Replaced %s with %s\n", target, candidate)
	if result.Status != nil {
		fmt.Printf("Host %s (instance %s, pid %d)\n", result.Status.State, result.Status.InstanceID, result.Status.ProcessID)
	}
	return nil
}

// runningStatus reports the Host that currently owns the data directory, or nil
// when none does. A locked directory whose control endpoint is unreachable is
// an error: an upgrade must never assume a Host it cannot talk to is absent.
func runningStatus(ctx context.Context, dir string) (*pb.HostStatus, error) {
	status, err := daemon.Status(ctx, dir)
	if err == nil {
		return status, nil
	}
	if !errors.Is(err, daemon.ErrNotRunning) {
		return nil, err
	}
	locked, lockErr := hoststate.IsLocked(dir)
	if lockErr != nil {
		return nil, lockErr
	}
	if locked {
		return nil, fmt.Errorf("Host owns the data directory but its control endpoint is unavailable")
	}
	return nil, nil
}

// stopForUpgrade stops the observed instance through the control protocol and
// waits for the directory lock to be released. It never kills a PID.
func stopForUpgrade(ctx context.Context, dir, instance string) error {
	if err := daemon.Stop(ctx, dir, instance); err != nil {
		return err
	}
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		_, err := daemon.Status(ctx, dir)
		if errors.Is(err, daemon.ErrNotRunning) {
			locked, lockErr := hoststate.IsLocked(dir)
			if lockErr != nil {
				return lockErr
			}
			if !locked {
				return nil
			}
		} else if err != nil && !transientRead(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("Host did not stop before the deadline; the binary was not replaced")
		case <-tick.C:
		}
	}
}

// restartAfterUpgrade starts the replaced binary with exactly the arguments the
// recorded definition uses. A service manager with KeepAlive may have restarted
// the Host already; that owner is reported instead of racing a second one.
func restartAfterUpgrade(ctx context.Context, dir, executable string, spec servicedef.Spec) (*pb.HostStatus, bool, error) {
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for {
		if status, err := daemon.Status(ctx, dir); err == nil {
			return status, false, nil
		} else if !errors.Is(err, daemon.ErrNotRunning) && !transientRead(err) {
			return nil, false, err
		}
		select {
		case <-ctx.Done():
			return nil, false, ctx.Err()
		case <-deadline.C:
			status, err := startReplacedHost(ctx, dir, executable, spec)
			return status, true, err
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func startReplacedHost(ctx context.Context, dir, executable string, spec servicedef.Spec) (*pb.HostStatus, error) {
	logFile, err := os.CreateTemp(dir, "startup-*.log")
	if err != nil {
		return nil, err
	}
	defer logFile.Close()
	child := exec.Command(executable, spec.Arguments()...)
	child.Stdout = logFile
	child.Stderr = logFile
	setDetached(child)
	if err := child.Start(); err != nil {
		return nil, err
	}
	exited := make(chan error, 1)
	go func() { exited <- child.Wait(); close(exited) }()
	status, err := awaitReady(ctx, dir, exited)
	if err != nil {
		if killErr := child.Process.Kill(); killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
			err = errors.Join(err, killErr)
		}
		return nil, fmt.Errorf("%w; the new binary is installed, inspect %s", err, filepath.Base(logFile.Name()))
	}
	return status, nil
}
