package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/buildinfo"
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
	// Registering with the platform's service manager is its own switch. The
	// commands do nothing to the machine without it, and nothing at all
	// without --confirm as well.
	registerService bool
	scope           string
	// upgrade's release modes. --from-release fetches from the configured
	// update source; --rollback returns to the binaries the last successful
	// upgrade displaced, and is the only way down from a release.
	fromRelease bool
	rollback    bool
	channel     string
	version     string
	publicKey   string
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
		flags.BoolVar(&s.registerService, "register", false, "Also register the definition with this platform's service manager (needs --confirm and elevation)")
		flags.StringVar(&s.scope, "scope", servicedef.ScopeSystem, "Register for the whole machine (system) or this user (user)")
		flags.BoolVar(&s.confirm, "confirm", false, "Actually run the service manager; without it --register only prints what it would run")
	case "uninstall":
		flags.StringVar(&s.dir, "service-dir", "", "Directory holding the generated definition (default: the one recorded at install)")
		flags.StringVar(&s.identifier, "identifier", servicedef.DefaultIdentifier, "Identifier of the definition to remove")
		flags.StringVar(&s.platform, "target-platform", runtime.GOOS, "Definition format that was generated")
		flags.BoolVar(&s.registerService, "unregister", false, "Also stop and unregister the service before removing the definition (needs --confirm and elevation)")
		flags.StringVar(&s.scope, "scope", servicedef.ScopeSystem, "Scope the service was registered in: system or user")
		flags.BoolVar(&s.confirm, "confirm", false, "Actually run the service manager; without it --unregister only prints what it would run")
	case "logs":
		flags.IntVar(&s.lines, "lines", servicedef.DefaultLogLines, "Number of trailing lines to read")
		flags.StringVar(&s.logFile, "log-file", "", "Absolute log file to read (default: the service log, else the newest startup log)")
	case "upgrade":
		flags.StringVar(&s.binary, "binary", "", "Absolute path to a candidate Host executable")
		flags.BoolVar(&s.fromRelease, "from-release", false, "Download the newest accepted release from --updates-source instead")
		flags.BoolVar(&s.rollback, "rollback", false, "Return to the binaries the last successful upgrade displaced")
		flags.StringVar(&s.channel, "channel", "", "Release channel to consult with --from-release: stable or beta")
		flags.StringVar(&s.version, "version", "", "Exact release version to install with --from-release; must still be within the accepted range")
		flags.StringVar(&s.publicKey, "updates-pubkey", "", "Absolute path to the minisign public key release artifacts are verified with")
		flags.BoolVar(&s.confirm, "confirm", false, "Actually replace the installed binaries; without it nothing changes")
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
		if err := s.normalizeScope(); err != nil {
			return err
		}
	case "uninstall":
		if s.dir != "" && !filepath.IsAbs(s.dir) {
			return fmt.Errorf("--service-dir must be an absolute directory")
		}
		if err := s.normalizeScope(); err != nil {
			return err
		}
	case "logs":
		if s.lines < 0 {
			return fmt.Errorf("--lines must not be negative")
		}
		if s.logFile != "" && !filepath.IsAbs(s.logFile) {
			return fmt.Errorf("--log-file must be an absolute path")
		}
	case "upgrade":
		return s.normalizeUpgrade()
	}
	return nil
}

func (s *serviceFlags) normalizeScope() error {
	if !servicedef.ValidScope(s.scope) {
		return fmt.Errorf("--scope accepts system or user")
	}
	return nil
}

// normalizeUpgrade refuses every combination of the three modes but one. They
// name different sources for the binaries that will replace this process, and
// a command that silently picked between them would be choosing which release
// gets installed.
func (s *serviceFlags) normalizeUpgrade() error {
	chosen := 0
	for _, mode := range []bool{s.binary != "", s.fromRelease, s.rollback} {
		if mode {
			chosen++
		}
	}
	if chosen == 0 {
		return fmt.Errorf("upgrade requires one of --binary ABSOLUTE_PATH, --from-release or --rollback")
	}
	if chosen > 1 {
		return fmt.Errorf("--binary, --from-release and --rollback name different sources; pass exactly one")
	}
	if s.binary != "" && !filepath.IsAbs(s.binary) {
		return fmt.Errorf("upgrade requires --binary ABSOLUTE_PATH")
	}
	if s.publicKey != "" && !filepath.IsAbs(s.publicKey) {
		return fmt.Errorf("--updates-pubkey must be an absolute path")
	}
	if !s.fromRelease {
		if s.channel != "" || s.version != "" {
			return fmt.Errorf("--channel and --version only apply to --from-release")
		}
		return nil
	}
	switch s.channel {
	case "", "stable", "beta":
	default:
		// The development channel never updates, so asking to upgrade from it
		// is a request nothing could satisfy.
		return fmt.Errorf("--channel accepts stable or beta")
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
	Component string `json:"component"`
	// The release this binary was built from, and the channel that produced
	// it. An upgrade compares versions, so a candidate that cannot say which
	// release it is cannot be installed over one that can.
	Version       string `json:"version"`
	Channel       string `json:"channel"`
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
	return writeJSON(ownVersion())
}

// ownVersion is what this binary reports about itself, in the same shape a
// candidate is probed for.
func ownVersion() versionReport {
	return versionReport{
		Component:     servicedef.ComponentName,
		Version:       buildinfo.ReleaseVersion(),
		Channel:       buildinfo.ReleaseChannel(),
		ProtocolMajor: server.ProtocolMajor,
		ProtocolMinor: server.ProtocolMinor,
	}
}

// statusSummary repeats the JSON shape printStatus already produces, so status
// output stays identical when no service definition exists.
type statusSummary struct {
	State      string `json:"state"`
	HostID     string `json:"hostId,omitempty"`
	InstanceID string `json:"hostInstanceId,omitempty"`
	Endpoint   string `json:"httpEndpoint,omitempty"`
	ProcessID  uint32 `json:"processId,omitempty"`
	// Launcher is who started the running Host: desktop, service or cli. It is
	// absent when nothing is running, or when the record does not belong to the
	// instance that answered — a stale file describes a Host that is gone.
	Launcher string `json:"launcher,omitempty"`
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
	summary := *summarize(status)
	summary.Launcher = observedLauncher(c.dataDir, status)
	return writeJSON(statusWithService{statusSummary: summary, Service: describeService(marker)})
}

// observedLauncher reports who started the Host that answered, or "" when the
// record on disk describes a different process. A launcher file outlives a
// crash, so it is only believed when the running instance wrote it.
func observedLauncher(dataDir string, status *pb.HostStatus) string {
	if status == nil {
		return ""
	}
	record, err := hoststate.ReadLauncher(dataDir)
	if err != nil || record.InstanceID != status.GetHostInstanceId() {
		return ""
	}
	return record.Launcher
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
