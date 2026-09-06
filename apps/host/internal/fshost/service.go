package fshost

import (
	"context"
	"errors"
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

type Options struct {
	Store  *storage.Store
	HostID string
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
// this Host. A request never widens them, and a host-wide grant is never
// inferred from a workspace-scoped one.
func (s *Service) authorize(caller Caller, permission string) error {
	if s == nil || !caller.valid() {
		return ErrAuthorization
	}
	if !auth.Permits(caller.Scopes, []auth.Scope{{Permission: permission, WorkspaceID: caller.WorkspaceID, ExecutionHostID: s.options.HostID}}) {
		return ErrAuthorization
	}
	return nil
}

// Owned reports whether this Host is the settled writer of the filesystem
// domain. It is exported because the proxy asks it on every forwarded file
// request: while the Runtime still owns the domain, the Runtime's own row is
// the permission record and this Host must not narrow against a projection it
// has not been handed yet.
func (s *Service) Owned(ctx context.Context) (bool, error) {
	if s == nil {
		return false, nil
	}
	record, err := s.store.Ownership(ctx, Domain)
	if errors.Is(err, storage.ErrNotFound) {
		// No switch has ever been recorded, so the Runtime owns writes.
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

func pageSize(limit uint32) int {
	if limit == 0 {
		return 100
	}
	if limit > MaxPage {
		return MaxPage
	}
	return int(limit)
}

// Root reads one workspace's registration. It is the read the proxy and the
// editor both make, and it answers tombstones as `ErrNotRegistered` rather than
// as a root with everything cleared.
func (s *Service) Root(ctx context.Context, workspaceID string) (storage.WorkspaceRoot, error) {
	if !validID(workspaceID) {
		return storage.WorkspaceRoot{}, ErrInvalid
	}
	root, err := s.store.GetWorkspaceRoot(ctx, workspaceID)
	if errors.Is(err, storage.ErrNotFound) {
		return storage.WorkspaceRoot{}, ErrNotRegistered
	}
	if err != nil {
		return storage.WorkspaceRoot{}, err
	}
	if root.Deleted {
		return storage.WorkspaceRoot{}, ErrNotRegistered
	}
	return root, nil
}

// GetRoot is the authenticated read.
func (s *Service) GetRoot(ctx context.Context, caller Caller, workspaceID string) (*pb.GetWorkspaceRootResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	if workspaceID == "" {
		workspaceID = caller.WorkspaceID
	}
	// A device asks about the workspace its session is scoped to. Reading
	// another one's root would say where somebody else's project is.
	if workspaceID != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	root, err := s.Root(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	return &pb.GetWorkspaceRootResponse{Root: message(root)}, nil
}

// ListRoots answers with the caller's own workspace only. The surface is
// workspace-scoped end to end: a device granted one workspace must not learn
// that other workspaces exist, let alone where their files are.
func (s *Service) ListRoots(ctx context.Context, caller Caller, after string, limit uint32) (*pb.ListWorkspaceRootsResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	if after != "" && !validID(after) {
		return nil, ErrInvalid
	}
	result := &pb.ListWorkspaceRootsResponse{}
	if after >= caller.WorkspaceID {
		return result, nil
	}
	root, err := s.Root(ctx, caller.WorkspaceID)
	if errors.Is(err, ErrNotRegistered) {
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	result.Roots = append(result.Roots, message(root))
	result.NextWorkspaceId = root.WorkspaceID
	return result, nil
}

// put is the one write path: validate, CAS, publish, answer with what was
// stored. Every mutation below reduces to it, so there is one place where a
// registration reaches the database.
func (s *Service) put(ctx context.Context, operationID string, root storage.WorkspaceRoot, expected uint64) (*pb.WorkspaceRoot, *pb.CanvasOperationReceipt, error) {
	result, err := s.store.PutWorkspaceRoot(ctx, operationID, root, expected)
	if err != nil {
		return nil, nil, err
	}
	stored, err := s.store.GetWorkspaceRoot(ctx, root.WorkspaceID)
	if err != nil {
		return nil, nil, err
	}
	return message(stored), receipt(result), nil
}

// RegisterRoot freezes where a workspace's files are.
//
// The path is not resolved here. For a remote workspace it names a directory on
// another machine, and for a local one the Worker has already canonicalized it;
// what this Host does is record the answer and refuse to record a second,
// different one under a revision that described the first.
func (s *Service) RegisterRoot(ctx context.Context, caller Caller, request *pb.RegisterWorkspaceRootRequest) (*pb.RegisterWorkspaceRootResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	if request.GetRoot().GetWorkspaceId() != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	now := s.now()
	root, err := record(request.GetRoot(), now, now)
	if err != nil {
		return nil, err
	}
	value, receipt, err := s.put(ctx, request.GetOperationId(), root, request.GetExpectedRevision())
	if err != nil {
		return nil, err
	}
	return &pb.RegisterWorkspaceRootResponse{Root: value, Receipt: receipt}, nil
}

// UpdateRoot changes what is allowed, never where the files are. A workspace
// whose files moved is a new registration: everything it holds is addressed
// relative to the path that was frozen, so quietly repointing the root would
// change what every stored path means.
func (s *Service) UpdateRoot(ctx context.Context, caller Caller, request *pb.UpdateWorkspaceRootRequest) (*pb.UpdateWorkspaceRootResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	if request.GetWorkspaceId() != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	if request.GetPermissions() == nil {
		return nil, ErrInvalid
	}
	current, err := s.Root(ctx, request.GetWorkspaceId())
	if err != nil {
		return nil, err
	}
	next := current
	next.Read = request.GetPermissions().GetRead()
	next.Write = request.GetPermissions().GetWrite()
	next.Execute = request.GetPermissions().GetExecute()
	next.UpdatedAtMS = s.now()
	next.Payload, err = payload(message(next))
	if err != nil {
		return nil, err
	}
	value, receipt, err := s.put(ctx, request.GetOperationId(), next, request.GetExpectedRevision())
	if err != nil {
		return nil, err
	}
	return &pb.UpdateWorkspaceRootResponse{Root: value, Receipt: receipt}, nil
}

// UnregisterRoot withdraws the registration. Nothing under the directory is
// read, moved or deleted: this removes the entry that says the workspace has a
// root, exactly as removing a workspace from the list does not remove the
// project.
func (s *Service) UnregisterRoot(ctx context.Context, caller Caller, request *pb.UnregisterWorkspaceRootRequest) (*pb.UnregisterWorkspaceRootResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	if request.GetWorkspaceId() != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	current, err := s.Root(ctx, request.GetWorkspaceId())
	if err != nil {
		return nil, err
	}
	_, receipt, err := s.put(ctx, request.GetOperationId(), storage.WorkspaceRoot{
		WorkspaceID:    current.WorkspaceID,
		Deleted:        true,
		RegisteredAtMS: current.RegisteredAtMS,
		UpdatedAtMS:    s.now(),
	}, request.GetExpectedRevision())
	if err != nil {
		return nil, err
	}
	return &pb.UnregisterWorkspaceRootResponse{WorkspaceId: current.WorkspaceID, Receipt: receipt}, nil
}
