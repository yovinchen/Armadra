package automation

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

func parseTime(t *testing.T, value string) time.Time {
	t.Helper()
	result, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func TestFiveFieldCronIANAAndDSTPolicies(t *testing.T) {
	f := setup(t)
	config := f.config(&pb.AutomationSchedule{Kind: &pb.AutomationSchedule_Cron{Cron: &pb.AutomationCron{Expression: "30 2 * * *", Timezone: "America/New_York"}}})
	spring, err := Preview(config, parseTime(t, "2026-03-08T00:00:00Z"), 2)
	if err != nil {
		t.Fatal(err)
	}
	if !spring[0].Equal(parseTime(t, "2026-03-09T06:30:00Z")) {
		t.Fatalf("nonexistent DST minute was not skipped: %v", spring)
	}
	config.Schedule.GetCron().Expression = "30 1 * * *"
	fall, err := Preview(config, parseTime(t, "2026-11-01T00:00:00Z"), 2)
	if err != nil {
		t.Fatal(err)
	}
	if !fall[0].Equal(parseTime(t, "2026-11-01T05:30:00Z")) || !fall[1].Equal(parseTime(t, "2026-11-02T06:30:00Z")) {
		t.Fatalf("fall-back minute ran twice: %v", fall)
	}
	secondFold, err := Preview(config, parseTime(t, "2026-11-01T05:31:00Z"), 1)
	if err != nil || !secondFold[0].Equal(fall[1]) {
		t.Fatal("activation during a fold selected its second occurrence")
	}
	f.clock.Store(fall[0].UnixMilli())
	f.activate(t, "cron", config)
	f.tick(t)
	f.clock.Add(time.Hour.Milliseconds())
	f.tick(t)
	if len(f.dispatcher.runs()) != 1 {
		t.Fatal("durable Cron repeated the folded local slot")
	}
	f.clock.Store(fall[1].UnixMilli())
	f.tick(t)
	if len(f.dispatcher.runs()) != 2 {
		t.Fatal("Cron did not resume next day")
	}
}
func TestThirtyMinuteDSTFoldIsNotAssumedToBeAnHour(t *testing.T) {
	f := setup(t)
	config := f.config(&pb.AutomationSchedule{Kind: &pb.AutomationSchedule_Cron{Cron: &pb.AutomationCron{Expression: "45 1 * * *", Timezone: "Australia/Lord_Howe"}}})
	values, err := Preview(config, parseTime(t, "2026-04-04T00:00:00Z"), 2)
	if err != nil {
		t.Fatal(err)
	}
	if !values[0].Equal(parseTime(t, "2026-04-04T14:45:00Z")) || !values[1].Equal(parseTime(t, "2026-04-05T15:15:00Z")) {
		t.Fatalf("30-minute fold repeated: %v", values)
	}
}
func TestInvalidUnboundedAndNonstandardSchedulesStayRejected(t *testing.T) {
	f := setup(t)
	for _, cron := range []*pb.AutomationCron{{Expression: "@every 1s", Timezone: "UTC"}, {Expression: "0 * * * * *", Timezone: "UTC"}, {Expression: "*/0 * * * *", Timezone: "UTC"}, {Expression: "* * * * *", Timezone: "Local"}, {Expression: "* * * * *", Timezone: "not/a-zone"}} {
		config := f.config(&pb.AutomationSchedule{Kind: &pb.AutomationSchedule_Cron{Cron: cron}})
		if _, err := normalize(config); err == nil {
			t.Fatal("invalid/non-five-field/IANA schedule accepted")
		}
	}
	loop := f.config(&pb.AutomationSchedule{Kind: &pb.AutomationSchedule_LoopAfterCompletion{LoopAfterCompletion: &pb.AutomationLoopAfterCompletion{DelayMs: 1000}}})
	if _, err := normalize(loop); err == nil {
		t.Fatal("unbounded completion loop accepted")
	}
	loop.MaxRuns = 1
	normalized, err := normalize(loop)
	if err != nil || normalized.MisfirePolicy != Skip || normalized.ConcurrencyPolicy != Forbid || normalized.BusyTtlMs != 300000 {
		t.Fatal("safe defaults missing")
	}
	if _, err := Preview(loop, time.Now(), 5); err != ErrUnsupported {
		t.Fatal("future completion times were fabricated")
	}
}

func TestCronLongMisfireWindowDoesNotGenerateUnboundedCatchup(t *testing.T) {
	f := setup(t)
	config := f.config(&pb.AutomationSchedule{Kind: &pb.AutomationSchedule_Cron{Cron: &pb.AutomationCron{Expression: "* * * * *", Timezone: "UTC"}}})
	config.MisfirePolicy = CoalesceOne
	f.activate(t, "long-sleep", config)
	f.clock.Add((30 * 24 * time.Hour).Milliseconds())
	f.tick(t)
	runs := f.allRuns(t, "long-sleep")
	if len(runs) != 1 || !runs[0].Run.MissedSlotsTruncated || runs[0].Run.MissedSlots != maxCronCount || len(f.dispatcher.runs()) != 1 {
		t.Fatal("long missed window was expanded into catch-up executions")
	}
	f.tick(t)
	if len(f.dispatcher.runs()) != 1 {
		t.Fatal("coalesce-one continued replaying its skipped backlog")
	}
}

func TestRunningIntervalContinuesOnMonotonicTimeWhenWallClockRewinds(t *testing.T) {
	f := setup(t)
	var mono atomic.Int64
	mono.Store(1000)
	options := Options{Clock: func() time.Time { return time.UnixMilli(f.clock.Load()) }, MonotonicClock: func() time.Time { return time.UnixMilli(mono.Load()) }, InstanceID: "monotonic-engine"}
	var err error
	f.engine, err = New(f.store, f.dispatcher, f.auth, options)
	if err != nil {
		t.Fatal(err)
	}
	anchor := f.clock.Load()
	f.activate(t, "monotonic", f.interval())
	f.tick(t)
	f.clock.Add(-time.Hour.Milliseconds())
	for iteration := 1; iteration <= 2; iteration++ {
		mono.Add(1000)
		f.clock.Add(1000)
		f.tick(t)
		runs := f.dispatcher.runs()
		if len(runs) != iteration+1 {
			t.Fatal("wall-clock rollback stopped an in-process Interval wait")
		}
		if runs[iteration].ScheduledAtUnixMs != anchor+int64(iteration)*1000 || runs[iteration].CreatedAtUnixMs != f.clock.Load() {
			t.Fatal("logical slot identity was confused with observed dispatch time")
		}
	}
	// Process-only wait state is not guessed after a restart. The persisted UTC
	// cursor still prevents any already admitted slot from being replayed.
	if err = f.store.Close(); err != nil {
		t.Fatal(err)
	}
	f.store, err = storage.Open(f.directory, testHost)
	if err != nil {
		t.Fatal(err)
	}
	options.InstanceID = "restarted"
	f.engine, err = New(f.store, f.dispatcher, f.auth, options)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.engine.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.dispatcher.runs()) != 3 {
		t.Fatal("restart replayed a slot after wall-clock rewind")
	}
}

func TestMonotonicIntervalRebasesAfterForwardClockJump(t *testing.T) {
	f := setup(t)
	var mono atomic.Int64
	mono.Store(1000)
	var err error
	f.engine, err = New(f.store, f.dispatcher, f.auth, Options{Clock: func() time.Time { return time.UnixMilli(f.clock.Load()) }, MonotonicClock: func() time.Time { return time.UnixMilli(mono.Load()) }})
	if err != nil {
		t.Fatal(err)
	}
	config := f.interval()
	config.MisfirePolicy = CoalesceOne
	f.activate(t, "forward", config)
	f.tick(t)
	f.clock.Add(time.Hour.Milliseconds())
	mono.Add(1000)
	f.tick(t)
	if len(f.dispatcher.runs()) != 2 {
		t.Fatal("forward jump did not coalesce once")
	}
	f.clock.Add(1000)
	mono.Add(1000)
	f.tick(t)
	if len(f.dispatcher.runs()) != 3 {
		t.Fatal("forward jump left Interval waiting on the old monotonic mapping")
	}
}
