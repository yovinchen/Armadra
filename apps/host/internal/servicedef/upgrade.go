package servicedef

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// probeTimeout bounds the candidate's own identity report. The candidate is an
// unverified executable at that point, so it runs with no arguments beyond
// `version`, no stdin, and a deadline.
const probeTimeout = 10 * time.Second

// maxProbeOutput caps what the candidate may print. A binary that floods stdout
// is rejected rather than buffered.
const maxProbeOutput = 64 << 10

// ErrUpgradeRefused marks every refusal that leaves the installed binary
// untouched.
var ErrUpgradeRefused = errors.New("upgrade refused")

// Version is what a Host binary reports about itself. It carries no build
// secret and no credential: only what an upgrade has to compare.
type Version struct {
	Component     string `json:"component"`
	ProtocolMajor uint32 `json:"protocolMajor"`
	ProtocolMinor uint32 `json:"protocolMinor"`
}

// VerifyCandidate checks the file itself, before anything is executed: an
// absolute path, a real regular file (never a symlink, whose target could be
// swapped between the check and the copy), an executable bit on Unix, an owner
// that is this user or the superuser, and no group/other write bit that would
// let another account change it after the check.
func VerifyCandidate(path string) (os.FileInfo, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("%w: --binary must be an absolute path", ErrUpgradeRefused)
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%w: candidate is a symbolic link", ErrUpgradeRefused)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: candidate is not a regular file", ErrUpgradeRefused)
	}
	if info.Size() == 0 {
		return nil, fmt.Errorf("%w: candidate is empty", ErrUpgradeRefused)
	}
	if runtime.GOOS != "windows" {
		if info.Mode().Perm()&0o111 == 0 {
			return nil, fmt.Errorf("%w: candidate is not executable", ErrUpgradeRefused)
		}
		if info.Mode().Perm()&0o022 != 0 {
			return nil, fmt.Errorf("%w: candidate is writable by other accounts", ErrUpgradeRefused)
		}
		if err := verifyOwner(info); err != nil {
			return nil, err
		}
	}
	return info, nil
}

// Probe runs the candidate's own `version` report in a bounded subprocess and
// parses it. This executes the candidate — which is why VerifyCandidate runs
// first — but with no Host data directory, no network argument and a deadline.
func Probe(parent context.Context, path string) (Version, error) {
	var version Version
	ctx, cancel := context.WithTimeout(parent, probeTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, path, "version", "--output", "json")
	command.Stdin = nil
	command.Env = probeEnvironment()
	var out, errorOut bytes.Buffer
	command.Stdout = &limitedWriter{writer: &out, remaining: maxProbeOutput}
	command.Stderr = &limitedWriter{writer: &errorOut, remaining: maxProbeOutput}
	if err := command.Run(); err != nil {
		return version, fmt.Errorf("%w: candidate did not report its version: %w", ErrUpgradeRefused, err)
	}
	if err := json.Unmarshal(bytes.TrimSpace(out.Bytes()), &version); err != nil {
		return version, fmt.Errorf("%w: candidate version report is not the expected document", ErrUpgradeRefused)
	}
	if version.Component != ComponentName {
		return version, fmt.Errorf("%w: candidate identifies itself as %q", ErrUpgradeRefused, version.Component)
	}
	return version, nil
}

// ComponentName is the identity a Host binary reports.
const ComponentName = "armadra-host"

// CheckCompatible refuses a candidate whose protocol major differs from this
// binary's. A different major is a different wire contract: replacing the
// binary would break every paired client without warning.
func CheckCompatible(candidate Version, major uint32) error {
	if candidate.ProtocolMajor != major {
		return fmt.Errorf("%w: candidate speaks protocol major %d, this Host speaks %d", ErrUpgradeRefused, candidate.ProtocolMajor, major)
	}
	return nil
}

// Replace installs candidate at target atomically and leaves target untouched
// on any failure. The current binary is moved aside first so the running
// process keeps its own image open — Windows refuses to overwrite a file that
// is being executed, but allows renaming it — and the copy is only promoted
// once it is fully written and closed.
func Replace(candidate, target string) (err error) {
	source, err := os.Open(candidate)
	if err != nil {
		return err
	}
	defer source.Close()
	info, err := os.Lstat(target)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%w: installed binary is not a regular file", ErrUpgradeRefused)
	}
	directory := filepath.Dir(target)
	staged, err := os.CreateTemp(directory, filepath.Base(target)+".next-*")
	if err != nil {
		return err
	}
	stagedName := staged.Name()
	defer func() {
		if err != nil {
			os.Remove(stagedName)
		}
	}()
	if _, err = io.Copy(staged, source); err != nil {
		staged.Close()
		return err
	}
	if err = staged.Sync(); err != nil {
		staged.Close()
		return err
	}
	if err = staged.Close(); err != nil {
		return err
	}
	mode := info.Mode().Perm()
	if runtime.GOOS != "windows" {
		mode |= 0o100
	}
	if err = os.Chmod(stagedName, mode); err != nil {
		return err
	}
	previous := target + ".previous"
	_ = os.Remove(previous)
	if err = os.Rename(target, previous); err != nil {
		return err
	}
	if err = os.Rename(stagedName, target); err != nil {
		// Put the working binary back before reporting the failure.
		if restore := os.Rename(previous, target); restore != nil {
			return errors.Join(err, fmt.Errorf("previous binary is at %s", previous))
		}
		return err
	}
	// Removing the old image can fail on Windows while it is still mapped.
	// The replacement already succeeded, so that is reported, not fatal.
	_ = os.Remove(previous)
	return nil
}

// limitedWriter stops a probed candidate from filling memory with output.
type limitedWriter struct {
	writer    io.Writer
	remaining int
}

func (w *limitedWriter) Write(data []byte) (int, error) {
	if w.remaining <= 0 {
		return len(data), nil
	}
	if len(data) > w.remaining {
		data = data[:w.remaining]
	}
	written, err := w.writer.Write(data)
	w.remaining -= written
	return len(data), err
}
