// Package githubcred is the Host's GitHub API credential service. It is
// separate from the Worker's git credential handling by design: SSH keys and
// git credential helpers belong to the execution host, while the API token
// belongs to the Host.
//
// Two sources are supported. An existing `gh` login is only ever read, on
// demand, and nothing is stored. A pasted token is written to the OS secret
// store under a reference; the token itself never reaches the database, a log,
// a project directory or any Protobuf message the Host sends back.
package githubcred

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

var (
	ErrInvalid     = errors.New("invalid github credential request")
	ErrUnavailable = errors.New("github credential is not available")
	ErrUnsupported = errors.New("github credential source is not supported here")
)

// Store is where a pasted token lives at rest. FileFallback is a deliberately
// visible degradation: a 0600 file is weaker than a keychain, and the panel
// says so rather than implying the same protection everywhere.
type Store string

const (
	StoreNone         Store = "none"
	StoreOSKeychain   Store = "os_keychain"
	StoreFileFallback Store = "file_fallback"
)

// keychainService is the generic-password service name. The account carries the
// API host, so an enterprise credential and a public one never collide.
const keychainService = "armadra-github-api"

// A GitHub token is an opaque ASCII string. Rejecting anything else keeps a
// newline out of the value written over the keychain tool's stdin, and keeps
// control characters out of an Authorization header.
var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_.~+/=-]{8,512}$`)

// ValidToken reports whether a pasted value can be used as a bearer token.
func ValidToken(value string) bool { return tokenPattern.MatchString(value) }

var hostPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$`)

// Reference names one stored secret. It is an account label, never a secret.
func Reference(apiHost string) (string, error) {
	apiHost = strings.ToLower(strings.TrimSpace(apiHost))
	if !hostPattern.MatchString(apiHost) {
		return "", ErrInvalid
	}
	return "api@" + apiHost, nil
}

// SecretStore reads and writes one token. The interface exists so tests never
// touch the developer's real keychain or home directory.
type SecretStore interface {
	Kind() Store
	Put(ctx context.Context, reference, token string) error
	Get(ctx context.Context, reference string) (string, error)
	Delete(ctx context.Context, reference string) error
}

// OpenSecretStore picks the strongest store this machine offers. macOS gets the
// login keychain; everywhere else falls back to a 0600 file under the Host data
// directory, and reports that it did.
func OpenSecretStore(dataDir string) SecretStore {
	if runtime.GOOS == "darwin" {
		if path, err := exec.LookPath("security"); err == nil {
			return &keychainStore{tool: path}
		}
	}
	return &fileStore{directory: filepath.Join(dataDir, "github-credentials")}
}

type keychainStore struct{ tool string }

func (keychainStore) Kind() Store { return StoreOSKeychain }

// Put writes through the keychain tool's interactive prompt rather than its
// -w flag, because a flag value would put the token in the process arguments
// where any process of this user could read it.
func (s *keychainStore) Put(ctx context.Context, reference, token string) error {
	if !ValidToken(token) {
		return ErrInvalid
	}
	command := exec.CommandContext(ctx, s.tool, "add-generic-password", "-a", reference, "-s", keychainService, "-U", "-w")
	command.Env = minimalEnv()
	command.Stdin = strings.NewReader(token + "\n" + token + "\n")
	command.Stdout, command.Stderr = nil, nil
	if err := command.Run(); err != nil {
		return ErrUnavailable
	}
	// The tool exits zero even when the prompts disagreed, so the write is
	// confirmed by reading it back rather than trusted.
	stored, err := s.Get(ctx, reference)
	if err != nil || stored != token {
		return ErrUnavailable
	}
	return nil
}

func (s *keychainStore) Get(ctx context.Context, reference string) (string, error) {
	command := exec.CommandContext(ctx, s.tool, "find-generic-password", "-a", reference, "-s", keychainService, "-w")
	command.Env = minimalEnv()
	output, err := command.Output()
	if err != nil {
		return "", ErrUnavailable
	}
	token := strings.TrimRight(string(output), "\r\n")
	if !ValidToken(token) {
		return "", ErrUnavailable
	}
	return token, nil
}

func (s *keychainStore) Delete(ctx context.Context, reference string) error {
	command := exec.CommandContext(ctx, s.tool, "delete-generic-password", "-a", reference, "-s", keychainService)
	command.Env = minimalEnv()
	if err := command.Run(); err != nil {
		// Already absent is the state the caller asked for.
		if _, readErr := s.Get(ctx, reference); readErr != nil {
			return nil
		}
		return ErrUnavailable
	}
	return nil
}

type fileStore struct{ directory string }

func (fileStore) Kind() Store { return StoreFileFallback }

func (s *fileStore) path(reference string) (string, error) {
	// The reference is a fixed shape, but the path is still built from a
	// sanitized name so a stored value can never escape the directory.
	name := strings.NewReplacer("@", "_at_", ".", "_", ":", "_").Replace(reference)
	if name == "" || strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return "", ErrInvalid
	}
	return filepath.Join(s.directory, name+".token"), nil
}

func (s *fileStore) Put(ctx context.Context, reference, token string) error {
	if !ValidToken(token) {
		return ErrInvalid
	}
	path, err := s.path(reference)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(s.directory, 0o700); err != nil {
		return ErrUnavailable
	}
	// Written 0600 from creation, never widened afterwards, so the value is
	// never briefly world readable.
	temporary := path + ".new"
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_TRUNC|os.O_EXCL, 0o600)
	if err != nil {
		_ = os.Remove(temporary)
		if file, err = os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_TRUNC|os.O_EXCL, 0o600); err != nil {
			return ErrUnavailable
		}
	}
	if _, err = file.WriteString(token); err != nil {
		file.Close()
		_ = os.Remove(temporary)
		return ErrUnavailable
	}
	if err = file.Sync(); err != nil {
		file.Close()
		_ = os.Remove(temporary)
		return ErrUnavailable
	}
	if err = file.Close(); err != nil {
		_ = os.Remove(temporary)
		return ErrUnavailable
	}
	if err = os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return ErrUnavailable
	}
	return nil
}

func (s *fileStore) Get(ctx context.Context, reference string) (string, error) {
	path, err := s.path(reference)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", ErrUnavailable
	}
	// A widened file is not trusted: something else has had the chance to read
	// it, so the credential is reported unavailable instead of used silently.
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return "", ErrUnavailable
	}
	if info.Size() > 4096 {
		return "", ErrUnavailable
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", ErrUnavailable
	}
	token := strings.TrimRight(string(data), "\r\n")
	if !ValidToken(token) {
		return "", ErrUnavailable
	}
	return token, nil
}

func (s *fileStore) Delete(ctx context.Context, reference string) error {
	path, err := s.path(reference)
	if err != nil {
		return err
	}
	if err = os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return ErrUnavailable
	}
	return nil
}

// minimalEnv keeps a helper process from inheriting the Host's environment.
// Only what a command genuinely needs to run is passed through.
func minimalEnv() []string {
	env := []string{}
	for _, name := range []string{"PATH", "HOME", "USERPROFILE", "SystemRoot", "TMPDIR", "LANG"} {
		if value, ok := os.LookupEnv(name); ok {
			env = append(env, name+"="+value)
		}
	}
	return env
}

// GhCLI reads a token out of an existing `gh` login. The user has to enable
// this explicitly; nothing here inspects a gh configuration on its own.
type GhCLI struct {
	// Lookup and Run are injected in tests so no real gh binary is invoked.
	Lookup func(string) (string, error)
	Run    func(ctx context.Context, tool string, args ...string) ([]byte, error)
}

// Token asks gh for the token for one API host. The value is returned to the
// caller and never written anywhere by this type.
func (g GhCLI) Token(ctx context.Context, apiHost string) (string, error) {
	if !hostPattern.MatchString(apiHost) {
		return "", ErrInvalid
	}
	lookup := g.Lookup
	if lookup == nil {
		lookup = exec.LookPath
	}
	name := "gh"
	if runtime.GOOS == "windows" {
		name = "gh.exe"
	}
	tool, err := lookup(name)
	if err != nil {
		return "", ErrUnsupported
	}
	run := g.Run
	if run == nil {
		run = func(ctx context.Context, tool string, args ...string) ([]byte, error) {
			bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			command := exec.CommandContext(bounded, tool, args...)
			command.Env = minimalEnv()
			command.Stdin = nil
			return command.Output()
		}
	}
	// The host is passed explicitly so an enterprise login is not answered with
	// a public token, or the reverse.
	output, err := run(ctx, tool, "auth", "token", "--hostname", apiHost)
	if err != nil {
		return "", ErrUnavailable
	}
	if len(output) > 8192 {
		return "", ErrUnavailable
	}
	token := strings.TrimSpace(string(output))
	if !ValidToken(token) {
		return "", ErrUnavailable
	}
	return token, nil
}
