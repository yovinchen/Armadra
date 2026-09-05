package githubcred

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// No test in this package writes to the developer's real keychain, and none
// invokes a real gh binary: the store and the CLI are both injected.

var testContext = context.Background()

const sampleToken = "gho_TestValueNotARealCredential0000"

func TestFileStoreKeepsTheTokenPrivateAtRest(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "github-credentials")
	store := &fileStore{directory: directory}
	if store.Kind() != StoreFileFallback {
		t.Fatal("the file store must report itself as the degraded fallback")
	}
	reference, err := Reference("api.github.com")
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Put(testContext, reference, sampleToken); err != nil {
		t.Fatal(err)
	}
	path, err := store.path(reference)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("token file is %v", info.Mode().Perm())
	}
	value, err := store.Get(testContext, reference)
	if err != nil || value != sampleToken {
		t.Fatalf("read back %q (%v)", value, err)
	}
	if runtime.GOOS != "windows" {
		// Something else has had the chance to read a widened file, so the
		// credential is reported unavailable rather than used as if private.
		if err = os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err = store.Get(testContext, reference); !errors.Is(err, ErrUnavailable) {
			t.Fatal("a world-readable token file was used anyway")
		}
		if err = os.Chmod(path, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err = store.Delete(testContext, reference); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Get(testContext, reference); !errors.Is(err, ErrUnavailable) {
		t.Fatal("a deleted token was still readable")
	}
	// Deleting what is already gone is the state the caller asked for.
	if err = store.Delete(testContext, reference); err != nil {
		t.Fatal(err)
	}
}

// A reference is an account label, and the path built from it must stay inside
// the credential directory.
func TestReferenceAndPathAreConstrained(t *testing.T) {
	for _, invalid := range []string{"", "Api.GitHub.com/../x", "host with space", "-bad-"} {
		if _, err := Reference(invalid); err == nil {
			t.Fatalf("%q was accepted as an API host", invalid)
		}
	}
	store := &fileStore{directory: t.TempDir()}
	for _, hostile := range []string{"../escape", "a/b", `a\b`} {
		if _, err := store.path(hostile); err == nil {
			t.Fatalf("%q produced a path", hostile)
		}
	}
}

// A value that is not a bearer token is refused before it can reach a header or
// a keychain tool's stdin.
func TestTokenShapeIsEnforced(t *testing.T) {
	for _, invalid := range []string{"", "short", "with space", "with\nnewline", "with\ttab", "bad\x00byte"} {
		if ValidToken(invalid) {
			t.Fatalf("%q was accepted as a token", invalid)
		}
	}
	if !ValidToken(sampleToken) {
		t.Fatal("a plausible token was refused")
	}
	store := &fileStore{directory: t.TempDir()}
	if err := store.Put(testContext, "api@api.github.com", "with newline\n"); !errors.Is(err, ErrInvalid) {
		t.Fatal("a malformed token was written")
	}
}

// The gh source only ever reads. It asks for the host that matches the
// configured base, so an enterprise login is never answered with a public token.
func TestGhCLIAsksForTheConfiguredHostAndStoresNothing(t *testing.T) {
	var seen []string
	cli := GhCLI{
		Lookup: func(string) (string, error) { return "/usr/bin/gh", nil },
		Run: func(ctx context.Context, tool string, args ...string) ([]byte, error) {
			seen = append([]string{tool}, args...)
			return []byte(sampleToken + "\n"), nil
		},
	}
	token, err := cli.Token(testContext, "ghe.example.com")
	if err != nil || token != sampleToken {
		t.Fatalf("gh returned %q (%v)", token, err)
	}
	if len(seen) != 5 || seen[1] != "auth" || seen[2] != "token" || seen[3] != "--hostname" || seen[4] != "ghe.example.com" {
		t.Fatalf("gh was invoked as %v", seen)
	}
	// A machine with no gh is not an error the user has to debug; it is a
	// source that is simply unavailable here.
	missing := GhCLI{Lookup: func(string) (string, error) { return "", errors.New("not found") }}
	if _, err = missing.Token(testContext, "github.com"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("a missing gh reported %v", err)
	}
	garbage := GhCLI{
		Lookup: func(string) (string, error) { return "/usr/bin/gh", nil },
		Run:    func(context.Context, string, ...string) ([]byte, error) { return []byte("not a token!!"), nil },
	}
	if _, err = garbage.Token(testContext, "github.com"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unusable gh output reported %v", err)
	}
}
