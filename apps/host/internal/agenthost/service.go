package agenthost

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
)

// Caller is the already-authenticated device. Nothing in a request supplies
// identity: the session does, and the scope in the request only selects which
// workspace is being asked about.
type Caller struct {
	PrincipalID string
	DeviceID    string
	DeviceEpoch uint64
	WorkspaceID string
	Scopes      []auth.Scope
}

// Executor is the channel to the execution host — the machine where the CLIs
// actually run.
//
// It is an interface rather than the Worker client so a test can exercise every
// decision this service makes without a Rust binary, and so a Host with no
// reachable Worker is a nameable state rather than a nil dereference.
//
// Nothing here decides anything. Each method is one thing put to the machine
// that runs the programs, and the answers are recorded rather than interpreted:
// a delivery outcome is the Worker's reading of its own input gate, and a
// drained event is what the Worker observed, not what this Host expected.
type Executor interface {
	// Agents reads the Worker's own agent rows — what a switch and a handback
	// are verified against.
	Agents(ctx context.Context) (*pb.WorkerAgentStates, error)
	// Drain pulls what has happened on the execution host since a cursor.
	Drain(ctx context.Context, after uint64, limit uint32) (*pb.DrainedAgentEvents, error)
	// DeliverApproval writes an answer into the file a CLI is blocked on.
	DeliverApproval(ctx context.Context, request *pb.DeliverApprovalAnswerRequest) (*pb.AgentDeliveryReceipt, error)
	// DeliverHandoff puts a prepared bundle in front of the target agent.
	DeliverHandoff(ctx context.Context, request *pb.DeliverHandoffRequest) (*pb.AgentDeliveryReceipt, error)
	// DeliverMessage puts one message in front of an agent.
	DeliverMessage(ctx context.Context, request *pb.DeliverMessageRequest) (*pb.AgentDeliveryReceipt, error)
	// Hooks installs or removes a CLI's Hook configuration on that machine.
	Hooks(ctx context.Context, agentID string, install bool) (*pb.HookInstallState, error)
}

// OpenExecutor produces a channel to the execution host for one exchange, or an
// error when none is reachable. It returns a closer because the production
// implementation starts a Worker: an agent command must not keep one alive
// between requests.
type OpenExecutor func(ctx context.Context, executionHostID string) (Executor, func(), error)

type Options struct {
	Store  *storage.Store
	HostID string
	// InstanceID identifies this Host process. It is stamped on a handoff claim
	// so an operator can tell "this Host is dispatching it" from "a Host that
	// is gone claimed it and never came back".
	InstanceID string
	// Open is nil on a Host with no execution channel. Reads still answer; the
	// methods that need a machine refuse with ErrNoWorker, which is a state a
	// client can draw rather than a failure it has to guess at.
	Open OpenExecutor
	// Now exists so the service, the switch state machine and their tests share
	// one clock.
	Now func() time.Time
}

type Service struct {
	store   *storage.Store
	options Options
}

func New(options Options) (*Service, error) {
	if options.Store == nil || len(options.HostID) != 32 {
		return nil, ErrInvalid
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Service{store: options.Store, options: options}, nil
}

func (s *Service) now() int64 { return s.options.Now().UnixMilli() }

func (c Caller) valid() bool {
	return c.PrincipalID != "" && c.DeviceID != "" && c.DeviceEpoch > 0 && validID(c.WorkspaceID) && len(c.Scopes) > 0
}

// authorize checks the verified session's own grants for this workspace and
// this Host. A request never widens them.
func (s *Service) authorize(caller Caller, permission string) error {
	if s == nil || !caller.valid() {
		return ErrAuthorization
	}
	if !auth.Permits(caller.Scopes, []auth.Scope{{Permission: permission, WorkspaceID: caller.WorkspaceID, ExecutionHostID: s.options.HostID}}) {
		return ErrAuthorization
	}
	return nil
}

// Owned reports whether this Host is the settled writer of the agent domain.
// It is exported because the proxy asks it before it narrows a forwarded agent
// request against this Host's records: while the Runtime still owns the domain
// the Runtime's rows are the record, and this Host must not narrow against a
// projection it has not been handed.
func (s *Service) Owned(ctx context.Context) (bool, error) {
	if s == nil {
		return false, nil
	}
	record, err := s.store.Ownership(ctx, Domain)
	if errors.Is(err, storage.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return record.Owner == storage.OwnerHost && record.Phase == storage.OwnershipSettled, nil
}

// authorizeWrite additionally refuses when this Host is not the settled owner.
// There is no dual-write mode, and a switch in progress is a refusal on both
// sides rather than a race between them.
func (s *Service) authorizeWrite(ctx context.Context, caller Caller) error {
	if err := s.authorize(caller, ScopeWrite); err != nil {
		return err
	}
	owned, err := s.Owned(ctx)
	if err != nil {
		return err
	}
	if !owned {
		return ErrOwnershipMoved
	}
	return nil
}

// note reports a failure that must not become the caller's. It is the one
// place a swallowed error is written down, so "the board looked stale" is
// something an operator can find a reason for.
func (s *Service) note(what string, err error) {
	if err == nil || errors.Is(err, ErrNoWorker) {
		// An unreachable machine is an ordinary state on a Host whose Runtime
		// is not running, and saying so on every listing would be noise.
		return
	}
	fmt.Fprintln(os.Stderr, "Armadra:", what, "failed:", err)
}

func (s *Service) open(ctx context.Context, executionHostID string) (Executor, func(), error) {
	if s.options.Open == nil {
		return nil, nil, ErrNoWorker
	}
	executor, done, err := s.options.Open(ctx, executionHostID)
	if err != nil {
		return nil, nil, errors.Join(ErrNoWorker, err)
	}
	if done == nil {
		done = func() {}
	}
	return executor, done, nil
}

/* ------------------------------------------------------------------- reads */

// ListStatus answers the caller's own workspace only. A device granted one
// workspace must not learn which agents are running in another.
//
// It drains first, and that is where the pull of §2.7 actually happens. The
// execution host has no way to push — the process a Hook reaches binds no
// upward channel — so somebody has to ask, and the moment a client wants to
// draw the board is exactly the moment the answer matters. A drain that fails
// is ignored rather than propagated: the records still answer, and a Host that
// refused to list agents because a machine was briefly unreachable would blank
// a board over a dropped request.
func (s *Service) ListStatus(ctx context.Context, caller Caller, request *pb.ListAgentStatusRequest) (*pb.ListAgentStatusResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	if _, err := s.Drain(ctx, ""); err != nil {
		s.note("agent drain", err)
	}
	after := request.GetAfterNodeId()
	if after != "" && !validID(after) {
		return nil, ErrInvalid
	}
	page, more, err := s.store.ListAgentStatus(ctx, caller.WorkspaceID, after, pageSize(request.GetLimit()))
	if err != nil {
		return nil, err
	}
	result := &pb.ListAgentStatusResponse{HasMore: more}
	for _, status := range page {
		result.NextNodeId = status.NodeID
		result.Statuses = append(result.Statuses, statusMessage(status))
	}
	return result, nil
}

// Status reads one node's record. A withdrawn one answers ErrNotFound: the
// tombstone is a CAS token for whoever records the next one, not a status to
// show.
func (s *Service) Status(ctx context.Context, nodeID string) (storage.AgentStatus, error) {
	if !validID(nodeID) {
		return storage.AgentStatus{}, ErrInvalid
	}
	status, err := s.store.GetAgentStatus(ctx, nodeID)
	if errors.Is(err, storage.ErrNotFound) {
		return storage.AgentStatus{}, ErrNotFound
	}
	if err != nil {
		return storage.AgentStatus{}, err
	}
	if status.Deleted {
		return storage.AgentStatus{}, ErrNotFound
	}
	return status, nil
}

// requireNode resolves a node the caller may act on in their own workspace.
//
// A node that has never reported has no status, and that is an ordinary state
// rather than a missing node: a terminal somebody just dropped on a board is a
// legitimate handoff target and a legitimate inbox. So the canvas' own record
// is the fallback, and only a node that is on nobody's board at all is refused.
func (s *Service) requireNode(ctx context.Context, caller Caller, nodeID string) (storage.AgentStatus, error) {
	status, err := s.Status(ctx, nodeID)
	switch {
	case err == nil:
		if status.WorkspaceID != caller.WorkspaceID {
			return storage.AgentStatus{}, ErrAuthorization
		}
		return status, nil
	case errors.Is(err, ErrNotFound):
	default:
		return storage.AgentStatus{}, err
	}
	if !validID(nodeID) {
		return storage.AgentStatus{}, ErrInvalid
	}
	// The canvas stores a node under `<canvas>/<node>`, so this is a scan of
	// the workspace's nodes rather than a lookup. It is the same read the
	// context-link projection makes, at board scale, and it runs only when the
	// node has no status — which is once per node, ever.
	kinds, err := s.nodeTypes(ctx, caller.WorkspaceID)
	if err != nil {
		return storage.AgentStatus{}, err
	}
	if _, known := kinds[nodeID]; !known {
		return storage.AgentStatus{}, ErrNotFound
	}
	return storage.AgentStatus{NodeID: nodeID, WorkspaceID: caller.WorkspaceID}, nil
}

/* ------------------------------------------------------------------ writes */

// putStatus is the one write path for a node's status: CAS, publish, read back
// what was stored.
func (s *Service) putStatus(ctx context.Context, operationID string, status storage.AgentStatus, expected uint64) (*pb.AgentStatus, *pb.CanvasOperationReceipt, error) {
	result, err := s.store.PutAgentStatus(ctx, operationID, status, expected)
	if err != nil {
		return nil, nil, err
	}
	stored, err := s.store.GetAgentStatus(ctx, status.NodeID)
	if err != nil {
		return nil, nil, err
	}
	return statusMessage(stored), receipt(result), nil
}

// MarkRead clears a node's unread badge.
//
// It is a CAS'd write rather than a fire-and-forget signal because two clients
// clearing one badge are two decisions about one record, and the second one has
// to learn it lost — otherwise a badge cleared on a phone reappears when a
// laptop's stale write lands.
func (s *Service) MarkRead(ctx context.Context, caller Caller, request *pb.MarkAgentReadRequest) (*pb.MarkAgentReadResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	status, err := s.requireNode(ctx, caller, request.GetNodeId())
	if err != nil {
		return nil, err
	}
	status.Unread = 0
	status.UpdatedAtMS = s.now()
	if status, err = stampStatus(status); err != nil {
		return nil, err
	}
	value, stored, err := s.putStatus(ctx, request.GetOperationId(), status, request.GetExpectedRevision())
	if err != nil {
		return nil, err
	}
	return &pb.MarkAgentReadResponse{Status: value, Receipt: stored}, nil
}

/* -------------------------------------------------------------------- hooks */

// InstallHooks and UninstallHooks are execution, forwarded unchanged.
//
// Installing a Hook edits a CLI's own configuration file on the execution host.
// This Host resolves who is asking and whether they may, and forwards; it never
// writes the file, because the file is that machine's and the CLI's version is
// that machine's, and a Host that wrote it would be writing into a
// configuration it cannot read back.

func (s *Service) InstallHooks(ctx context.Context, caller Caller, request *pb.InstallHooksRequest) (*pb.InstallHooksResponse, error) {
	state, err := s.hooks(ctx, caller, request.GetAgentId(), true)
	if err != nil {
		return nil, err
	}
	return &pb.InstallHooksResponse{State: state}, nil
}

func (s *Service) UninstallHooks(ctx context.Context, caller Caller, request *pb.UninstallHooksRequest) (*pb.UninstallHooksResponse, error) {
	state, err := s.hooks(ctx, caller, request.GetAgentId(), false)
	if err != nil {
		return nil, err
	}
	return &pb.UninstallHooksResponse{State: state}, nil
}

func (s *Service) hooks(ctx context.Context, caller Caller, agentID string, install bool) (*pb.HookInstallState, error) {
	// Installing a Hook makes a CLI on this machine call back into the Runtime.
	// That is execution, and it is checked as execution even though this Host
	// stores nothing about it — the ownership of the domain is beside the
	// point, because the file is on the machine either way.
	if err := s.authorize(caller, ScopeWrite); err != nil {
		return nil, err
	}
	if !validID(agentID) {
		return nil, ErrInvalid
	}
	executor, done, err := s.open(ctx, "")
	if err != nil {
		return nil, err
	}
	defer done()
	return executor.Hooks(ctx, agentID, install)
}
