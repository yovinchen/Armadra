package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"armadra.local/host/internal/hoststate"
	"armadra.local/host/internal/storage"
)

func TestServeToleratesTransientOwnershipProbe(t *testing.T) {
	dir := t.TempDir()
	probe, err := hoststate.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer probe.Close()
	released := make(chan struct{})
	go func() { time.Sleep(35 * time.Millisecond); _ = probe.Close(); close(released) }()
	state, err := acquireState(context.Background(), dir)
	if err != nil {
		t.Fatalf("transient owner prevented startup: %v", err)
	}
	defer state.Close()
	<-released
}

func TestNoChildWaitAllowsTransitionBeforeRetryingStart(t *testing.T) {
	dir := t.TempDir()
	probe, err := hoststate.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer probe.Close()
	go func() { time.Sleep(35 * time.Millisecond); _ = probe.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	start := time.Now()
	_, err = awaitReady(ctx, dir, nil)
	if !errors.Is(err, errNoOwner) {
		t.Fatalf("expected a retryable empty owner, got %v", err)
	}
	if time.Since(start) < 150*time.Millisecond {
		t.Fatal("did not allow the transition grace period")
	}
}

// The verb is positional, the domain is a flag, and the flag defaults to the
// canvas so every command written before the other five domains existed keeps
// meaning what it meant.
func TestOwnershipDomainFlagDefaultsToTheCanvas(t *testing.T) {
	dir := t.TempDir()
	c, err := parseConfig([]string{"ownership", "status", "--data-dir", dir})
	if err != nil {
		t.Fatal(err)
	}
	if c.ownership.action != "status" || c.ownership.domain != storage.OwnershipDomainCanvas {
		t.Fatalf("status parsed as %+v", c.ownership)
	}
	c, err = parseConfig([]string{"ownership", "status", "--data-dir", dir, "--domain", "session"})
	if err != nil {
		t.Fatal(err)
	}
	if c.ownership.domain != storage.OwnershipDomainSession {
		t.Fatalf("--domain parsed as %q", c.ownership.domain)
	}
	// A name that is not a domain is refused while it is still a typo, not
	// after the data directory lock has been taken.
	if _, err = parseConfig([]string{"ownership", "status", "--data-dir", dir, "--domain", "terminal"}); err == nil {
		t.Fatal("an unknown domain was accepted")
	}
	// The moving verbs still need the Runtime they are going to talk to.
	if _, err = parseConfig([]string{"ownership", "switch", "--data-dir", dir, "--import-id", "abc"}); err == nil {
		t.Fatal("a switch without a Runtime binary was accepted")
	}
	if _, err = parseConfig([]string{"ownership", "rollback", "--data-dir", dir, "--runtime-binary", "/bin/true", "--runtime-database", "/tmp/x.db"}); err == nil {
		t.Fatal("a rollback without an export directory was accepted")
	}
}

// `ownership status --domain D` reads that domain alone, and a domain nobody
// has switched reports the Runtime rather than nothing.
func TestOwnershipStatusReadsOneDomain(t *testing.T) {
	dir := t.TempDir()
	c, err := parseConfig([]string{"ownership", "status", "--data-dir", dir, "--domain", "agent"})
	if err != nil {
		t.Fatal(err)
	}
	if err = runOwnership(context.Background(), c); err != nil {
		t.Fatalf("status refused an unrecorded domain: %v", err)
	}
}
