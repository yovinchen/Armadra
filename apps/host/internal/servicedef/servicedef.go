// Package servicedef renders the service definition files a fixed-account
// deployment needs ("服务器模式"), tails the Host's diagnostic logs and checks a
// candidate binary before an in-place upgrade.
//
// Nothing in this package talks to a service manager. It never invokes
// launchctl, systemctl or sc.exe, never enables and never starts anything: it
// writes a file the operator reviews and registers, so a generated definition
// can be diffed and kept in configuration management. Rendering is a pure
// function of the Spec, so the same inputs always produce byte-identical output.
package servicedef

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"unicode"
)

// Supported target platforms. The renderer takes the platform from the Spec
// rather than from runtime.GOOS so every shape can be generated and asserted on
// from any developer machine, and so the repository's Windows cross-build keeps
// exercising all three code paths.
const (
	PlatformDarwin  = "darwin"
	PlatformLinux   = "linux"
	PlatformWindows = "windows"
)

// DefaultIdentifier is the reverse-DNS label a generated definition carries
// when the operator does not choose one.
const DefaultIdentifier = "local.armadra.host"

// MarkerName is the file inside the Host data directory that records which
// definition was generated for it. It holds no credential: only the inputs that
// produced the file, so `status` can report drift and `uninstall` can find the
// exact file this command wrote.
const MarkerName = "service-definition.json"

// ErrInvalid marks a rejected specification: the caller passed something that
// must not be baked into a service definition.
var ErrInvalid = errors.New("invalid service definition")

// Spec is the complete input of a rendered definition. Every path is absolute
// and every field is operational configuration; a token, password or pairing
// secret must never reach this struct, because its contents are written to a
// file the service manager and every operator can read.
type Spec struct {
	Identifier     string   `json:"identifier"`
	Platform       string   `json:"platform"`
	Executable     string   `json:"executable"`
	RunAs          string   `json:"runAs"`
	DataDir        string   `json:"dataDir"`
	WorkingDir     string   `json:"workingDir"`
	LogPath        string   `json:"logPath"`
	Listen         string   `json:"listen"`
	EndpointsDir   string   `json:"endpointsDir,omitempty"`
	PublicOrigin   string   `json:"publicOrigin,omitempty"`
	CertFile       string   `json:"certFile,omitempty"`
	KeyFile        string   `json:"keyFile,omitempty"`
	AllowedOrigins []string `json:"allowedOrigins,omitempty"`
	WorkerBinary   string   `json:"workerBinary,omitempty"`
	WorkerStateDir string   `json:"workerStateDir,omitempty"`
	// Environment holds NAME=VALUE pairs the service manager exports. Names
	// that look like credential carriers are refused: a service file is not a
	// secret store.
	Environment []string `json:"environment,omitempty"`
}

// Marker is what install records in the data directory.
type Marker struct {
	Spec Spec   `json:"spec"`
	Path string `json:"path"`
}

// reservedAccounts are refused outright. Server mode exists to run the Host
// under a dedicated unprivileged account; generating a unit that asks a service
// manager to run it as the machine's superuser is not a supported deployment.
var reservedAccounts = map[string]bool{
	"root": true, "administrator": true, "system": true, "localsystem": true,
	"networkservice": true, "localservice": true,
}

// secretEnvironmentMarkers name the environment variables this package refuses
// to write. The check is deliberately a refusal, not a redaction: a definition
// that silently dropped a variable would start a Host with a configuration the
// operator did not review.
var secretEnvironmentMarkers = []string{"TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "APIKEY", "API_KEY", "PRIVATE_KEY", "SESSION"}

// Normalize validates the Spec and fills in the defaults that are safe to
// infer. The account is never inferred: server mode means a fixed account the
// operator named, so an empty RunAs is an error rather than the current user.
func (s *Spec) Normalize() error {
	if s.Platform == "" {
		s.Platform = runtime.GOOS
	}
	switch s.Platform {
	case PlatformDarwin, PlatformLinux, PlatformWindows:
	default:
		return fmt.Errorf("%w: unsupported platform %q", ErrInvalid, s.Platform)
	}
	if s.Identifier == "" {
		s.Identifier = DefaultIdentifier
	}
	if err := validateIdentifier(s.Identifier); err != nil {
		return err
	}
	if strings.TrimSpace(s.RunAs) == "" {
		return fmt.Errorf("%w: --run-as ACCOUNT is required; the account is never defaulted to the current user", ErrInvalid)
	}
	if err := validateAccount(s.RunAs); err != nil {
		return err
	}
	if strings.TrimSpace(s.Listen) == "" {
		return fmt.Errorf("%w: listen address is required", ErrInvalid)
	}
	if err := validateValue("listen address", s.Listen); err != nil {
		return err
	}
	required := map[string]*string{"executable": &s.Executable, "data directory": &s.DataDir}
	for name, value := range required {
		if err := validateSpecPath(s.Platform, name, *value); err != nil {
			return err
		}
		*value = cleanFor(s.Platform, *value)
	}
	if s.WorkingDir == "" {
		s.WorkingDir = s.DataDir
	}
	if s.LogPath == "" {
		s.LogPath = joinFor(s.Platform, s.DataDir, "host.log")
	}
	optional := map[string]*string{
		"working directory":  &s.WorkingDir,
		"log file":           &s.LogPath,
		"endpoints director": &s.EndpointsDir,
		"TLS certificate":    &s.CertFile,
		"TLS key":            &s.KeyFile,
		"worker binary":      &s.WorkerBinary,
		"worker state dir":   &s.WorkerStateDir,
	}
	for name, value := range optional {
		if *value == "" {
			continue
		}
		if err := validateSpecPath(s.Platform, name, *value); err != nil {
			return err
		}
		*value = cleanFor(s.Platform, *value)
	}
	if (s.WorkerBinary == "") != (s.WorkerStateDir == "") {
		return fmt.Errorf("%w: scheduled execution needs both the worker binary and its state directory", ErrInvalid)
	}
	if (s.CertFile == "") != (s.KeyFile == "") || (s.CertFile != "") != (s.PublicOrigin != "") {
		return fmt.Errorf("%w: TLS needs a certificate, a key and a public origin", ErrInvalid)
	}
	if s.PublicOrigin != "" {
		if err := validateValue("public origin", s.PublicOrigin); err != nil {
			return err
		}
	}
	for _, origin := range s.AllowedOrigins {
		if err := validateValue("allowed origin", origin); err != nil {
			return err
		}
	}
	for _, entry := range s.Environment {
		if err := validateEnvironment(entry); err != nil {
			return err
		}
	}
	// Ordering is part of the rendered bytes, so sort what the operator may
	// have passed in any order. Two runs with the same flags then produce the
	// same file even if the shell reordered them.
	sort.Strings(s.Environment)
	return nil
}

func validateIdentifier(value string) error {
	if len(value) > 96 {
		return fmt.Errorf("%w: identifier is too long", ErrInvalid)
	}
	for index, char := range value {
		switch {
		case char >= 'a' && char <= 'z', char >= '0' && char <= '9':
		case (char == '.' || char == '-' || char == '_') && index != 0 && index != len(value)-1:
		default:
			return fmt.Errorf("%w: identifier accepts lowercase letters, digits, dot, dash and underscore", ErrInvalid)
		}
	}
	return nil
}

func validateAccount(value string) error {
	if len(value) > 96 {
		return fmt.Errorf("%w: account name is too long", ErrInvalid)
	}
	for _, char := range value {
		if unicode.IsSpace(char) || unicode.IsControl(char) || strings.ContainsRune(`"'<>&|;$`+"`", char) {
			return fmt.Errorf("%w: account name contains an unsupported character", ErrInvalid)
		}
	}
	if reservedAccounts[strings.ToLower(value)] {
		return fmt.Errorf("%w: refuse to generate a definition that runs the Host as %q; use a dedicated account", ErrInvalid, value)
	}
	return nil
}

// validateValue refuses control characters. Every renderer escapes what it
// writes, but a newline in a systemd value or a quote in a batch script would
// change the meaning of the surrounding directive rather than the value.
func validateValue(name, value string) error {
	if value == "" {
		return fmt.Errorf("%w: %s must not be empty", ErrInvalid, name)
	}
	for _, char := range value {
		if unicode.IsControl(char) {
			return fmt.Errorf("%w: %s must not contain control characters", ErrInvalid, name)
		}
	}
	return nil
}

// A launchd or systemd definition carries POSIX paths whatever host renders
// it; only a Windows definition follows the host's own path rules. Cleaning a
// POSIX path with the host's filepath on Windows would turn its slashes into
// backslashes, which the renderer then escapes.
func cleanFor(platform, value string) string {
	if platform == PlatformWindows {
		return filepath.Clean(value)
	}
	return path.Clean(value)
}

func joinFor(platform string, elements ...string) string {
	if platform == PlatformWindows {
		return filepath.Join(elements...)
	}
	return path.Join(elements...)
}

func dirFor(platform, value string) string {
	if platform == PlatformWindows {
		return filepath.Dir(value)
	}
	return path.Dir(value)
}

func absoluteFor(platform, value string) bool {
	if platform == PlatformWindows {
		return filepath.IsAbs(value)
	}
	return strings.HasPrefix(value, "/")
}

func validateSpecPath(platform, name, value string) error {
	if err := validateValue(name, value); err != nil {
		return err
	}
	if !absoluteFor(platform, value) {
		return fmt.Errorf("%w: %s must be an absolute path", ErrInvalid, name)
	}
	return nil
}

func validatePath(name, value string, absolute bool) error {
	if err := validateValue(name, value); err != nil {
		return err
	}
	if absolute && !filepath.IsAbs(value) {
		return fmt.Errorf("%w: %s must be an absolute path", ErrInvalid, name)
	}
	return nil
}

func validateEnvironment(entry string) error {
	name, _, found := strings.Cut(entry, "=")
	if !found || name == "" {
		return fmt.Errorf("%w: environment entries use NAME=VALUE", ErrInvalid)
	}
	if err := validateValue("environment entry", entry); err != nil {
		return err
	}
	for _, char := range name {
		if !(char == '_' || unicode.IsDigit(char) || (unicode.IsLetter(char) && char < unicode.MaxASCII)) {
			return fmt.Errorf("%w: environment name %q is not a plain variable name", ErrInvalid, name)
		}
	}
	upper := strings.ToUpper(name)
	for _, marker := range secretEnvironmentMarkers {
		if strings.Contains(upper, marker) {
			return fmt.Errorf("%w: refuse to write %s into a service definition; supply credentials out of band", ErrInvalid, name)
		}
	}
	return nil
}

// Arguments returns the exact `serve` command line the service manager runs.
// It mirrors what `armadra-host start` hands its own child, so a definition and
// a foreground run configure the same Host.
func (s Spec) Arguments() []string {
	// A definition always names its launcher: the Host it starts is the one a
	// service manager owns, and `upgrade` must be able to tell it apart from
	// the Host the desktop app holds.
	args := []string{"serve", "--data-dir", s.DataDir, "--listen", s.Listen, "--launcher", "service"}
	if s.EndpointsDir != "" {
		args = append(args, "--endpoints-dir", s.EndpointsDir)
	}
	if s.PublicOrigin != "" {
		args = append(args, "--tls-cert", s.CertFile, "--tls-key", s.KeyFile, "--public-origin", s.PublicOrigin)
	}
	for _, origin := range s.AllowedOrigins {
		args = append(args, "--allow-origin", origin)
	}
	if s.WorkerBinary != "" {
		args = append(args, "--worker-binary", s.WorkerBinary, "--worker-state-dir", s.WorkerStateDir)
	}
	return args
}

// FileName is the definition's name inside the service directory.
func (s Spec) FileName() string {
	switch s.Platform {
	case PlatformDarwin:
		return s.Identifier + ".plist"
	case PlatformLinux:
		return s.Identifier + ".service"
	default:
		return s.Identifier + ".install.cmd"
	}
}

// FileMode is the mode the definition is written with. Service managers read
// these files as another user, so they are world-readable; that is safe only
// because the renderer refuses to put a secret in them.
func (s Spec) FileMode() os.FileMode { return 0o644 }

// Render returns the definition bytes for the Spec's platform. It is pure: the
// same Spec always renders the same bytes.
func Render(spec Spec) ([]byte, error) {
	if err := spec.Normalize(); err != nil {
		return nil, err
	}
	switch spec.Platform {
	case PlatformDarwin:
		return renderLaunchd(spec), nil
	case PlatformLinux:
		return renderSystemd(spec), nil
	default:
		return renderWindows(spec), nil
	}
}

// Generate writes the definition into serviceDir and records a marker in the
// data directory. The directory is created 0700 so a half-written definition is
// never readable before its final mode is set; the file itself is replaced
// atomically, so a service manager never reads a truncated unit.
func Generate(spec Spec, serviceDir string) (string, []byte, error) {
	if err := spec.Normalize(); err != nil {
		return "", nil, err
	}
	if err := validatePath("service directory", serviceDir, true); err != nil {
		return "", nil, err
	}
	content, err := Render(spec)
	if err != nil {
		return "", nil, err
	}
	serviceDir = filepath.Clean(serviceDir)
	if err := os.MkdirAll(serviceDir, 0o700); err != nil {
		return "", nil, err
	}
	info, err := os.Lstat(serviceDir)
	if err != nil {
		return "", nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", nil, fmt.Errorf("%w: service directory must be a real directory", ErrInvalid)
	}
	path := filepath.Join(serviceDir, spec.FileName())
	temporary, err := os.CreateTemp(serviceDir, spec.FileName()+".*")
	if err != nil {
		return "", nil, err
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.Write(content); err != nil {
		temporary.Close()
		return "", nil, err
	}
	if err := temporary.Close(); err != nil {
		return "", nil, err
	}
	if err := os.Chmod(temporary.Name(), spec.FileMode()); err != nil {
		return "", nil, err
	}
	if err := os.Rename(temporary.Name(), path); err != nil {
		return "", nil, err
	}
	return path, content, nil
}

// MarkerPath is where the data directory records its generated definition.
func MarkerPath(dataDir string) string { return filepath.Join(dataDir, MarkerName) }

// WriteMarker records the inputs of a generated definition, 0600, beside the
// Host's own private state.
func WriteMarker(dataDir string, marker Marker) error {
	data, err := json.MarshalIndent(marker, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	path := MarkerPath(dataDir)
	temporary, err := os.CreateTemp(dataDir, MarkerName+".*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Chmod(temporary.Name(), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), path)
}

// ReadMarker returns the recorded definition, or os.ErrNotExist when this data
// directory has no generated definition.
func ReadMarker(dataDir string) (Marker, error) {
	var marker Marker
	data, err := os.ReadFile(MarkerPath(dataDir))
	if err != nil {
		return marker, err
	}
	if err := json.Unmarshal(data, &marker); err != nil {
		return marker, fmt.Errorf("%w: recorded service definition is unreadable", ErrInvalid)
	}
	if marker.Path == "" {
		return marker, fmt.Errorf("%w: recorded service definition has no path", ErrInvalid)
	}
	return marker, nil
}

// RemoveMarker drops the record. A missing record is not an error: uninstall
// removes the definition first and the record is only a pointer to it.
func RemoveMarker(dataDir string) error {
	if err := os.Remove(MarkerPath(dataDir)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Owns reports whether content looks like a definition this package generated
// for the Spec: it carries the same identifier and the same program path.
// uninstall deletes nothing that fails this check, so an operator's own unit
// that happens to share a file name survives.
func Owns(content []byte, spec Spec) bool {
	text := string(content)
	return strings.Contains(text, generatedMarker) &&
		strings.Contains(text, spec.Identifier) &&
		strings.Contains(text, executableToken(spec))
}

// executableToken is the program path exactly as the platform's renderer wrote
// it, so the ownership check compares what is actually in the file.
func executableToken(spec Spec) string {
	switch spec.Platform {
	case PlatformDarwin:
		return escapeXML(spec.Executable)
	case PlatformLinux:
		return systemdEscape(spec.Executable)
	default:
		return spec.Executable
	}
}

// generatedMarker appears in every rendered definition so a file can be
// recognised as ours without re-rendering it.
const generatedMarker = "armadra-host install"
