package automation

import (
	"context"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// The run history is a *time-ordered* page, not an arbitrary slice of the run
// kind. These tests pin the two properties the panel depends on: a page is the
// next N older runs, and a cursor is a position in that order.

// intervalRuns activates an interval plan and lets it produce `count` runs,
// one per second of the fixture clock.
func intervalRuns(t *testing.T, f *fixture, id string, count int) {
	t.Helper()
	f.activate(t, id, f.interval())
	for i := 0; i < count; i++ {
		f.tick(t)
		f.clock.Add(1000)
	}
}

func TestRunHistoryPagesNewestFirstAcrossCursors(t *testing.T) {
	f := setup(t)
	intervalRuns(t, f, "plan-history", 6)

	all := f.allRuns(t, "plan-history")
	if len(all) < 4 {
		t.Fatalf("expected several runs, got %d", len(all))
	}
	for i := 1; i < len(all); i++ {
		if all[i-1].Run.ScheduledAtUnixMs < all[i].Run.ScheduledAtUnixMs {
			t.Fatalf("history is not newest first: %d before %d", all[i-1].Run.ScheduledAtUnixMs, all[i].Run.ScheduledAtUnixMs)
		}
	}

	// The same sequence, walked two at a time, must be exactly the same list.
	walked := []string{}
	cursor := ""
	for pass := 0; pass < 10; pass++ {
		page, err := f.engine.ListRuns(context.Background(), "workspace", "plan-history", cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Runs) > 2 {
			t.Fatalf("page exceeded its limit: %d", len(page.Runs))
		}
		for _, snapshot := range page.Runs {
			walked = append(walked, snapshot.Run.Id)
		}
		if !page.HasMore {
			break
		}
		if page.NextID == "" || page.NextID == cursor {
			t.Fatal("a page that claims more must advance its cursor")
		}
		cursor = page.NextID
	}
	if len(walked) != len(all) {
		t.Fatalf("paging returned %d runs, one shot returned %d", len(walked), len(all))
	}
	for i, id := range walked {
		if id != all[i].Run.Id {
			t.Fatalf("paged order differs at %d: %s vs %s", i, id, all[i].Run.Id)
		}
	}
}

func TestRunHistoryRefusesAnotherPlansCursor(t *testing.T) {
	f := setup(t)
	intervalRuns(t, f, "plan-a", 2)
	intervalRuns(t, f, "plan-b", 2)

	page, err := f.engine.ListRuns(context.Background(), "workspace", "plan-a", "", 1)
	if err != nil || !page.HasMore {
		t.Fatalf("expected a first page with more: %v", err)
	}
	// A cursor belongs to the plan it was issued for; reusing it elsewhere
	// would page through another plan's history.
	if _, err = f.engine.ListRuns(context.Background(), "workspace", "plan-b", page.NextID, 10); err != ErrInvalid {
		t.Fatalf("expected ErrInvalid for a foreign cursor, got %v", err)
	}
	// And one plan's history never leaks into the other's.
	for _, id := range []string{"plan-a", "plan-b"} {
		for _, snapshot := range f.allRuns(t, id) {
			if snapshot.Run.PlanId != id {
				t.Fatalf("%s history contains a run of %s", id, snapshot.Run.PlanId)
			}
		}
	}
}

func TestRunHistoryBackfillProjectsRunsWrittenBeforeTheIndex(t *testing.T) {
	f := setup(t)
	intervalRuns(t, f, "plan-old", 4)
	before := f.allRuns(t, "plan-old")
	if len(before) < 3 {
		t.Fatalf("expected several runs, got %d", len(before))
	}

	// Delete every index row, which is what a database written before the
	// index existed looks like.
	page, err := f.store.List(context.Background(), storage.ListOptions{WorkspaceID: "workspace", Kind: historyKind, Limit: 500})
	if err != nil {
		t.Fatal(err)
	}
	changes := []storage.Change{}
	for _, entity := range page.Entities {
		changes = append(changes, storage.Change{Key: entity.Key, ExpectedRevision: entity.Revision, Delete: true})
	}
	if len(changes) != len(before) {
		t.Fatalf("expected one index row per run, got %d for %d runs", len(changes), len(before))
	}
	if _, err = f.store.Apply(context.Background(), "test/drop-history", changes); err != nil {
		t.Fatal(err)
	}
	if runs := f.allRuns(t, "plan-old"); len(runs) != 0 {
		t.Fatalf("expected an empty history after dropping the index, got %d", len(runs))
	}

	if err = f.engine.EnsureRunHistory(context.Background()); err != nil {
		t.Fatal(err)
	}
	after := f.allRuns(t, "plan-old")
	if len(after) != len(before) {
		t.Fatalf("backfill produced %d runs, expected %d", len(after), len(before))
	}
	for i := range after {
		if after[i].Run.Id != before[i].Run.Id {
			t.Fatalf("backfilled order differs at %d", i)
		}
	}

	// Marked done, so a restart does not walk it again — and running it twice
	// never duplicates a row.
	if err = f.engine.EnsureRunHistory(context.Background()); err != nil {
		t.Fatal(err)
	}
	if again := f.allRuns(t, "plan-old"); len(again) != len(before) {
		t.Fatalf("a second backfill changed the history: %d", len(again))
	}
	done, err := f.engine.historyProjected(context.Background(), "workspace")
	if err != nil || !done {
		t.Fatalf("expected the workspace to be marked projected: %v %v", done, err)
	}
}

func TestHistoryIDOrdersByDescendingInstant(t *testing.T) {
	older := historyID("plan", 1_000, "a")
	newer := historyID("plan", 2_000, "b")
	if !(newer < older) {
		t.Fatalf("a newer run must sort first: %q vs %q", newer, older)
	}
	// The plan prefix keeps one plan contiguous, and out-of-range instants are
	// clamped rather than producing a key that sorts anywhere at all.
	if got := historyID("plan", -1, "a"); got != historyID("plan", 0, "a") {
		t.Fatalf("a negative instant must clamp to the oldest key, got %q", got)
	}
	if got := historyID("plan", maxTimestampMS+5, "a"); got != historyID("plan", maxTimestampMS, "a") {
		t.Fatalf("an out-of-range instant must clamp, got %q", got)
	}
	ref := new(pb.AutomationRunRef)
	if proto.Size(ref) != 0 {
		t.Fatal("empty ref should encode to nothing")
	}
}
