package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"armadra.local/host/internal/hoststate"
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
