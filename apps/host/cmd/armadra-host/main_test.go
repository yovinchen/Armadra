package main

import (
	"testing"

	"armadra.local/host/internal/hoststate"
)

func TestStartupFailureReleasesDataDirectory(t *testing.T) {
	dir := t.TempDir()
	// The state lock has been acquired before the listener rejects this address.
	if err := run([]string{"--data-dir", dir, "--listen", "0.0.0.0:0"}); err == nil {
		t.Fatal("accepted a non-loopback listener")
	}
	state, err := hoststate.Open(dir)
	if err != nil {
		t.Fatalf("startup failure retained the lock: %v", err)
	}
	defer state.Close()
}
