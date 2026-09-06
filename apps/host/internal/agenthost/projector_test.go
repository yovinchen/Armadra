package agenthost

import (
	"path/filepath"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/ownership"
)

func check(report *pb.OwnershipReport, name string) *pb.ConsistencyCheck {
	for _, entry := range report.GetChecks() {
		if entry.GetCheck() == name {
			return entry
		}
	}
	return nil
}

// Adopting projects every staged table and verifies the result item for item.
// The two things worth proving are the ones the Runtime spells differently: an
// absent `errored` stays absent, and the handoff outbox wins where it says more
// than the handoff row.
func TestAdoptProjectsEveryTableAndKeepsTheAbsences(t *testing.T) {
	f := newFixture(t)
	f.stageDomain()
	report, err := f.service.Adopt(fixtureContext, importID)
	if err != nil {
		t.Fatal(err)
	}
	if !report.GetMatched() {
		for _, entry := range report.GetChecks() {
			if !entry.GetMatched() {
				t.Errorf("%s: expected %d actual %d %v", entry.GetCheck(), entry.GetExpectedCount(), entry.GetActualCount(), entry.GetDifferences())
			}
		}
		t.Fatal("the adoption did not verify")
	}
	if entry := check(report, "agent.status.count"); entry == nil || entry.GetActualCount() != 2 {
		t.Fatalf("both statuses were not projected: %+v", entry)
	}
	status, err := f.service.Status(fixtureContext, nodeOne)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != int32(pb.AgentState_AGENT_STATE_BLOCKED) || status.Unread != 2 {
		t.Fatalf("the reduced state did not survive: %+v", status)
	}
	// NULL, not zero. A node nobody has reported an error for is a grey badge;
	// a node that reported none is a green one.
	if status.Errored != nil {
		t.Fatalf("an absent errored flag became a value: %v", *status.Errored)
	}
	if status.Interrupted == nil || !*status.Interrupted {
		t.Fatal("a reported interruption was lost")
	}
	// The outbox said `dispatching` while the handoff row said `prepared`. A
	// client reading only the row would offer to send it again.
	handoff, err := f.service.Handoff(fixtureContext, "handoff-one")
	if err != nil {
		t.Fatal(err)
	}
	if handoff.State != int32(pb.HandoffState_HANDOFF_STATE_DISPATCHING) || handoff.Attempts != 2 {
		t.Fatalf("the outbox state was not merged in: %+v", handoff)
	}
	// The open question is open, and the unacknowledged message is unread.
	approvals, err := f.store.ListApprovals(fixtureContext, nodeOne, true, 0)
	if err != nil || len(approvals) != 1 {
		t.Fatalf("the open question did not survive: %v %d", err, len(approvals))
	}
	inbox, err := f.store.ListMailbox(fixtureContext, nodeOne, true, 0)
	if err != nil || len(inbox) != 1 || inbox[0].Body != "接手 agent 域" {
		t.Fatalf("the unread message did not survive: %v %+v", err, inbox)
	}
	// And re-adopting the same import changes nothing, so a second switch does
	// not tell every client that every agent moved.
	before, watermark, err := f.store.Watermark(fixtureContext)
	if err != nil {
		t.Fatal(err)
	}
	_ = before
	if _, err = f.service.Adopt(fixtureContext, importID); err != nil {
		t.Fatal(err)
	}
	_, after, err := f.store.Watermark(fixtureContext)
	if err != nil || after != watermark {
		t.Fatalf("re-adopting republished %d events", after-watermark)
	}
}

// A row this projection cannot read blocks the switch. A default here is an
// agent shown as idle when it is blocked.
func TestAnUnknownStateBlocksTheSwitch(t *testing.T) {
	f := newFixture(t)
	f.stage(legacyStatus, "agent_status", "node_id", workspaceID, []*pb.ImportedSqlColumn{
		textColumn("node_id", nodeOne),
		textColumn("workspace_id", workspaceID),
		textColumn("agent_id", "claude"),
		textColumn("state", "思考中"),
		number("unread", 0),
		number("verified", 0),
		number("restored", 0),
		textColumn("updated_at", "2026-09-01T10:00:00Z"),
	})
	if _, err := f.service.Adopt(fixtureContext, importID); err == nil {
		t.Fatal("an unreadable state was projected instead of refused")
	}
}

// The adoption ends by settling what was in flight. A handoff adopted
// mid-dispatch was claimed by a process that is no longer the writer, and
// leaving it claimed would leave it claimed forever.
func TestAdoptionSettlesAnInFlightDispatch(t *testing.T) {
	f := newFixture(t)
	f.stageDomain()
	report, err := f.service.AsProjector().Adopt(fixtureContext, ownership.Adoption{ImportID: importID})
	if err != nil {
		t.Fatal(err)
	}
	if !report.GetMatched() {
		t.Fatal("the adoption did not verify")
	}
	if entry := check(report, "agent.handoffs.reconcile"); entry == nil || entry.GetActualCount() != 1 {
		t.Fatalf("the in-flight dispatch was not settled: %+v", entry)
	}
	handoff, err := f.service.Handoff(fixtureContext, "handoff-one")
	if err != nil {
		t.Fatal(err)
	}
	if handoff.State != int32(pb.HandoffState_HANDOFF_STATE_UNKNOWN_OUTCOME) {
		t.Fatalf("the claim was not resolved: %+v", handoff)
	}
	if len(f.machine.handoffs) != 0 {
		t.Fatal("the adoption resent a bundle")
	}
}

// A handback writes a package and then proves it landed by asking the Worker to
// read its own rows. A Worker that answers with something else must not let the
// epoch move.
func TestReleaseComparesTheWorkersOwnRows(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_BLOCKED)
	f.machine.held = []*pb.WorkerAgentState{{
		NodeId: nodeOne, WorkspaceId: workspaceID, AgentId: "claude",
		State: pb.AgentState_AGENT_STATE_BLOCKED,
	}}
	directory := filepath.Join(t.TempDir(), "package")
	report, err := f.service.Export(fixtureContext, directory, 2)
	if err != nil || !report.GetMatched() {
		t.Fatalf("the package was not written: %v", err)
	}
	if report.GetEntityCount() != 1 {
		t.Fatalf("the package does not hold the record: %d", report.GetEntityCount())
	}
	index, _, err := readExportIndex(directory)
	if err != nil {
		t.Fatal(err)
	}
	if index.Domain != ExportDomain || index.Epoch != 2 || len(index.Files) != 1 {
		t.Fatalf("the package does not describe itself: %+v", index)
	}
}

// A package the Host wrote twice into the same directory would destroy the only
// copy of the first attempt.
func TestExportRefusesANonEmptyDirectory(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_IDLE)
	directory := filepath.Join(t.TempDir(), "package")
	if _, err := f.service.Export(fixtureContext, directory, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Export(fixtureContext, directory, 2); err == nil {
		t.Fatal("a second export overwrote the first package")
	}
}
