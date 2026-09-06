package sessionhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/ownership"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const (
	fixtureHost = "0123456789abcdef0123456789abcdef"
	importID    = "abcdef0123456789abcdef0123456789"
	workspaceID = "workspace-one"
	otherID     = "workspace-two"
)

var fixtureContext = context.Background()

// worker is a Runner that answers from a script rather than a process. It is
// what lets every decision this domain makes be exercised without a Rust binary
// — including the ones that only happen when a Worker refuses, restarts under a
// new instance, or stops answering entirely.
type worker struct {
	instance   string
	generation uint64
	// held is what this Worker claims to hold right now, by session id. A
	// session missing from it is one the Worker can see and does not have,
	// which is the difference between EXITED and LOST.
	held map[string]*pb.WorkerSessionState
	// failStart, failSignal and failReclaim make the Worker refuse, so the
	// paths that only run on a refusal are reachable.
	failStart, failSignal, failReclaim bool
	starts, signals, reclaims          int
	lastSignal                         *pb.SignalSessionRunRequest
}

func newWorker() *worker {
	return &worker{instance: "worker-a", generation: 1, held: map[string]*pb.WorkerSessionState{}}
}

func (w *worker) StartRun(_ context.Context, request *pb.StartSessionRunRequest) (*pb.WorkerSessionState, error) {
	w.starts++
	if w.failStart {
		return nil, context.DeadlineExceeded
	}
	state := &pb.WorkerSessionState{
		SessionId:        request.GetSessionId(),
		WorkspaceId:      request.GetWorkspaceId(),
		SessionKey:       request.GetSessionKey(),
		OwnerNodeId:      request.GetOwnerNodeId(),
		BackendKind:      "tmux",
		BackendRef:       "armadra-" + request.GetSessionKey() + ":0.0",
		Generation:       w.generation,
		WorkerInstanceId: w.instance,
		Kind:             request.GetKind(),
		Status:           pb.SessionStatus_SESSION_STATUS_RUNNING,
		AttachState:      pb.SessionAttachState_SESSION_ATTACH_STATE_DETACHED,
		Launch:           request.GetLaunch(),
	}
	w.held[request.GetSessionId()] = state
	return state, nil
}

func (w *worker) SignalRun(_ context.Context, request *pb.SignalSessionRunRequest) (*pb.WorkerSessionState, error) {
	w.signals++
	w.lastSignal = request
	if w.failSignal {
		return nil, context.DeadlineExceeded
	}
	state, ok := w.held[request.GetSessionId()]
	if !ok {
		return nil, ErrNotFound
	}
	// The execution host refuses a signal aimed at a generation it has already
	// replaced. This is the check the whole generation number exists for.
	if request.GetGeneration() != 0 && request.GetGeneration() != state.GetGeneration() {
		return nil, ErrStaleGeneration
	}
	switch request.GetMode() {
	case "recycle":
		w.generation++
		state.Generation = w.generation
		state.BackendRef = "armadra-" + state.GetSessionKey() + ":0.1"
		state.Status = pb.SessionStatus_SESSION_STATUS_RUNNING
		state.ExitCode = nil
	case "interrupt":
		// The foreground program stops; the shell survives, so nothing about
		// the session's own lifecycle changes.
	default:
		code := int32(0)
		state.Status = pb.SessionStatus_SESSION_STATUS_EXITED
		state.AttachState = pb.SessionAttachState_SESSION_ATTACH_STATE_EXITED
		state.ExitCode = &code
		delete(w.held, request.GetSessionId())
	}
	return state, nil
}

func (w *worker) ReclaimRuns(_ context.Context, _ []string) (*pb.WorkerSessionStates, error) {
	w.reclaims++
	if w.failReclaim {
		return nil, context.DeadlineExceeded
	}
	states := &pb.WorkerSessionStates{WorkerInstanceId: w.instance}
	for _, id := range sortedKeys(w.held) {
		states.Sessions = append(states.Sessions, w.held[id])
	}
	return states, nil
}

func (w *worker) CaptureRun(_ context.Context, request *pb.CaptureSessionRunRequest) (*pb.CapturedSessionRun, error) {
	return &pb.CapturedSessionRun{SessionId: request.GetSessionId(), Data: "屏幕"}, nil
}

func (w *worker) SuggestTitle(_ context.Context, request *pb.SuggestSessionTitleRequest) (*pb.SuggestSessionTitleResponse, error) {
	return &pb.SuggestSessionTitleResponse{Title: "标题 " + request.GetSessionId(), Source: "terminal"}, nil
}

func (w *worker) ContextUsage(_ context.Context, _ *pb.GetSessionContextUsageRequest) (*pb.GetSessionContextUsageResponse, error) {
	usage := []byte(`{"used":1200}`)
	sum := sha256.Sum256(usage)
	return &pb.GetSessionContextUsageResponse{Usage: usage, UsageSha256: sum[:], SchemaVersion: 1}, nil
}

// WorkerSessions is the handback read. It is on the same type so a test can
// hand one object to both the Runner and the SessionReader roles, exactly as
// the production Worker client does.
func (w *worker) WorkerSessions(ctx context.Context) (*pb.WorkerSessionStates, error) {
	return w.ReclaimRuns(ctx, nil)
}

type fixture struct {
	t        *testing.T
	store    *storage.Store
	service  *Service
	switches *ownership.Service
	worker   *worker
	// unreachable makes every attempt to open a channel fail, which is how the
	// LOST paths are reached.
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
	f := &fixture{t: t, store: store, worker: newWorker(), clock: time.UnixMilli(1788560523004)}
	service, err := New(Options{
		Store:  store,
		HostID: fixtureHost,
		Now:    func() time.Time { return f.clock },
		Open: func(context.Context, string) (Runner, func(), error) {
			if f.unreachable {
				return nil, nil, context.DeadlineExceeded
			}
			return f.worker, func() {}, nil
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

func textColumn(name, value string) *pb.ImportedSqlColumn {
	return &pb.ImportedSqlColumn{Name: name, Value: &pb.ImportedSqlColumn_TextValue{TextValue: value}}
}

func number(name string, value int64) *pb.ImportedSqlColumn {
	return &pb.ImportedSqlColumn{Name: name, Value: &pb.ImportedSqlColumn_IntegerValue{IntegerValue: value}}
}

type stagedRow struct {
	id, workspace, key, kind, node, agent, cwd, shell, command string
	status, backend, attach, intent, created, ended            string
	generation                                                 int64
}

// stageSession stores one `terminal_sessions` row exactly as `armadra-host
// import` does: an `ImportedSqlRow` under `legacy.terminal_sessions`, keyed by
// the import and the digest of its primary key.
func (f *fixture) stageSession(row stagedRow) {
	f.t.Helper()
	columns := []*pb.ImportedSqlColumn{
		textColumn("id", row.id),
		textColumn("workspace_id", row.workspace),
		textColumn("session_key", row.key),
		textColumn("kind", row.kind),
		textColumn("owner_node_id", row.node),
		textColumn("agent_id", row.agent),
		textColumn("cwd", row.cwd),
		textColumn("shell", row.shell),
		textColumn("command", row.command),
		textColumn("status", row.status),
		textColumn("backend_kind", row.backend),
		textColumn("attach_state", row.attach),
		textColumn("termination_intent", row.intent),
		number("generation", row.generation),
		textColumn("created_at", row.created),
	}
	if row.ended != "" {
		columns = append(columns, textColumn("ended_at", row.ended))
	}
	stored := &pb.ImportedSqlRow{Table: "terminal_sessions", Columns: columns}
	encoded, err := proto.Marshal(stored)
	if err != nil {
		f.t.Fatal(err)
	}
	key, err := proto.Marshal(&pb.ImportedSqlRow{Table: "terminal_sessions", Columns: []*pb.ImportedSqlColumn{textColumn("id", row.id)}})
	if err != nil {
		f.t.Fatal(err)
	}
	sum := sha256.Sum256(key)
	if _, err = f.store.Apply(fixtureContext, "migration/"+importID+"/"+row.id, []storage.Change{{
		Key:     storage.Key{Kind: legacySessions, ID: importID + "." + hex.EncodeToString(sum[:]), WorkspaceID: row.workspace},
		Payload: encoded,
	}}); err != nil {
		f.t.Fatal(err)
	}
}

// stageBoth seeds the two rows every adoption test starts from: a running agent
// session with a node, and a terminated plain terminal.
func (f *fixture) stageBoth() {
	f.t.Helper()
	f.stageSession(stagedRow{
		id: "session-agent", workspace: workspaceID, key: "node-one", kind: "agent",
		node: "node-one", agent: "claude", cwd: "/项目/一", shell: "/bin/zsh",
		status: "running", backend: "tmux", attach: "live", intent: "none",
		generation: 1, created: "2026-09-01T10:00:00Z",
	})
	f.stageSession(stagedRow{
		id: "session-plain", workspace: workspaceID, key: "session-plain", kind: "terminal",
		cwd: "/项目/一", shell: "/bin/zsh", status: "terminated", backend: "direct",
		attach: "exited", intent: "process", generation: 2,
		created: "2026-09-01T11:00:00Z", ended: "2026-09-01T12:00:00Z",
	})
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

// create records one session's intent through the service, which is the only
// way a session ever reaches the database.
func (f *fixture) create(sessionID, key, node string) *pb.Session {
	f.t.Helper()
	response, err := f.service.CreateSession(fixtureContext, f.caller(ScopeWrite, workspaceID), &pb.CreateSessionRequest{
		OperationId: "session/" + sessionID + "/create",
		Session: &pb.Session{
			SessionId:   sessionID,
			WorkspaceId: workspaceID,
			SessionKey:  key,
			OwnerNodeId: node,
			Kind:        pb.SessionKind_SESSION_KIND_TERMINAL,
			Launch:      &pb.SessionLaunch{Shell: "/bin/zsh", WorkingDirectory: "/项目/一"},
		},
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return response.GetSession()
}

func (f *fixture) session(sessionID string) storage.Session {
	f.t.Helper()
	session, err := f.service.Session(fixtureContext, sessionID)
	if err != nil {
		f.t.Fatal(err)
	}
	return session
}
