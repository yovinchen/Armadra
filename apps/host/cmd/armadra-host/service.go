package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/daemon"
	"armadra.local/host/internal/hoststate"
	"armadra.local/host/internal/server"
	"armadra.local/host/internal/servicedef"
	"google.golang.org/protobuf/proto"
)

// Server mode: the Host runs under a fixed system account. These commands
// generate a service definition, report it beside the ordinary status, tail the
// diagnostics and replace the binary in place. None of them talks to a service
// manager: install writes a file and uninstall deletes that same file, so the
// operator stays the only one who registers, enables, starts or stops anything.

// serviceFlags holds the flags the server-mode commands add. They are kept in
// one struct so main.go's parser only has to register and normalize them.
type serviceFlags struct {
	dir         string
	runAs       string
	identifier  string
	platform    string
	logFile     string
	workingDir  string
	environment repeatedFlag
	lines       int
	binary      string
	confirm     bool
}

type repeatedFlag []string

func (values *repeatedFlag) String() string { return strings.Join(*values, ", ") }
func (values *repeatedFlag) Set(value string) error {
	*values = append(*values, value)
	return nil
}

// register adds only the flags the given command actually accepts, so an
// unrelated flag is a parse error rather than a silently ignored option.
func (s *serviceFlags) register(flags *flag.FlagSet, command string) {
	switch command {
	case "install":
		flags.StringVar(&s.dir, "service-dir", "", "Absolute directory the service definition is written into (required)")
		flags.StringVar(&s.runAs, "run-as", "", "Existing system account the service runs as (required; never defaulted)")
		flags.StringVar(&s.identifier, "identifier", servicedef.DefaultIdentifier, "Reverse-DNS service identifier")
		flags.StringVar(&s.platform, "target-platform", runtime.GOOS, "Definition format: darwin, linux or windows")
		flags.StringVar(&s.logFile, "log-file", "", "Absolute diagnostics log path (default: <data-dir>/host.log)")
		flags.StringVar(&s.workingDir, "working-dir", "", "Absolute working directory (default: the data directory)")
		flags.Var(&s.environment, "env", "NAME=VALUE exported by the service; credential-looking names are refused (repeatable)")
	case "uninstall":
		flags.StringVar(&s.dir, "service-dir", "", "Directory holding the generated definition (default: the one recorded at install)")
		flags.StringVar(&s.identifier, "identifier", servicedef.DefaultIdentifier, "Identifier of the definition to remove")
		flags.StringVar(&s.platform, "target-platform", runtime.GOOS, "Definition format that was generated")
	case "logs":
		flags.IntVar(&s.lines, "lines", servicedef.DefaultLogLines, "Number of trailing lines to read")
		flags.StringVar(&s.logFile, "log-file", "", "Absolute log file to read (default: the service log, else the newest startup log)")
	case "upgrade":
		flags.StringVar(&s.binary, "binary", "", "Absolute path to the candidate Host executable (required)")
		flags.BoolVar(&s.confirm, "confirm", false, "Actually replace the installed binary; without it nothing changes")
	}
}

func (s *serviceFlags) normalize(command string) error {
	switch command {
	case "install":
		if s.dir == "" || !filepath.IsAbs(s.dir) {
			return fmt.Errorf("install requires --service-dir ABSOLUTE_DIRECTORY")
		}
		if strings.TrimSpace(s.runAs) == "" {
			return fmt.Errorf("install requires --run-as ACCOUNT; the service account is never taken from the current user")
		}
		switch s.platform {
		case servicedef.PlatformDarwin, servicedef.PlatformLinux, servicedef.PlatformWindows:
		default:
			return fmt.Errorf("--target-platform accepts darwin, linux or windows")
		}
		for name, value := range map[string]string{"--log-file": s.logFile, "--working-dir": s.workingDir} {
			if value != "" && !filepath.IsAbs(value) {
				return fmt.Errorf("%s must be an absolute path", name)
			}
		}
		s.dir = filepath.Clean(s.dir)
	case "uninstall":
		if s.dir != "" && !filepath.IsAbs(s.dir) {
			return fmt.Errorf("--service-dir must be an absolute directory")
		}
	case "logs":
		if s.lines < 0 {
			return fmt.Errorf("--lines must not be negative")
		}
		if s.logFile != "" && !filepath.IsAbs(s.logFile) {
			return fmt.Errorf("--log-file must be an absolute path")
		}
	case "upgrade":
		if s.binary == "" || !filepath.IsAbs(s.binary) {
			return fmt.Errorf("upgrade requires --binary ABSOLUTE_PATH")
		}
	}
	return nil
}

// supportedOutput keeps the existing management commands on their json /
// protobuf contract and gives the new ones json / text. Nothing here widens
// what serve, start, status, stop, import or pair accept.
func supportedOutput(command, format string) bool {
	switch command {
	case "install", "uninstall", "logs", "upgrade":
		return format == "json" || format == "text"
	default:
		return format == "json" || format == "protobuf"
	}
}

// hostExecutable resolves this binary's own absolute path with links followed,
// so a generated definition names a real program and an upgrade replaces the
// file rather than a symlink pointing at it. It is a variable so tests can
// point the destructive upgrade path at a copy instead of the test binary.
var hostExecutable = func() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	return filepath.Abs(executable)
}

// specFromConfig turns the parsed flags into the definition inputs. Only
// operational configuration reaches it: no ticket, session or pairing material
// exists at this point in the process, and the environment allowlist refuses
// credential-looking names inside servicedef.
func specFromConfig(c config, executable string) servicedef.Spec {
	return servicedef.Spec{
		Identifier:     c.service.identifier,
		Platform:       c.service.platform,
		Executable:     executable,
		RunAs:          c.service.runAs,
		DataDir:        c.dataDir,
		WorkingDir:     c.service.workingDir,
		LogPath:        c.service.logFile,
		Listen:         c.address,
		EndpointsDir:   c.endpointsDir,
		PublicOrigin:   c.publicOrigin,
		CertFile:       c.certFile,
		KeyFile:        c.keyFile,
		AllowedOrigins: c.origins,
		WorkerBinary:   c.workerBinary,
		WorkerStateDir: c.workerStateDir,
		Environment:    c.service.environment,
	}
}

type installResult struct {
	Command    string `json:"command"`
	Platform   string `json:"platform"`
	Path       string `json:"path"`
	Identifier string `json:"identifier"`
	RunAs      string `json:"runAs"`
	LogPath    string `json:"logPath"`
	Registered bool   `json:"registered"`
	Note       string `json:"note"`
}

// installService writes the definition and records it beside the Host's own
// state. It registers nothing: the returned note says so in both formats,
// because an operator who believes a service is running when it is not would
// discover it at the worst moment.
func installService(_ context.Context, c config) error {
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
	if c.output == "json" {
		return writeJSON(result)
	}
	fmt.Printf("Wrote %s service definition: %s\n", result.Platform, result.Path)
	fmt.Printf("Runs %s as %s, logging to %s\n", executable, result.RunAs, result.LogPath)
	fmt.Println("Nothing was registered, enabled or started. Review the file and install it yourself.")
	return nil
}

type uninstallResult struct {
	Command    string `json:"command"`
	Path       string `json:"path"`
	Identifier string `json:"identifier"`
	Removed    bool   `json:"removed"`
	Note       string `json:"note"`
}

// uninstallService deletes only the file this command generated. It reads the
// file first and refuses anything that does not carry our generation marker,
// our identifier and our program path, so an operator's own unit that happens
// to share a name is never removed. It stops nothing.
func uninstallService(_ context.Context, c config) error {
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
	if err := os.Remove(path); err != nil {
		return err
	}
	if markerErr == nil && marker.Path == path {
		if err := servicedef.RemoveMarker(c.dataDir); err != nil {
			return err
		}
	}
	result := uninstallResult{
		Command: "uninstall", Path: path, Identifier: spec.Identifier, Removed: true,
		Note: "definition file removed; no service was stopped or unregistered",
	}
	if c.output == "json" {
		return writeJSON(result)
	}
	fmt.Printf("Removed %s\n", path)
	fmt.Println("No service was stopped or unregistered; the running Host, if any, is untouched.")
	return nil
}

type logsResult struct {
	Command string   `json:"command"`
	Path    string   `json:"path"`
	Lines   []string `json:"lines"`
}

// showLogs prints the tail of the Host's diagnostics. The bytes are printed as
// they were written: no heuristic redaction runs over them, because a filter
// that misses one shape is worse than a documented guarantee. The Host writes
// no credential into these files — pairing material is only ever returned by
// the pair command's own stdout — and a log path the operator points elsewhere
// is their own to vet.
func showLogs(_ context.Context, c config) error {
	path := c.service.logFile
	if path == "" {
		if marker, err := servicedef.ReadMarker(c.dataDir); err == nil {
			if info, statErr := os.Lstat(marker.Spec.LogPath); statErr == nil && info.Mode().IsRegular() {
				path = marker.Spec.LogPath
			}
		}
	}
	if path == "" {
		startup, err := servicedef.LatestStartupLog(c.dataDir)
		if err != nil {
			return err
		}
		path = startup
	}
	lines, err := servicedef.Tail(path, c.service.lines)
	if err != nil {
		return err
	}
	if c.output == "json" {
		return writeJSON(logsResult{Command: "logs", Path: path, Lines: lines})
	}
	for _, line := range lines {
		fmt.Println(line)
	}
	return nil
}

type versionReport struct {
	Component     string `json:"component"`
	ProtocolMajor uint32 `json:"protocolMajor"`
	ProtocolMinor uint32 `json:"protocolMinor"`
}

// showVersion is the identity an upgrade checks before replacing anything. It
// opens no data directory, acquires no lock and reveals nothing about the
// machine: a candidate binary can be asked what it is without side effects.
func showVersion(c config) error {
	if c.output == "protobuf" {
		wire, err := proto.Marshal(&pb.ProtocolVersion{Major: server.ProtocolMajor, Minor: server.ProtocolMinor})
		if err != nil {
			return err
		}
		_, err = os.Stdout.Write(wire)
		return err
	}
	return writeJSON(versionReport{Component: servicedef.ComponentName, ProtocolMajor: server.ProtocolMajor, ProtocolMinor: server.ProtocolMinor})
}

type upgradeResult struct {
	Command    string         `json:"command"`
	Candidate  string         `json:"candidate"`
	Target     string         `json:"target"`
	Protocol   versionReport  `json:"candidateVersion"`
	WasRunning bool           `json:"hostWasRunning"`
	Applied    bool           `json:"applied"`
	Restarted  bool           `json:"restarted"`
	Status     *statusSummary `json:"status,omitempty"`
	Note       string         `json:"note"`
}

// upgradeHost replaces this binary with a verified candidate. Every check runs
// before anything on disk changes, and without --confirm the command only
// reports what it would do. A running Host is stopped through the control
// protocol first — never by signalling a PID from disk — because the file being
// replaced is the image it is executing.
func upgradeHost(parent context.Context, c config) error {
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
		Command: "upgrade", Candidate: candidate, Target: target,
		Protocol:   versionReport{Component: version.Component, ProtocolMajor: version.ProtocolMajor, ProtocolMinor: version.ProtocolMinor},
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
	if err := servicedef.Replace(candidate, target); err != nil {
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

// statusSummary repeats the JSON shape printStatus already produces, so status
// output stays identical when no service definition exists.
type statusSummary struct {
	State      string `json:"state"`
	HostID     string `json:"hostId,omitempty"`
	InstanceID string `json:"hostInstanceId,omitempty"`
	Endpoint   string `json:"httpEndpoint,omitempty"`
	ProcessID  uint32 `json:"processId,omitempty"`
}

type serviceSummary struct {
	Path       string `json:"path"`
	Identifier string `json:"identifier"`
	Platform   string `json:"platform"`
	RunAs      string `json:"runAs"`
	LogPath    string `json:"logPath"`
	Present    bool   `json:"present"`
	Matches    bool   `json:"matches"`
	Detail     string `json:"detail,omitempty"`
}

type statusWithService struct {
	statusSummary
	Service serviceSummary `json:"service"`
}

func summarize(status *pb.HostStatus) *statusSummary {
	summary := &statusSummary{State: "stopped"}
	if status != nil {
		summary.State = "running"
		summary.HostID = status.HostId
		summary.InstanceID = status.HostInstanceId
		summary.Endpoint = status.HttpEndpoint
		summary.ProcessID = status.ProcessId
	}
	return summary
}

// showServiceStatus is the status command. Without a generated definition, and
// for protobuf output, it defers to the existing implementation so the shape
// callers already parse is unchanged. With one, JSON gains a `service` object
// reporting where the definition is, which account it names and whether the
// file on disk still matches what this binary would generate.
func showServiceStatus(ctx context.Context, c config) error {
	marker, err := servicedef.ReadMarker(c.dataDir)
	if err != nil || c.output != "json" {
		return showStatus(ctx, c.dataDir, c.output)
	}
	timed, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	status, statusErr := daemon.Status(timed, c.dataDir)
	if errors.Is(statusErr, daemon.ErrNotRunning) {
		locked, lockErr := hoststate.IsLocked(c.dataDir)
		if lockErr != nil {
			return lockErr
		}
		if locked {
			return fmt.Errorf("Host owns the data directory but its control endpoint is unavailable")
		}
		status = nil
	} else if statusErr != nil {
		return statusErr
	}
	return writeJSON(statusWithService{statusSummary: *summarize(status), Service: describeService(marker)})
}

// describeService compares the file on disk with a fresh rendering of the
// recorded inputs. A mismatch is reported, never repaired: a hand-edited unit
// may be deliberate, and this command does not own the operator's file.
func describeService(marker servicedef.Marker) serviceSummary {
	summary := serviceSummary{
		Path: marker.Path, Identifier: marker.Spec.Identifier, Platform: marker.Spec.Platform,
		RunAs: marker.Spec.RunAs, LogPath: marker.Spec.LogPath,
	}
	content, err := os.ReadFile(marker.Path)
	if err != nil {
		summary.Detail = "definition file is missing or unreadable"
		return summary
	}
	summary.Present = true
	expected, err := servicedef.Render(marker.Spec)
	if err != nil {
		summary.Detail = "recorded definition inputs are no longer valid"
		return summary
	}
	if !bytes.Equal(content, expected) {
		summary.Detail = "definition on disk differs from what this binary would generate"
		return summary
	}
	summary.Matches = true
	if executable, err := hostExecutable(); err == nil && executable != marker.Spec.Executable {
		summary.Matches = false
		summary.Detail = "definition points at another binary than the one that ran this command"
	}
	return summary
}

func writeJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
