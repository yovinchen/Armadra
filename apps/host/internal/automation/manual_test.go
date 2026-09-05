package automation

import (
	"context"
	"errors"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

func TestRunNowAddsOneManualSlotWithoutMovingTheSchedule(t *testing.T) {
	f := setup(t)
	// A cron plan whose next scheduled slot is far away: nothing here may move it.
	config := f.config(&pb.AutomationSchedule{Kind: &pb.AutomationSchedule_Cron{Cron: &pb.AutomationCron{Expression: "0 3 * * *", Timezone: "UTC"}}})
	plan := f.activate(t, "plan", config)
	due := plan.Plan.NextDueUnixMs
	run, err := f.engine.RunNow(context.Background(), testAuth, "workspace", "plan", plan.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if run.Run.State != Due || run.Run.ReasonCode != "MANUAL_RUN" || run.Run.ScheduledSlot == "" || run.Run.Misfire {
		t.Fatalf("manual run is not an ordinary due slot: %+v", run.Run)
	}
	after := f.plan(t, "plan")
	if after.Plan.NextDueUnixMs != due || after.Plan.PendingRunId != run.Run.Id || after.Plan.RunCount != 1 {
		t.Fatalf("manual run moved the schedule: %+v", after.Plan)
	}
	// A second manual request while one is queued is a conflict, never a
	// second concurrent delivery to the same target.
	if _, err = f.engine.RunNow(context.Background(), testAuth, "workspace", "plan", after.Revision); !errors.Is(err, storage.ErrConflict) {
		t.Fatal("queued manual run was duplicated:", err)
	}
	f.tick(t)
	runs := f.allRuns(t, "plan")
	if len(runs) != 1 || runs[0].Run.State != Succeeded {
		t.Fatalf("manual run did not complete once: %+v", runs)
	}
	if dispatched := f.dispatcher.runs(); len(dispatched) != 1 {
		t.Fatalf("manual run dispatched %d times", len(dispatched))
	}
	final := f.plan(t, "plan")
	if final.Plan.State != Active || final.Plan.NextDueUnixMs != due {
		t.Fatalf("completion rewrote the schedule: %+v", final.Plan)
	}
}

func TestRunNowRefusesStaleRevisionInactivePlanAndRevokedGrant(t *testing.T) {
	f := setup(t)
	config := f.interval()
	plan := f.activate(t, "plan", config)
	if _, err := f.engine.RunNow(context.Background(), testAuth, "workspace", "plan", plan.Revision+1); !errors.Is(err, storage.ErrConflict) {
		t.Fatal("stale plan revision accepted:", err)
	}
	if _, err := f.engine.RunNow(context.Background(), Authorization{PrincipalID: "someone-else", AuthorizationID: "grant"}, "workspace", "plan", plan.Revision); !errors.Is(err, ErrAuthorization) {
		t.Fatal("another principal ran an owner's plan:", err)
	}
	f.auth.allowed.Store(false)
	if _, err := f.engine.RunNow(context.Background(), testAuth, "workspace", "plan", plan.Revision); !errors.Is(err, ErrAuthorization) {
		t.Fatal("revoked authorization still ran a plan:", err)
	}
	f.auth.allowed.Store(true)
	paused, err := f.engine.Pause(context.Background(), testAuth, "workspace", "plan", plan.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.engine.RunNow(context.Background(), testAuth, "workspace", "plan", paused.Revision); !errors.Is(err, ErrInvalid) {
		t.Fatal("a paused plan was run on demand:", err)
	}
	if len(f.dispatcher.runs()) != 0 {
		t.Fatal("a refused manual request still reached the executor")
	}
}

func TestListPlansStaysInsideItsWorkspace(t *testing.T) {
	f := setup(t)
	f.activate(t, "plan-a", f.once())
	other := f.config(&pb.AutomationSchedule{Kind: &pb.AutomationSchedule_Interval{Interval: &pb.AutomationInterval{AnchorUnixMs: f.clock.Load(), IntervalMs: 60000}}})
	other.WorkspaceId = "other-workspace"
	if _, err := f.engine.Define(context.Background(), testAuth, "plan-b", other, 0); err != nil {
		t.Fatal(err)
	}
	page, err := f.engine.ListPlans(context.Background(), "workspace", "", 100)
	if err != nil || len(page.Plans) != 1 || page.Plans[0].Plan.Id != "plan-a" || page.Plans[0].Revision == 0 {
		t.Fatalf("workspace listing leaked or lost plans: %+v %v", page.Plans, err)
	}
	if page, err = f.engine.ListPlans(context.Background(), "other-workspace", "", 100); err != nil || len(page.Plans) != 1 || page.Plans[0].Plan.Id != "plan-b" {
		t.Fatalf("second workspace listing: %+v %v", page.Plans, err)
	}
	if _, err = f.engine.ListPlans(context.Background(), "", "", 100); !errors.Is(err, ErrInvalid) {
		t.Fatal("an empty workspace listed every plan:", err)
	}
}

func TestRunNowHonoursExpiryAndRunLimit(t *testing.T) {
	f := setup(t)
	config := f.interval()
	config.MaxRuns = 1
	plan := f.activate(t, "plan", config)
	if _, err := f.engine.RunNow(context.Background(), testAuth, "workspace", "plan", plan.Revision); err != nil {
		t.Fatal(err)
	}
	f.tick(t)
	current := f.plan(t, "plan")
	if _, err := f.engine.RunNow(context.Background(), testAuth, "workspace", "plan", current.Revision); !errors.Is(err, ErrInvalid) {
		t.Fatal("manual run exceeded the configured run limit:", err)
	}
	f.clock.Add(int64(time.Hour / time.Millisecond))
	f.tick(t)
	expired := f.plan(t, "plan")
	if _, err := f.engine.RunNow(context.Background(), testAuth, "workspace", "plan", expired.Revision); err == nil {
		t.Fatal("an exhausted plan accepted a manual run")
	}
}
