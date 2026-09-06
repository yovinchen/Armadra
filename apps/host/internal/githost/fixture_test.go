package githost

import (
	"context"
	"errors"
	"fmt"
	"sync"
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
	workspaceID = "workspace-git"
	mainPath    = "/home/用户/项目/armadra"
	linkedPath  = "/home/用户/项目/armadra-功能"
	repositoryA = "3b1f0a2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8"
	repositoryB = "aaaa0a2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8"
)

var fixtureContext = context.Background()

// roots is the filesystem domain, reduced to the one question this domain asks
// it: where are this workspace's files, and may this device make the machine
// run something in them.
type roots struct {
	path    string
	execute bool
	err     error
}

func (r *roots) Root(context.Context, string) (storage.WorkspaceRoot, error) {
	if r.err != nil {
		return storage.WorkspaceRoot{}, r.err
	}
	return storage.WorkspaceRoot{WorkspaceID: workspaceID, CanonicalPath: r.path, Read: true, Write: true, Execute: r.execute}, nil
}

// executor stands in for the execution host. It records what it was asked in
// the order it was asked, which is how the serialization tests read the queue's
// decisions back, and it can be told to block so two operations can be observed
// overlapping -- or proved not to.
type executor struct {
	mu sync.Mutex
	// started and finished are the two halves of every run, so a test can tell
	// "these overlapped" from "these were merely both attempted".
	started  []string
	finished []string
	// gate blocks inside a run when set for that operation id.
	gate map[string]chan struct{}
	// outcome overrides the state one operation finishes in.
	outcome map[string]pb.GitOperationState
	// runErr makes the channel itself fail, which is the case that has to
	// produce an unknown outcome rather than a failure.
	runErr map[string]error
	// head is what ObserveRepository reports.
	head      string
	observed  int
	snapshot  *pb.GitDomainSnapshot
	readReply *pb.GitReadResult
	readCalls []*pb.GitRead
	cancelled []string
}

func newExecutor() *executor {
	return &executor{
		gate:      map[string]chan struct{}{},
		outcome:   map[string]pb.GitOperationState{},
		runErr:    map[string]error{},
		head:      "1f2e3d4c5b6a798807162534435261708f9e0d1c",
		snapshot:  &pb.GitDomainSnapshot{},
		readReply: &pb.GitReadResult{HttpStatus: 200, ResponseJson: []byte(`{"ok":true}`)},
	}
}

func (e *executor) RunGitOperation(ctx context.Context, operation *pb.GitOperation, root string) (*pb.GitOperation, error) {
	id := operation.GetOperationId()
	e.mu.Lock()
	e.started = append(e.started, id)
	gate := e.gate[id]
	failure := e.runErr[id]
	state, hasState := e.outcome[id]
	e.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	e.mu.Lock()
	e.finished = append(e.finished, id)
	e.mu.Unlock()
	if failure != nil {
		return nil, failure
	}
	if !hasState {
		state = pb.GitOperationState_GIT_OPERATION_STATE_SUCCEEDED
	}
	return &pb.GitOperation{OperationId: id, State: state, Progress: 100, Affected: []string{"源码/主.rs"}}, nil
}

func (e *executor) CancelGitOperation(_ context.Context, operationID, _, _ string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cancelled = append(e.cancelled, operationID)
	return nil
}

func (e *executor) ObserveRepository(_ context.Context, scope *pb.RepositoryScope, _ string) (*pb.RepositoryState, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.observed++
	return &pb.RepositoryState{Scope: proto.Clone(scope).(*pb.RepositoryScope), HeadOid: e.head, Branch: "main", ObservedAtUnixMs: 1788560523004}, nil
}

func (e *executor) ReadGit(_ context.Context, read *pb.GitRead) (*pb.GitReadResult, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.readCalls = append(e.readCalls, proto.Clone(read).(*pb.GitRead))
	return e.readReply, nil
}

func (e *executor) GitSnapshot(context.Context) (*pb.GitDomainSnapshot, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.snapshot, nil
}

func (e *executor) open(id string) chan struct{} {
	gate := make(chan struct{})
	e.mu.Lock()
	e.gate[id] = gate
	e.mu.Unlock()
	return gate
}

func (e *executor) order() ([]string, []string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.started...), append([]string(nil), e.finished...)
}

type fixture struct {
	t        *testing.T
	store    *storage.Store
	service  *Service
	executor *executor
	roots    *roots
	switches *ownership.Service
	clock    time.Time
	minted   int
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	store, err := storage.Open(t.TempDir(), fixtureHost)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	f := &fixture{
		t:        t,
		store:    store,
		executor: newExecutor(),
		roots:    &roots{path: "/home/用户/项目", execute: true},
		clock:    time.UnixMilli(1788560523004),
	}
	// Identifiers are minted in order so a test can name the entry it queued
	// and read the queue's own ordering back.
	f.service, err = New(Options{
		Store:    store,
		HostID:   fixtureHost,
		Roots:    f.roots,
		Executor: f.executor,
		Now:      func() time.Time { return f.clock },
		NewID: func() string {
			f.minted++
			return fmt.Sprintf("%016x-operation", f.minted)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.switches, err = ownership.New(ownership.Options{
		Store:      store,
		InstanceID: fixtureHost,
		Projectors: map[string]ownership.Projector{Domain: f.service.AsProjector()},
		Now:        func() time.Time { return f.clock },
	})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// own records this Host as the settled writer, which is what every write is
// gated on.
func (f *fixture) own() {
	f.t.Helper()
	_, err := f.store.PutOwnership(fixtureContext, storage.Ownership{
		Domain:      Domain,
		Owner:       storage.OwnerHost,
		Epoch:       2,
		Phase:       storage.OwnershipSettled,
		ReasonCode:  "ownership.switch.verified",
		CreatedAtMS: f.clock.UnixMilli(),
		UpdatedAtMS: f.clock.UnixMilli(),
	}, 0)
	if err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) caller(permissions ...string) Caller {
	scopes := make([]auth.Scope, 0, len(permissions))
	for _, permission := range permissions {
		scopes = append(scopes, auth.Scope{Permission: permission, WorkspaceID: workspaceID, ExecutionHostID: fixtureHost})
	}
	return Caller{PrincipalID: "principal", DeviceID: "device", DeviceEpoch: 1, WorkspaceID: workspaceID, Scopes: scopes}
}

func (f *fixture) writer() Caller { return f.caller(ScopeRead, ScopeWrite, ScopeExecute) }

func scopeAt(path, repository string) *pb.RepositoryScope {
	return &pb.RepositoryScope{WorkspaceId: workspaceID, RepositoryId: repository, RepositoryPath: path}
}

// enqueue queues one operation with a well-formed body and digest.
func (f *fixture) enqueue(kind pb.GitActionKind, scope *pb.RepositoryScope, operationID string) *pb.GitOperation {
	f.t.Helper()
	action := []byte(fmt.Sprintf(`{"kind":%q}`, kind.String()))
	response, err := f.service.Enqueue(fixtureContext, f.writer(), &pb.EnqueueGitOperationRequest{
		Meta:         &pb.CommandMeta{RequestId: operationID, Scope: &pb.Scope{WorkspaceId: workspaceID}},
		OperationId:  operationID,
		Scope:        scope,
		Action:       action,
		ActionSha256: digest(action),
		Kind:         kind,
	})
	if err != nil {
		f.t.Fatalf("enqueue %s: %v", operationID, err)
	}
	return response.GetOperation()
}

// settled waits for one operation to reach a final state. The queue runs in its
// own goroutines, so a test that read the row once would be reading a race
// rather than a result.
func (f *fixture) settled(id string) *pb.GitOperation {
	f.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		operation, err := f.service.operation(fixtureContext, workspaceID, id)
		if err != nil && !errors.Is(err, ErrNotFound) {
			f.t.Fatal(err)
		}
		if err == nil && terminal(operation.GetState()) {
			return operation
		}
		if time.Now().After(deadline) {
			f.t.Fatalf("operation %s never settled (state %v)", id, operation.GetState())
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// read is one entry as the store currently holds it.
func (f *fixture) read(id string) *pb.GitOperation {
	f.t.Helper()
	operation, err := f.service.operation(fixtureContext, workspaceID, id)
	if err != nil {
		f.t.Fatal(err)
	}
	return operation
}

// awaitState waits for one entry to reach a state. The queue runs in its own
// goroutines, so a test that read the row once would be reading a race.
func (f *fixture) awaitState(id string, state pb.GitOperationState) *pb.GitOperation {
	f.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		operation, err := f.service.operation(fixtureContext, workspaceID, id)
		if err != nil && !errors.Is(err, ErrNotFound) {
			f.t.Fatal(err)
		}
		if err == nil && operation.GetState() == state {
			return operation
		}
		if time.Now().After(deadline) {
			f.t.Fatalf("operation %s never reached %v (state %v)", id, state, operation.GetState())
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// quiet waits for the queue to have nothing pending or running.
func (f *fixture) quiet() {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(fixtureContext, 5*time.Second)
	defer cancel()
	if !f.service.queue.quiet(ctx) {
		f.t.Fatal("the queue never drained")
	}
}
