package worker

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	_ "modernc.org/sqlite"
)

// The agent read and drain against a real Rust Runtime
// (Go Host 业务所有权迁移 §2.7, §2.9, action 28).
//
// Every other test of this frame talks to a fake, which proves the Go client
// and nothing about whether the two sides agree on what an agent's state is.
// This one runs the real binary over the real Worker channel and asserts the
// three things that cannot be faked:
//
//  1. The rows the Runtime reports are the rows it has — the reduced state, the
//     unread count, and the transcript reference it stores as a path.
//  2. An absent `errored` comes back absent. The Runtime stores NULL, 0 and 1
//     in one column, and a client that read NULL as false would draw every node
//     nobody has heard from as one that ran cleanly.
//  3. The drain's cursor moves forward over what it reported and answers
//     nothing the second time. That is what makes a pull as safe as the push
//     §2.7 describes: a Host that asks again does not double what it recorded.
//
// Opt-in: ARMADRA_TEST_REAL_WORKER must name an already built native Runtime,
// so an ordinary `go test ./...` needs no Rust toolchain.
func TestRealRustWorkerReportsAndDrainsItsAgentRows(t *testing.T) {
	executable := os.Getenv("ARMADRA_TEST_REAL_WORKER")
	if executable == "" {
		t.Skip("set ARMADRA_TEST_REAL_WORKER to an existing native Runtime binary")
	}
	database := filepath.Join(t.TempDir(), "canvas.db")
	buildRuntimeDatabase(t, database)
	seedAgentRows(t, database)

	client, err := Start(context.Background(), Options{
		Executable: executable, HostID: fixtureHost, CanvasDatabase: database,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if !client.SupportsAgents() {
		t.Fatal("the real Runtime does not advertise the agent capability")
	}

	states, err := client.Agents(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(states.GetAgents()) != 2 {
		t.Fatalf("the Runtime reported %d agents, expected 2", len(states.GetAgents()))
	}
	byNode := map[string]*pb.WorkerAgentState{}
	for _, state := range states.GetAgents() {
		byNode[state.GetNodeId()] = state
	}
	blocked := byNode["node-one"]
	if blocked.GetState() != pb.AgentState_AGENT_STATE_BLOCKED || blocked.GetUnread() != 2 {
		t.Fatalf("the blocked node is not the stored one: %+v", blocked)
	}
	if string(blocked.GetTranscriptRef()) != "/家/一.jsonl" {
		t.Fatalf("the transcript reference was rewritten: %q", blocked.GetTranscriptRef())
	}
	if blocked.Errored != nil {
		t.Fatalf("a NULL errored column came back as a value: %v", blocked.GetErrored())
	}
	clean := byNode["node-two"]
	if clean.Errored == nil || clean.GetErrored() {
		t.Fatalf("a stored false came back as absent or true: %+v", clean)
	}
	// Only the questions still open travel with a listing.
	if len(states.GetApprovals()) != 1 || states.GetApprovals()[0].GetApprovalId() != "approval-open" {
		t.Fatalf("the answered question travelled too: %+v", states.GetApprovals())
	}
	// The Host's own facts are never invented by the Runtime: a revision it has
	// nowhere to store comes back zero rather than filled in with something
	// plausible, which is what stops a handback passing on agreement nobody
	// checked.
	for _, approval := range states.GetApprovals() {
		if approval.GetRevision() != 0 || len(approval.GetRequestSha256()) != 0 {
			t.Fatalf("the Runtime invented a Host-side fact: %+v", approval)
		}
	}

	drained, err := client.Drain(context.Background(), 0, 64)
	if err != nil {
		t.Fatal(err)
	}
	if len(drained.GetEvents()) != 2 {
		t.Fatalf("the drain reported %d turns, expected 2", len(drained.GetEvents()))
	}
	if drained.GetNextSequence() == 0 {
		t.Fatal("the drain answered without moving the cursor")
	}
	// The normalized body is what the Host records the state from, and its
	// digest is what lets a truncated one be refused rather than stored short.
	for _, event := range drained.GetEvents() {
		if len(event.GetPayload()) == 0 || len(event.GetPayloadSha256()) != 32 {
			t.Fatalf("a reported turn carries no verifiable body: %+v", event)
		}
	}
	// Asking again from the cursor the Runtime handed back answers nothing.
	// That is the whole reliability claim of a pull: a Host that asks twice
	// does not record twice.
	again, err := client.Drain(context.Background(), drained.GetNextSequence(), 64)
	if err != nil {
		t.Fatal(err)
	}
	if len(again.GetEvents())+len(again.GetApprovals())+len(again.GetDeliveries()) != 0 {
		t.Fatalf("a second drain from the returned cursor repeated itself: %+v", again)
	}
	if again.GetNextSequence() != drained.GetNextSequence() {
		t.Fatalf("an empty drain moved the cursor: %d -> %d", drained.GetNextSequence(), again.GetNextSequence())
	}
	t.Logf("verified native Rust Worker agent frame: %d agents, %d open questions, cursor %d",
		len(states.GetAgents()), len(states.GetApprovals()), drained.GetNextSequence())
}

// seedAgentRows writes what a machine with two agent nodes on it looks like:
// one blocked with a question nobody has answered, one idle that reported no
// error, and one question that was answered earlier.
func seedAgentRows(t *testing.T, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)&mode=rwc")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec := func(statement string, args ...any) {
		t.Helper()
		if _, err := db.Exec(statement, args...); err != nil {
			t.Fatalf("%v: %s", err, statement)
		}
	}
	exec("INSERT INTO agent_status(node_id,workspace_id,agent_id,state,unread,session_id,verified,restored,transcript_path,last_event_at,session_phase,errored,interrupted,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
		"node-one", "workspace-local", "claude", "blocked", 2, "session-one", 1, 0,
		"/家/一.jsonl", "2026-09-01T10:00:00Z", "turn", nil, 1, "2026-09-01T10:00:01Z")
	exec("INSERT INTO agent_status(node_id,workspace_id,agent_id,state,unread,session_id,verified,restored,transcript_path,last_event_at,session_phase,errored,interrupted,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
		"node-two", "workspace-local", "codex", "idle", 0, "session-two", 0, 0,
		nil, "2026-09-01T10:00:02Z", "", 0, nil, "2026-09-01T10:00:03Z")
	exec("INSERT INTO agent_approvals(id,node_id,workspace_id,request_json,answer,answered_by,created_at,answered_at) VALUES(?,?,?,?,?,?,?,?)",
		"approval-open", "node-one", "workspace-local", `{"tool":"Bash"}`, nil, nil,
		"2026-09-01T10:00:00Z", nil)
	exec("INSERT INTO agent_approvals(id,node_id,workspace_id,request_json,answer,answered_by,created_at,answered_at) VALUES(?,?,?,?,?,?,?,?)",
		"approval-done", "node-two", "workspace-local", `{"tool":"Read"}`, "allow", "user",
		"2026-09-01T09:00:00Z", "2026-09-01T09:00:01Z")
}
