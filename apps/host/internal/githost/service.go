package githost

import (
	"context"
	"errors"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// Caller is the already-authenticated device. Nothing in a request supplies
// identity: the session does, and the scope in the request only selects which
// repository is being addressed.
type Caller struct {
	PrincipalID string
	DeviceID    string
	DeviceEpoch uint64
	WorkspaceID string
	Scopes      []auth.Scope
}

func (c Caller) valid() bool {
	return c.PrincipalID != "" && c.DeviceID != "" && c.DeviceEpoch > 0 && validID(c.WorkspaceID) && len(c.Scopes) > 0
}

// Executor is the execution host, seen as narrowly as this domain needs it.
//
// It is deliberately smaller than the Worker client that implements it, so a
// test supplies four functions rather than a process, and so a link that cannot
// carry a git frame fails a type assertion instead of a request that has
// already changed something.
//
// Every method runs on the execution host. None of them decides anything: the
// order was decided here, the preconditions were stated here, and what comes
// back is a reading of what happened rather than an echo of what was asked.
type Executor interface {
	// RunGitOperation runs one queued operation to completion and answers with
	// the Worker's own reading of the outcome.
	RunGitOperation(ctx context.Context, operation *pb.GitOperation, workspaceRoot string) (*pb.GitOperation, error)
	// CancelGitOperation asks the execution host to stop. It is a request, not
	// a result: a cancelled push may still have reached the remote.
	CancelGitOperation(ctx context.Context, operationID, workspaceRoot, repositoryPath string) error
	// ObserveRepository reads one checkout's current state.
	ObserveRepository(ctx context.Context, scope *pb.RepositoryScope, workspaceRoot string) (*pb.RepositoryState, error)
	// ReadGit forwards one read and returns the status the Runtime's own route
	// would have returned.
	ReadGit(ctx context.Context, read *pb.GitRead) (*pb.GitReadResult, error)
	// GitSnapshot reports what the execution host still holds for this domain.
	GitSnapshot(ctx context.Context) (*pb.GitDomainSnapshot, error)
}

// Roots resolves where a workspace's files are. It is the filesystem domain's
// record, read rather than re-derived: git is the last domain to move, so by
// the time this Host owns it the registration is already the Host's, and a root
// that arrived inside a git request would be the caller choosing which
// directory it is allowed to run commands in.
type Roots interface {
	Root(ctx context.Context, workspaceID string) (storage.WorkspaceRoot, error)
}

type Options struct {
	Store  *storage.Store
	HostID string
	// Roots is the filesystem domain. Nil means this Host cannot resolve a
	// workspace root, and every git request that needs one is refused rather
	// than run against a directory nobody registered.
	Roots Roots
	// Executor is the execution host. Nil is a Host that can answer reads of
	// its own records and refuses to accept a write it could never run.
	Executor Executor
	// Now exists so the service, the switch state machine and their tests share
	// one clock.
	Now func() time.Time
	// NewID mints operation and job identifiers. Tests replace it so a queue's
	// ordering is readable.
	NewID func() string
}

type Service struct {
	store    *storage.Store
	options  Options
	queue    *queue
	executor Executor
}

func New(options Options) (*Service, error) {
	if options.Store == nil || len(options.HostID) != 32 {
		return nil, ErrInvalid
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.NewID == nil {
		options.NewID = newOperationID
	}
	service := &Service{store: options.Store, options: options, executor: options.Executor}
	service.queue = newQueue(service)
	return service, nil
}

func (s *Service) now() int64 { return s.options.Now().UnixMilli() }

// authorize checks the verified session's own grants for this workspace and
// this Host. A request never widens them.
func (s *Service) authorize(caller Caller, permissions ...string) error {
	if s == nil || !caller.valid() {
		return ErrAuthorization
	}
	required := make([]auth.Scope, 0, len(permissions))
	for _, permission := range permissions {
		required = append(required, auth.Scope{Permission: permission, WorkspaceID: caller.WorkspaceID, ExecutionHostID: s.options.HostID})
	}
	if !auth.Permits(caller.Scopes, required) {
		return ErrAuthorization
	}
	return nil
}

// Owned reports whether this Host is the settled writer of the git domain.
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
	if err := s.authorize(caller, ScopeWrite, ScopeExecute); err != nil {
		return err
	}
	owned, err := s.Owned(ctx)
	if err != nil {
		return err
	}
	if !owned {
		return ErrOwnershipMoved
	}
	if s.executor == nil {
		return ErrUnsupported
	}
	return nil
}

// workspaceRoot is where this workspace's files are, according to the
// filesystem domain.
func (s *Service) workspaceRoot(ctx context.Context, workspaceID string) (string, error) {
	if s.options.Roots == nil {
		return "", ErrUnsupported
	}
	root, err := s.options.Roots.Root(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	if !root.Execute {
		// Running a Git command is execution. A workspace whose registration
		// withholds it is not one this device may make the machine act on,
		// whatever its own grants say.
		return "", ErrAuthorization
	}
	return root.CanonicalPath, nil
}

func pageSize(limit uint32) int {
	if limit == 0 || limit > MaxPage {
		return MaxPage
	}
	return int(limit)
}

/* -------------------------------- operations ------------------------------- */

// operationKey addresses one queue entry. Operations are per workspace, so a
// device granted one workspace never learns that another one has a repository.
func (s *Service) operationKey(workspaceID, operationID string) storage.Key {
	return storage.Key{Kind: OperationKind, ID: operationID, WorkspaceID: workspaceID}
}

// operation reads one entry, tombstones excluded.
func (s *Service) operation(ctx context.Context, workspaceID, operationID string) (*pb.GitOperation, error) {
	if !validID(operationID) {
		return nil, ErrInvalid
	}
	entity, err := s.store.Read(ctx, s.operationKey(workspaceID, operationID))
	if errors.Is(err, storage.ErrNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if entity.Deleted {
		return nil, ErrNotFound
	}
	return decodeOperation(entity)
}

// operations reads one workspace's queue, oldest first. The identifiers are
// time-ordered, so the entity table's own ordering is the queue's.
func (s *Service) operations(ctx context.Context, workspaceID string) ([]*pb.GitOperation, error) {
	result := []*pb.GitOperation{}
	after := ""
	for {
		page, err := s.store.List(ctx, storage.ListOptions{WorkspaceID: workspaceID, Kind: OperationKind, AfterID: after, Limit: MaxPage})
		if err != nil {
			return nil, err
		}
		for _, entity := range page.Entities {
			operation, err := decodeOperation(entity)
			if err != nil {
				return nil, err
			}
			result = append(result, operation)
		}
		if !page.HasMore {
			return result, nil
		}
		after = page.NextID
	}
}

// put stores one entry under revision CAS and publishes it.
func (s *Service) put(ctx context.Context, operationID string, workspaceID string, operation *pb.GitOperation, expected uint64) (*pb.GitOperation, storage.ApplyResult, error) {
	encoded, err := operationPayload(operation)
	if err != nil {
		return nil, storage.ApplyResult{}, err
	}
	result, err := s.store.Apply(ctx, operationID, []storage.Change{{
		Key:              s.operationKey(workspaceID, operation.GetOperationId()),
		ExpectedRevision: expected,
		Payload:          encoded,
	}})
	if err != nil {
		return nil, storage.ApplyResult{}, err
	}
	stored, err := s.operation(ctx, workspaceID, operation.GetOperationId())
	if err != nil {
		return nil, storage.ApplyResult{}, err
	}
	return stored, result, nil
}

// Enqueue is the only write entry (§2.8).
//
// It records the decision, checks the queue's own limits, and hands the entry
// to the scheduler. It does not run anything: by the time this returns the
// operation exists and is QUEUED, which is precisely the record a Host restart
// needs in order to be able to say what was attempted.
func (s *Service) Enqueue(ctx context.Context, caller Caller, request *pb.EnqueueGitOperationRequest) (*pb.EnqueueGitOperationResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	if err := validScope(request.GetScope(), caller.WorkspaceID); err != nil {
		return nil, err
	}
	if !knownKind(request.GetKind()) {
		return nil, ErrInvalid
	}
	action := request.GetAction()
	if len(action) == 0 || len(action) > MaxActionBytes {
		return nil, ErrInvalid
	}
	// The body and its digest travel together, and the digest is checked here
	// rather than only at the Worker: a rewritten body must be refused before
	// it is recorded as an authorized decision.
	if len(request.GetActionSha256()) != 32 || string(digest(action)) != string(request.GetActionSha256()) {
		return nil, ErrInvalid
	}
	if err := validExpectation(request.GetExpected()); err != nil {
		return nil, err
	}
	root, err := s.workspaceRoot(ctx, caller.WorkspaceID)
	if err != nil {
		return nil, err
	}
	// The checkout has to be under the root this workspace registered. The
	// execution host refuses the same path, and it is the one that can resolve
	// a symlink — but a write aimed at an unrelated directory should not cost a
	// process start to be told no, and a Frame whose binding drifted out of the
	// project needs a reason it can repair rather than a generic failure.
	if !insideRoot(root, request.GetScope().GetRepositoryPath()) {
		return nil, ErrOutsideRoot
	}
	// A retry is answered before an identifier is minted. The entry's own id is
	// generated here rather than taken from the request, so re-deriving it on a
	// second attempt would produce a different entity and the idempotency
	// digest would call the retry a different request -- which is exactly the
	// case idempotency exists to make harmless.
	if replay, found, err := s.replay(ctx, caller.WorkspaceID, request.GetOperationId()); err != nil {
		return nil, err
	} else if found {
		return replay, nil
	}
	existing, err := s.operations(ctx, caller.WorkspaceID)
	if err != nil {
		return nil, err
	}
	active := 0
	for _, operation := range existing {
		if !terminal(operation.GetState()) {
			active++
		}
	}
	if active >= MaxActive {
		return nil, ErrBusy
	}
	now := s.now()
	operation := &pb.GitOperation{
		OperationId:     s.options.NewID(),
		Scope:           proto.Clone(request.GetScope()).(*pb.RepositoryScope),
		Action:          append([]byte(nil), action...),
		ActionSha256:    append([]byte(nil), request.GetActionSha256()...),
		Expected:        proto.Clone(request.GetExpected()).(*pb.GitExpectation),
		Kind:            request.GetKind(),
		State:           pb.GitOperationState_GIT_OPERATION_STATE_QUEUED,
		CreatedAtUnixMs: now,
	}
	if operation.GetExpected() == nil {
		operation.Expected = &pb.GitExpectation{}
	}
	stored, result, err := s.put(ctx, request.GetOperationId(), caller.WorkspaceID, operation, 0)
	if err != nil {
		return nil, err
	}
	// A replayed request already has its entry; scheduling it a second time
	// would run one decision twice.
	if !result.Replayed {
		s.queue.submit(caller.WorkspaceID, stored, root)
	}
	return &pb.EnqueueGitOperationResponse{Operation: stored, Receipt: receipt(result)}, nil
}

// replay answers a repeated enqueue with the entry the first one created.
//
// The receipt records which entity the operation published, so the identifier
// that was minted then is recoverable now. Reading it back rather than
// re-minting is what makes a retried "commit" one commit: a second identifier
// would be a second decision, whatever the idempotency key said.
func (s *Service) replay(ctx context.Context, workspaceID, operationID string) (*pb.EnqueueGitOperationResponse, bool, error) {
	if !textOperationID(operationID) {
		return nil, false, ErrInvalid
	}
	result, found, err := s.store.Receipt(ctx, operationID)
	if err != nil || !found {
		return nil, false, err
	}
	for _, revision := range result.Revisions {
		if revision.Kind != OperationKind || revision.WorkspaceID != workspaceID {
			continue
		}
		operation, err := s.operation(ctx, workspaceID, revision.ID)
		if err != nil {
			return nil, false, err
		}
		result.Replayed = true
		return &pb.EnqueueGitOperationResponse{Operation: operation, Receipt: receipt(result)}, true, nil
	}
	// The identifier was used for something that is not a queue entry. That is
	// a reused idempotency key, not a replay, and the storage kernel's own
	// digest check is what reports it.
	return nil, false, nil
}

func textOperationID(value string) bool {
	return value != "" && len(value) <= 512
}

func validExpectation(expected *pb.GitExpectation) error {
	if expected == nil {
		return nil
	}
	for _, oid := range []string{expected.GetHeadOid(), expected.GetRefOid()} {
		if oid != "" && (len(oid) < 4 || len(oid) > 64 || !hexadecimal(oid)) {
			return ErrInvalid
		}
	}
	if name := expected.GetRefName(); len(name) > 512 {
		return ErrInvalid
	}
	if print := expected.GetIndexFingerprint(); len(print) != 0 && len(print) != 32 {
		return ErrInvalid
	}
	return nil
}

// GetOperation reads one entry.
func (s *Service) GetOperation(ctx context.Context, caller Caller, request *pb.GetGitOperationRequest) (*pb.GetGitOperationResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	operation, err := s.operation(ctx, caller.WorkspaceID, request.GetOperationId())
	if err != nil {
		return nil, err
	}
	return &pb.GetGitOperationResponse{Operation: operation}, nil
}

// ListOperations answers one repository's queue, newest first — the order a
// panel renders. `active_only` is what a queue-depth check and a switch ask
// for.
func (s *Service) ListOperations(ctx context.Context, caller Caller, request *pb.ListGitOperationsRequest) (*pb.ListGitOperationsResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	scope := request.GetScope()
	if scope != nil && scope.GetRepositoryPath() != "" {
		if err := validScope(scope, caller.WorkspaceID); err != nil {
			return nil, err
		}
	}
	stored, err := s.operations(ctx, caller.WorkspaceID)
	if err != nil {
		return nil, err
	}
	limit := pageSize(request.GetLimit())
	result := &pb.ListGitOperationsResponse{Operations: []*pb.GitOperation{}}
	for index := len(stored) - 1; index >= 0; index-- {
		operation := stored[index]
		if scope.GetRepositoryPath() != "" && operation.GetScope().GetRepositoryPath() != scope.GetRepositoryPath() {
			continue
		}
		if request.GetActiveOnly() && terminal(operation.GetState()) {
			continue
		}
		if after := request.GetAfterOperationId(); after != "" && operation.GetOperationId() >= after {
			continue
		}
		if len(result.Operations) == limit {
			result.HasMore = true
			break
		}
		result.Operations = append(result.Operations, operation)
		result.NextOperationId = operation.GetOperationId()
	}
	return result, nil
}

// CancelOperation asks the execution host to stop.
//
// Cancelling is a request, not a result. The entry is not marked cancelled
// here: the Worker reports what actually happened, and an operation whose
// mutation had already begun comes back UNKNOWN_OUTCOME rather than CANCELLED,
// because a stopped push may still have been accepted.
func (s *Service) CancelOperation(ctx context.Context, caller Caller, request *pb.CancelGitOperationRequest) (*pb.CancelGitOperationResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	operation, err := s.operation(ctx, caller.WorkspaceID, request.GetTargetOperationId())
	if err != nil {
		return nil, err
	}
	if terminal(operation.GetState()) {
		return nil, ErrTerminal
	}
	root, err := s.workspaceRoot(ctx, caller.WorkspaceID)
	if err != nil {
		return nil, err
	}
	// Withdrawing a queued entry is the Host's own decision: nothing has run,
	// so nothing has an unknown outcome. Anything already running belongs to
	// the execution host, and only its reading may end it.
	if !s.queue.withdraw(caller.WorkspaceID, operation.GetOperationId()) {
		if err = s.executor.CancelGitOperation(ctx, operation.GetOperationId(), root, operation.GetScope().GetRepositoryPath()); err != nil {
			return nil, err
		}
		stored, err := s.operation(ctx, caller.WorkspaceID, operation.GetOperationId())
		if err != nil {
			return nil, err
		}
		return &pb.CancelGitOperationResponse{Operation: stored, Receipt: &pb.CanvasOperationReceipt{OperationId: request.GetOperationId()}}, nil
	}
	next := proto.Clone(operation).(*pb.GitOperation)
	next.State = pb.GitOperationState_GIT_OPERATION_STATE_CANCELLED
	next.MessageCode = "git.operation.cancelled_before_mutation"
	next.FinishedAtUnixMs = s.now()
	stored, result, err := s.put(ctx, request.GetOperationId(), caller.WorkspaceID, next, operation.GetRevision())
	if err != nil {
		return nil, err
	}
	return &pb.CancelGitOperationResponse{Operation: stored, Receipt: receipt(result)}, nil
}

// record stores a state change the scheduler or the reconciler produced. It
// takes its own operation id namespace so a client's idempotency keys and the
// Host's own transitions can never collide.
func (s *Service) record(ctx context.Context, workspaceID string, operation *pb.GitOperation, expected uint64, reason string) (*pb.GitOperation, error) {
	stored, _, err := s.put(ctx, "githost/"+workspaceID+"/"+operation.GetOperationId()+"/"+reason, workspaceID, operation, expected)
	return stored, err
}
