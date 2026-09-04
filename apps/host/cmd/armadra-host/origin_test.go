package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInvalidOriginFailsBeforeStateCreation(t *testing.T) {
	for _, origin := range []string{"*", "null", "http://example.com", "https://example.com/path", "https://example.com\n"} {
		dir := filepath.Join(t.TempDir(), "must-not-be-created")
		if err := run([]string{"--data-dir", dir, "--listen", "127.0.0.1:0", "--allow-origin", origin}); err == nil {
			t.Fatalf("accepted %q", origin)
		}
		if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("invalid origin touched data directory")
		}
	}
}
func TestRepeatedOriginFlags(t *testing.T) {
	var flags allowedOriginFlags
	for _, value := range []string{"http://localhost:1420", "https://EXAMPLE.COM:443", "tauri://localhost"} {
		if err := flags.Set(value); err != nil {
			t.Fatal(err)
		}
	}
	if err := flags.normalize(); err != nil {
		t.Fatal(err)
	}
	if len(flags) != 3 || flags[1] != "https://example.com" {
		t.Fatalf("origins not preserved/canonicalized: %v", flags)
	}
}

func TestRejectedOriginDoesNotEchoCredentials(t *testing.T) {
	err := run([]string{"--allow-origin", "https://user:private-password@example.com/private-token"})
	if err == nil {
		t.Fatal("accepted credential origin")
	}
	if strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "user") {
		t.Fatal("rejected value was echoed")
	}
}
