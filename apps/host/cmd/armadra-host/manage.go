package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/daemon"
	"armadra.local/host/internal/hoststate"
)

// CLI output is for people/scripts; the local control wire remains Protobuf.
func printStatus(status *pb.HostStatus) error {
	result := struct {
		State      string `json:"state"`
		HostID     string `json:"hostId,omitempty"`
		InstanceID string `json:"hostInstanceId,omitempty"`
		Endpoint   string `json:"httpEndpoint,omitempty"`
		ProcessID  uint32 `json:"processId,omitempty"`
	}{State: "stopped"}
	if status != nil {
		result.State = "running"
		result.HostID = status.HostId
		result.InstanceID = status.HostInstanceId
		result.Endpoint = status.HttpEndpoint
		result.ProcessID = status.ProcessId
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

func showStatus(parent context.Context, dir string) error {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	status, err := daemon.Status(ctx, dir)
	if errors.Is(err, daemon.ErrNotRunning) {
		if locked, err := hoststate.IsLocked(dir); err != nil {
			return err
		} else if locked {
			return fmt.Errorf("Host owns the data directory but its control endpoint is unavailable")
		}
		return printStatus(nil)
	}
	if err != nil {
		return err
	}
	return printStatus(status)
}

func startBackground(parent context.Context, c config) error {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	// Parent opens only a new diagnostic file, never a shared log or PID file.
	if err := os.MkdirAll(c.dataDir, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(c.dataDir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("Host data directory must be a real directory")
	}
	if err := os.Chmod(c.dataDir, 0700); err != nil {
		return err
	}
	status, err := daemon.Status(ctx, c.dataDir)
	if err == nil {
		return printStatus(status)
	}
	if !errors.Is(err, daemon.ErrNotRunning) {
		return err
	}
	if locked, err := hoststate.IsLocked(c.dataDir); err != nil {
		return err
	} else if locked {
		status, err := awaitReady(ctx, c.dataDir, nil)
		if err == nil {
			return printStatus(status)
		}
		if !errors.Is(err, errNoOwner) {
			return err
		}
	}
	logFile, err := os.CreateTemp(c.dataDir, "startup-*.log")
	if err != nil {
		return err
	}
	defer logFile.Close()
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	args := []string{"serve", "--data-dir", c.dataDir, "--listen", c.address}
	for _, origin := range c.origins {
		args = append(args, "--allow-origin", origin)
	}
	child := exec.Command(executable, args...)
	child.Stdout = logFile
	child.Stderr = logFile
	setDetached(child)
	if err := child.Start(); err != nil {
		return err
	}
	exited := make(chan error, 1)
	go func() { exited <- child.Wait(); close(exited) }()
	ready := false
	var cleanupOnce sync.Once
	var cleanupErr error
	cleanupChild := func() error {
		cleanupOnce.Do(func() {
			if err := child.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				cleanupErr = err
			}
			select {
			case <-exited:
			case <-time.After(2 * time.Second):
				cleanupErr = fmt.Errorf("Host startup child did not exit")
			}
		})
		return cleanupErr
	}
	defer func() {
		if !ready {
			// Kill only the process this invocation created, never a PID from disk.
			_ = cleanupChild()
		}
	}()
	status, err = awaitReady(ctx, c.dataDir, exited)
	if err != nil {
		return fmt.Errorf("%w; inspect %s", err, filepath.Base(logFile.Name()))
	}
	// When a concurrent launcher won, our child may still be retrying a brief
	// lock conflict. Reap that contender before this start command returns, or
	// it could acquire the directory after the winner is stopped and restart it.
	ready = status.ProcessId == uint32(child.Process.Pid)
	if !ready {
		if err := cleanupChild(); err != nil {
			return err
		}
	}
	return printStatus(status)
}

func transientRead(err error) bool {
	var control *daemon.Error
	return errors.As(err, &control) && (control.Code == daemon.CodeTransport || control.Code == daemon.CodeTimeout)
}

var errNoOwner = errors.New("Host ownership was transient; no running owner remains")

func awaitReady(ctx context.Context, dir string, exited <-chan error) (*pb.HostStatus, error) {
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	hasChild := exited != nil
	childDone := false
	var unownedSince time.Time
	for {
		status, err := daemon.Status(ctx, dir)
		if err == nil {
			return status, nil
		}
		if !errors.Is(err, daemon.ErrNotRunning) && !transientRead(err) {
			return nil, err
		}
		locked, lockErr := hoststate.IsLocked(dir)
		if lockErr != nil {
			return nil, lockErr
		}
		if childDone && !locked {
			return nil, fmt.Errorf("Host exited before its control endpoint became ready")
		}
		if !hasChild && !locked {
			if unownedSince.IsZero() {
				unownedSince = time.Now()
			}
			if time.Since(unownedSince) >= 150*time.Millisecond {
				return nil, errNoOwner
			}
		} else {
			unownedSince = time.Time{}
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("Host startup timed out or was cancelled")
		case <-exited:
			childDone = true
			exited = nil
		case <-tick.C:
		}
	}
}

func stopBackground(parent context.Context, dir string) error {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	status, err := daemon.Status(ctx, dir)
	if errors.Is(err, daemon.ErrNotRunning) {
		if locked, err := hoststate.IsLocked(dir); err != nil {
			return err
		} else if locked {
			return fmt.Errorf("Host control endpoint is unavailable; no stop was sent")
		}
		return printStatus(nil)
	}
	if err != nil {
		return err
	}
	if err := daemon.Stop(ctx, dir, status.HostInstanceId); err != nil {
		return err
	}
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		current, err := daemon.Status(ctx, dir)
		if errors.Is(err, daemon.ErrNotRunning) {
			locked, lockErr := hoststate.IsLocked(dir)
			if lockErr != nil {
				return lockErr
			}
			if !locked {
				return printStatus(nil)
			}
		}
		if err != nil && !errors.Is(err, daemon.ErrNotRunning) && !transientRead(err) {
			return err
		}
		if err == nil && current.HostInstanceId != status.HostInstanceId {
			return fmt.Errorf("Host instance changed while stopping; inspect status")
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("Host did not stop before the deadline")
		case <-tick.C:
		}
	}
}
