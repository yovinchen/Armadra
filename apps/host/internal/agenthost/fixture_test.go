package agenthost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
	"armadra.local/host/internal/worker"
	"google.golang.org/protobuf/proto"
)

const (
	fixtureHost = "0123456789abcdef0123456789abcdef"
	importID    = "abcdef0123456789abcdef0123456789"
	workspaceID = "workspace-one"
	otherID     = "workspace-two"
	nodeOne     = "node-one"
	nodeTwo     = "node-two"
)

var fixtureContext = context.Background()

// machine is an Executor that answers from a script rather than a process. It
// is what lets every decision this domain makes be exercised without a Rust
// binary — including the ones that only happen when the execution host refuses,
// answers UNKNOWN, or cannot be reached at all.
type machine struct {
	instance string
	// queued is what the next drain will report, and cursor is where it says
	// the caller should read from next.
	queued []*pb.DrainedAgentEvents
	// held is what the Worker claims its own rows say, for the handback check.
	held []*pb.WorkerAgentState
	// answers records every approval decision that reached the machine, which
	// is what proves an answer was delivered rather than merely recorded.
	answers []*pb.DeliverApprovalAnswerRequest
	// outcome is what a delivery reports back. UNKNOWN is the interesting one.
	outcome pb.DeliveryOutcome
	// failDeliver makes the write fail mid-flight.
	failDeliver bool
	handoffs    []*pb.DeliverHandoffRequest
	installs    []string
	repairs     []string
	// reads records the transcript and screen requests that reached the
	// machine, so a test can assert what this Host filled in for the caller
	// rather than only what came back.
	transcripts []*pb.ReadTranscriptRequest
	screens     []*pb.CaptureAgentScreenRequest
	// noTranscript is the refusal a provider that keeps none produces.
	noTranscript bool
}

func newMachine() *machine {
	return &machine{instance: "worker-a", outcome: pb.DeliveryOutcome_DELIVERY_OUTCOME_SUBMITTED}
}

func (m *machine) Agents(context.Context) (*pb.WorkerAgentStates, error) {
	return &pb.WorkerAgentStates{WorkerInstanceId: m.instance, Agents: m.held}, nil
}

func (m *machine) Drain(_ context.Context, _ uint64, _ uint32) (*pb.DrainedAgentEvents, error) {
	if len(m.queued) == 0 {
		return &pb.DrainedAgentEvents{}, nil
	}
	next := m.queued[0]
	m.queued = m.queued[1:]
	return next, nil
}

func (m *machine) DeliverApproval(_ context.Context, request *pb.DeliverApprovalAnswerRequest) (*pb.AgentDeliveryReceipt, error) {
	if m.failDeliver {
		return nil, context.DeadlineExceeded
	}
	m.answers = append(m.answers, request)
	return &pb.AgentDeliveryReceipt{TraceId: request.GetApprovalId(), Outcome: pb.DeliveryOutcome_DELIVERY_OUTCOME_SUBMITTED}, nil
}

func (m *machine) DeliverHandoff(_ context.Context, request *pb.DeliverHandoffRequest) (*pb.AgentDeliveryReceipt, error) {
	if m.failDeliver {
		return nil, context.DeadlineExceeded
	}
	m.handoffs = append(m.handoffs, request)
	return &pb.AgentDeliveryReceipt{
		TraceId:   request.GetHandoffId() + ".delivery",
		Receipt:   "pane:0",
		BodyChars: uint32(len(request.GetBundle())),
		Outcome:   m.outcome,
	}, nil
}

func (m *machine) DeliverMessage(_ context.Context, request *pb.DeliverMessageRequest) (*pb.AgentDeliveryReceipt, error) {
	if m.failDeliver {
		return nil, context.DeadlineExceeded
	}
	return &pb.AgentDeliveryReceipt{TraceId: request.GetTraceId(), Outcome: m.outcome}, nil
}

func (m *machine) Integration(_ context.Context, agentID string, action worker.IntegrationAction) (*pb.IntegrationState, error) {
	m.installs = append(m.installs, string(action)+":"+agentID)
	installed := action == worker.IntegrationInstall
	return &pb.IntegrationState{
		AgentId:           agentID,
		Mode:              "launch",
		Hook:              &pb.IntegrationHalf{Installed: installed, Path: "/home/用户/Library/Application Support/Armadra/integration/claude/settings.json", Revision: 4},
		Skill:             &pb.IntegrationHalf{Installed: installed, Path: "/home/用户/.claude/skills/armadra/SKILL.md", Revision: 6},
		Revision:          406,
		InstalledRevision: 406,
		LaunchArgs:        []string{"--settings", "/home/用户/Library/Application Support/Armadra/integration/claude/settings.json"},
	}, nil
}

func (m *machine) RepairIntegration(_ context.Context, agentID string) (*pb.IntegrationRepairReport, error) {
	m.repairs = append(m.repairs, agentID)
	return &pb.IntegrationRepairReport{
		AgentId: agentID,
		Found: []*pb.LegacyIntegrationFinding{
			{Kind: "hook_entry", Path: "/home/用户/.claude/settings.json", Detail: "/usr/local/bin/aicc-hook claude"},
		},
		Removed: []string{"/home/用户/.claude/settings.json: Stop hooks → /usr/local/bin/aicc-hook claude"},
		Backups: []string{"/home/用户/.claude/settings.json.armadra-backup-20260913101500"},
	}, nil
}

func (m *machine) ReadTranscript(_ context.Context, request *pb.ReadTranscriptRequest) (*pb.TranscriptExcerpt, error) {
	m.transcripts = append(m.transcripts, request)
	if m.noTranscript {
		return nil, errors.New("No transcript this execution host can read for opencode")
	}
	content := []byte("[用户] 修一下构建\n[助手] 好的")
	sum := sha256.Sum256(content)
	return &pb.TranscriptExcerpt{
		NodeId:           request.GetNodeId(),
		Content:          content,
		ContentSha256:    sum[:],
		ObservedAtUnixMs: 1788560523004,
	}, nil
}

func (m *machine) CaptureScreen(_ context.Context, request *pb.CaptureAgentScreenRequest) (*pb.CapturedAgentScreen, error) {
	m.screens = append(m.screens, request)
	return &pb.CapturedAgentScreen{NodeId: request.GetNodeId(), Data: "$ cargo test\nok"}, nil
}

// WorkerAgents is the handback read. It is on the same type so a test can hand
// one object to both the Executor and the AgentReader roles, exactly as the
// production Worker client does.
func (m *machine) WorkerAgents(ctx context.Context) (*pb.WorkerAgentStates, error) {
	return m.Agents(ctx)
}

type fixture struct {
	t        *testing.T
	store    *storage.Store
	service  *Service
	switches *ownership.Service
	machine  *machine
	// unreachable makes every attempt to open a channel fail, which is how the
	// "recorded but not delivered" paths are reached.
	unreachable bool
	clock       time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dataDir := t.TempDir()
	store, err := storage.Open(dataDir, fixtureHost)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	f := &fixture{t: t, store: store, machine: newMachine(), clock: time.UnixMilli(1788560523004)}
	service, err := New(Options{
		Store:      store,
		HostID:     fixtureHost,
		InstanceID: "host-instance-1",
		Now:        func() time.Time { return f.clock },
		Open: func(context.Context, string) (Executor, func(), error) {
			if f.unreachable {
				return nil, nil, context.DeadlineExceeded
			}
			return f.machine, func() {}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	switches, err := ownership.New(ownership.Options{
		Store:      store,
		InstanceID: fixtureHost,
		Projectors: map[string]ownership.Projector{Domain: service.AsProjector()},
		Now:        func() time.Time { return f.clock },
	})
	if err != nil {
		t.Fatal(err)
	}
	f.service, f.switches = service, switches
	return f
}

func (f *fixture) caller(permission, workspace string) Caller {
	return Caller{
		PrincipalID: "principal",
		DeviceID:    "device",
		DeviceEpoch: 1,
		WorkspaceID: workspace,
		Scopes: []auth.Scope{
			{Permission: permission, WorkspaceID: workspace, ExecutionHostID: fixtureHost},
		},
	}
}

// own records the domain as settled on this Host, which is what every write
// path checks before it does anything.
func (f *fixture) own() {
	f.t.Helper()
	if _, err := f.store.PutOwnership(fixtureContext, storage.Ownership{
		Domain:      Domain,
		Owner:       storage.OwnerHost,
		Epoch:       2,
		Phase:       storage.OwnershipSettled,
		ReasonCode:  ownership.ReasonVerified,
		CreatedAtMS: f.clock.UnixMilli(),
		UpdatedAtMS: f.clock.UnixMilli(),
	}, 0); err != nil {
		f.t.Fatal(err)
	}
}

// seedStatus records one node's status directly, which is what a drain would
// have produced. Tests that are not about draining start here.
func (f *fixture) seedStatus(nodeID, workspace string, state pb.AgentState) storage.AgentStatus {
	f.t.Helper()
	status := storage.AgentStatus{
		NodeID:      nodeID,
		WorkspaceID: workspace,
		SessionID:   "session-" + nodeID,
		Generation:  1,
		AgentID:     "claude",
		State:       int32(state),
		UpdatedAtMS: f.clock.UnixMilli(),
	}
	expected := uint64(0)
	if current, err := f.store.GetAgentStatus(fixtureContext, nodeID); err == nil {
		expected = current.Revision
	}
	stamped, err := stampStatus(status)
	if err != nil {
		f.t.Fatal(err)
	}
	result, err := f.store.PutAgentStatus(fixtureContext, "seed/status/"+nodeID+"/"+revisionKey(expected), stamped, expected)
	if err != nil {
		f.t.Fatal(err)
	}
	_ = result
	stored, err := f.store.GetAgentStatus(fixtureContext, nodeID)
	if err != nil {
		f.t.Fatal(err)
	}
	return stored
}

// stageApproval records one open question directly, as a drain would have.
func (f *fixture) stageApproval(approvalID, nodeID string) storage.Approval {
	f.t.Helper()
	approval := storage.Approval{
		ApprovalID:  approvalID,
		NodeID:      nodeID,
		WorkspaceID: workspaceID,
		SessionID:   "session-" + nodeID,
		Generation:  1,
		Request:     []byte(`{"tool":"Bash","command":"rm -rf 构建/"}`),
		State:       int32(pb.ApprovalState_APPROVAL_STATE_PENDING),
		CreatedAtMS: f.clock.UnixMilli(),
	}
	approval.RequestSHA256 = digest(approval.Request)
	stamped, err := stampApproval(approval)
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err = f.store.PutApproval(fixtureContext, "seed/approval/"+approvalID, stamped, 0); err != nil {
		f.t.Fatal(err)
	}
	return stamped
}

// prepare freezes one bundle through the service, which is the only way a
// handoff ever reaches the database.
func (f *fixture) prepare(caller Caller, handoffID string) *pb.Handoff {
	f.t.Helper()
	response, err := f.service.PrepareHandoff(fixtureContext, caller, &pb.PrepareHandoffRequest{
		OperationId:  "prepare/" + handoffID,
		HandoffId:    handoffID,
		SourceNodeId: nodeTwo,
		TargetNodeId: nodeOne,
		Source:       &pb.SessionAddress{SessionId: "session-" + nodeTwo, Generation: 1},
		Target:       &pb.SessionAddress{SessionId: "session-" + nodeOne, Generation: 1},
		Bundle:       []byte(`{"summary":"迁移到 Host"}`),
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return response.GetHandoff()
}

// turn builds one drained batch: a normalized Hook event that reduces to a
// state, plus the question the machine is currently blocked on.
func (f *fixture) turn(nodeID string, state pb.AgentState, sequence uint64) *pb.DrainedAgentEvents {
	f.t.Helper()
	body, err := proto.Marshal(&pb.AgentStatus{
		NodeId:      nodeID,
		WorkspaceId: workspaceID,
		SessionId:   "session-" + nodeID,
		Generation:  1,
		AgentId:     "claude",
		State:       state,
		Unread:      1,
	})
	if err != nil {
		f.t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	return &pb.DrainedAgentEvents{
		NextSequence: sequence,
		Events: []*pb.HookEvent{{
			EventId:          "event-" + nodeID + "-1",
			NodeId:           nodeID,
			WorkspaceId:      workspaceID,
			SessionId:        "session-" + nodeID,
			Generation:       1,
			Provider:         "claude",
			Payload:          body,
			PayloadSha256:    sum[:],
			SchemaVersion:    1,
			Kind:             pb.HookEventKind_HOOK_EVENT_KIND_TURN_END,
			ObservedAtUnixMs: f.clock.UnixMilli(),
		}},
		Approvals: []*pb.Approval{{
			ApprovalId:      "approval-" + nodeID,
			NodeId:          nodeID,
			WorkspaceId:     workspaceID,
			SessionId:       "session-" + nodeID,
			Generation:      1,
			Request:         []byte(`{"tool":"Bash"}`),
			State:           pb.ApprovalState_APPROVAL_STATE_PENDING,
			CreatedAtUnixMs: f.clock.UnixMilli(),
		}},
	}
}

// seedNode and seedEdge write canvas entities directly, because the projection
// reads the canvas domain's own rows rather than a request.
func (f *fixture) seedNode(nodeID, kind string) {
	f.t.Helper()
	encoded, err := proto.Marshal(&pb.CanvasNode{NodeId: nodeID, CanvasId: "canvas-one", Type: kind})
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err = f.store.Apply(fixtureContext, "seed/node/"+nodeID, []storage.Change{{
		Key:     storage.Key{Kind: "canvas.node", ID: nodeID, WorkspaceID: workspaceID},
		Payload: encoded,
	}}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) seedEdge(edgeID, source, target string) {
	f.t.Helper()
	encoded, err := proto.Marshal(&pb.CanvasEdge{
		EdgeId: edgeID, CanvasId: "canvas-one",
		SourceNodeId: source, TargetNodeId: target,
		Kind: pb.CanvasEdgeKind_CANVAS_EDGE_KIND_LINK,
	})
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err = f.store.Apply(fixtureContext, "seed/edge/"+edgeID, []storage.Change{{
		Key:     storage.Key{Kind: "canvas.edge", ID: edgeID, WorkspaceID: workspaceID},
		Payload: encoded,
	}}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) deleteEdge(edgeID string) {
	f.t.Helper()
	entity, err := f.store.Read(fixtureContext, storage.Key{Kind: "canvas.edge", ID: edgeID, WorkspaceID: workspaceID})
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err = f.store.Apply(fixtureContext, "seed/edge/"+edgeID+"/delete", []storage.Change{{
		Key:              storage.Key{Kind: "canvas.edge", ID: edgeID, WorkspaceID: workspaceID},
		ExpectedRevision: entity.Revision,
		Delete:           true,
	}}); err != nil {
		f.t.Fatal(err)
	}
}

func textColumn(name, value string) *pb.ImportedSqlColumn {
	return &pb.ImportedSqlColumn{Name: name, Value: &pb.ImportedSqlColumn_TextValue{TextValue: value}}
}

func number(name string, value int64) *pb.ImportedSqlColumn {
	return &pb.ImportedSqlColumn{Name: name, Value: &pb.ImportedSqlColumn_IntegerValue{IntegerValue: value}}
}

func nullColumn(name string) *pb.ImportedSqlColumn {
	return &pb.ImportedSqlColumn{Name: name, Value: &pb.ImportedSqlColumn_NullValue{NullValue: &pb.SqlNull{}}}
}

// stage stores one legacy row exactly as `armadra-host import` does: an
// `ImportedSqlRow` under `legacy.<table>`, keyed by the import and the digest of
// its primary key.
func (f *fixture) stage(kind, table, keyColumn, workspace string, columns []*pb.ImportedSqlColumn) {
	f.t.Helper()
	identifier := ""
	for _, column := range columns {
		if column.GetName() == keyColumn {
			identifier = column.GetTextValue()
		}
	}
	stored := &pb.ImportedSqlRow{Table: table, Columns: columns}
	encoded, err := proto.Marshal(stored)
	if err != nil {
		f.t.Fatal(err)
	}
	key, err := proto.Marshal(&pb.ImportedSqlRow{Table: table, Columns: []*pb.ImportedSqlColumn{textColumn(keyColumn, identifier)}})
	if err != nil {
		f.t.Fatal(err)
	}
	sum := sha256.Sum256(key)
	if _, err = f.store.Apply(fixtureContext, "migration/"+importID+"/"+table+"/"+identifier, []storage.Change{{
		Key:     storage.Key{Kind: kind, ID: importID + "." + hex.EncodeToString(sum[:]), WorkspaceID: workspace},
		Payload: encoded,
	}}); err != nil {
		f.t.Fatal(err)
	}
}

// stageDomain seeds one of each record, which is what every adoption test
// starts from: a blocked node with an open question, an unread message, a
// delivery nobody could attribute, a handoff caught mid-dispatch, and the links
// the board's edges implied.
func (f *fixture) stageDomain() {
	f.t.Helper()
	f.stage(legacyStatus, "agent_status", "node_id", workspaceID, []*pb.ImportedSqlColumn{
		textColumn("node_id", nodeOne),
		textColumn("workspace_id", workspaceID),
		textColumn("agent_id", "claude"),
		textColumn("state", "blocked"),
		number("unread", 2),
		textColumn("session_id", "session-one"),
		number("verified", 1),
		number("restored", 0),
		textColumn("transcript_path", "/home/用户/.claude/projects/一.jsonl"),
		textColumn("last_event_at", "2026-09-01T10:00:00Z"),
		textColumn("session_phase", "turn"),
		// NULL, not zero: nobody has reported an error, which is a grey badge
		// rather than a green one.
		nullColumn("errored"),
		number("interrupted", 1),
		textColumn("updated_at", "2026-09-01T10:00:01Z"),
	})
	f.stage(legacyStatus, "agent_status", "node_id", workspaceID, []*pb.ImportedSqlColumn{
		textColumn("node_id", nodeTwo),
		textColumn("workspace_id", workspaceID),
		textColumn("agent_id", "codex"),
		textColumn("state", "idle"),
		number("unread", 0),
		number("verified", 0),
		number("restored", 0),
		textColumn("updated_at", "2026-09-01T10:00:02Z"),
	})
	f.stage(legacyApprovals, "agent_approvals", "id", workspaceID, []*pb.ImportedSqlColumn{
		textColumn("id", "approval-one"),
		textColumn("node_id", nodeOne),
		textColumn("workspace_id", workspaceID),
		textColumn("request_json", `{"tool":"Bash","command":"rm -rf 构建/"}`),
		nullColumn("answer"),
		nullColumn("answered_by"),
		textColumn("created_at", "2026-09-01T10:00:00Z"),
		nullColumn("answered_at"),
	})
	f.stage(legacyMailbox, "agent_mailbox", "id", workspaceID, []*pb.ImportedSqlColumn{
		textColumn("id", "message-one"),
		textColumn("workspace_id", workspaceID),
		textColumn("source_node_id", nodeTwo),
		textColumn("target_node_id", nodeOne),
		textColumn("message_key", "handoff/迁移"),
		textColumn("body", "接手 agent 域"),
		number("sequence", 1),
		number("created_at", 1788560520000),
		number("expires_at", 1788646920000),
		nullColumn("acknowledged_at"),
	})
	f.stage(legacyDeliveries, "agent_deliveries", "trace_id", workspaceID, []*pb.ImportedSqlColumn{
		textColumn("trace_id", "trace-one"),
		textColumn("workspace_id", workspaceID),
		textColumn("source_node_id", nodeTwo),
		textColumn("target_node_id", nodeOne),
		textColumn("outcome", "unknown"),
		textColumn("receipt", "pane:0"),
		number("body_chars", 12),
		textColumn("created_at", "2026-09-01T10:00:03Z"),
	})
	f.stage(legacyHandoffs, "agent_handoffs", "id", workspaceID, []*pb.ImportedSqlColumn{
		textColumn("id", "handoff-one"),
		textColumn("workspace_id", workspaceID),
		textColumn("source_node_id", nodeTwo),
		textColumn("target_node_id", nodeOne),
		textColumn("source_session_id", "session-two"),
		number("source_generation", 1),
		textColumn("target_session_id", "session-one"),
		number("target_generation", 1),
		textColumn("bundle_json", `{"summary":"迁移到 Host"}`),
		textColumn("bundle_digest", "sha256:x"),
		textColumn("state", "prepared"),
		textColumn("created_at", "2026-09-01T10:00:04Z"),
		textColumn("updated_at", "2026-09-01T10:00:05Z"),
	})
	// The outbox says it was already being dispatched. The merge has to prefer
	// that: a client reading only `agent_handoffs.state` would offer to send it
	// again.
	f.stage(legacyOutbox, "agent_handoff_outbox", "handoff_id", workspaceID, []*pb.ImportedSqlColumn{
		textColumn("handoff_id", "handoff-one"),
		textColumn("state", "dispatching"),
		number("attempts", 2),
		textColumn("created_at", "2026-09-01T10:00:04Z"),
	})
	f.stage(legacyLinks, "context_links", "node_id", workspaceID, []*pb.ImportedSqlColumn{
		textColumn("node_id", nodeOne),
		textColumn("workspace_id", workspaceID),
		textColumn("links_json", `[{"nodeId":"`+nodeTwo+`","direction":"incoming","kind":"agent"}]`),
		textColumn("updated_at", "2026-09-01T10:00:06Z"),
	})
}
