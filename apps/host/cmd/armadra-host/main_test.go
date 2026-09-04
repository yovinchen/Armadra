package main

import (
	"testing"

	"armadra.local/host/internal/hoststate"
	"armadra.local/host/internal/server"
)

func TestStartupFailureReleasesDataDirectory(t *testing.T) {
	dir := t.TempDir()
	occupied, err := server.ListenLocal("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	// Configuration is valid, so the state lock is acquired before bind fails.
	if err := run([]string{"--data-dir", dir, "--listen", occupied.Addr().String()}); err == nil {
		t.Fatal("accepted an occupied listener")
	}
	state, err := hoststate.Open(dir)
	if err != nil {
		t.Fatalf("startup failure retained the lock: %v", err)
	}
	defer state.Close()
}
