package sessionhost

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

// Runner is the channel to the execution host. It is an interface rather than
// the Worker client so a test can exercise every decision this service makes
// without a Rust binary — and so a Host with no reachable Worker is a distinct,
// nameable state rather than a nil dereference.
//
// Nothing here decides anything. Each method is one question put to the machine
// that runs the programs, and the answers are recorded rather than interpreted:
// a generation is the Worker's, an exit code is the Worker's, and a session the
// Worker does not list is reported rather than assumed dead.
type Runner interface {
	StartRun(ctx context.Context, request *pb.StartSessionRunRequest) (*pb.WorkerSessionState, error)
	SignalRun(ctx context.Context, request *pb.SignalSessionRunRequest) (*pb.WorkerSessionState, error)
	ReclaimRuns(ctx context.Context, sessionIDs []string) (*pb.WorkerSessionStates, error)
	CaptureRun(ctx context.Context, request *pb.CaptureSessionRunRequest) (*pb.CapturedSessionRun, error)
	SuggestTitle(ctx context.Context, request *pb.SuggestSessionTitleRequest) (*pb.SuggestSessionTitleResponse, error)
	ContextUsage(ctx context.Context, request *pb.GetSessionContextUsageRequest) (*pb.GetSessionContextUsageResponse, error)
}

// OpenRunner produces a channel to the execution host for one exchange, or an
// error when none is reachable. It returns a closer because the production
// implementation starts a Worker: a session command must not keep one alive
// between requests, and a Host that leaked them would eventually be unable to
// start the one that matters.
type OpenRunner func(ctx context.Context, executionHostID string) (Runner, func(), error)

type Options struct {
	Store  *storage.Store
	HostID string
	// Open is nil on a Host with no execution channel. Reads still answer; the
	// methods that need a process refuse with ErrNoWorker, which is a state a
	// client can draw rather than a failure it has to guess at.
	Open OpenRunner
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

// Owned reports whether this Host is the settled writer of the session domain.
// It is exported because the terminal proxy asks it before it validates a
// socket upgrade against this Host's records: while the Runtime still owns the
// domain, the Runtime's row is the session record and this Host must not
// narrow against a projection it has not been handed.
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

func pageSize(limit uint32) int {
	if limit == 0 {
		return 100
	}
	if limit > MaxPage {
		return MaxPage
	}
	return int(limit)
}

// Session reads one record. A closed session answers ErrNotFound: the tombstone
// is a CAS token for whoever creates the next one, not a session to show.
func (s *Service) Session(ctx context.Context, sessionID string) (storage.Session, error) {
	if !validID(sessionID) {
		return storage.Session{}, ErrInvalid
	}
	session, err := s.store.GetSession(ctx, sessionID)
	if errors.Is(err, storage.ErrNotFound) {
		return storage.Session{}, ErrNotFound
	}
	if err != nil {
		return storage.Session{}, err
	}
	if session.Deleted {
		return storage.Session{}, ErrNotFound
	}
	return session, nil
}

// Tombstone reads a record including a closed one. It is what a create has to
// consult before it can name the revision it is replacing.
func (s *Service) Tombstone(ctx context.Context, sessionID string) (storage.Session, error) {
	if !validID(sessionID) {
		return storage.Session{}, ErrInvalid
	}
	session, err := s.store.GetSession(ctx, sessionID)
	if errors.Is(err, storage.ErrNotFound) {
		return storage.Session{}, ErrNotFound
	}
	return session, err
}

/* ------------------------------------------------------------------- reads */

// GetSession answers one session and its current run.
//
// This is the read a mounting terminal node makes, and the whole point of the
// domain is that it is *only* a read: the node learns whether a session exists
// and attaches to it. Whether one should be created is a separate request the
// client makes deliberately.
func (s *Service) GetSession(ctx context.Context, caller Caller, request *pb.GetSessionRequest) (*pb.GetSessionResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	id, key := request.GetSessionId(), request.GetSessionKey()
	// Naming both would let the two disagree, and resolving that by precedence
	// would answer about a session the caller did not ask for.
	if (id == "") == (key == "") {
		return nil, ErrInvalid
	}
	var session storage.Session
	var err error
	if id != "" {
		session, err = s.Session(ctx, id)
	} else {
		if !validID(key) {
			return nil, ErrInvalid
		}
		session, err = s.store.GetSessionByKey(ctx, key)
		if errors.Is(err, storage.ErrNotFound) {
			err = ErrNotFound
		}
	}
	if err != nil {
		return nil, err
	}
	// A device asks about its own workspace. Answering about another one would
	// say which programs somebody else is running, and where.
	if session.WorkspaceID != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	result := &pb.GetSessionResponse{Session: message(session)}
	if session.Generation > 0 {
		run, err := s.store.GetSessionRun(ctx, session.SessionID, session.Generation)
		if err == nil {
			result.Run = runMessage(run)
		} else if !errors.Is(err, storage.ErrNotFound) {
			return nil, err
		}
	}
	return result, nil
}

// ListSessions answers the caller's own workspace only. The surface is
// workspace-scoped end to end: a device granted one workspace must not learn
// which sessions exist in another.
func (s *Service) ListSessions(ctx context.Context, caller Caller, request *pb.ListSessionsRequest) (*pb.ListSessionsResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	after := request.GetAfterSessionId()
	if after != "" && !validID(after) {
		return nil, ErrInvalid
	}
	wanted := map[pb.SessionKind]bool{}
	for _, kind := range request.GetKinds() {
		if kind == pb.SessionKind_SESSION_KIND_UNSPECIFIED {
			return nil, ErrInvalid
		}
		wanted[kind] = true
	}
	page, more, err := s.store.ListSessions(ctx, caller.WorkspaceID, after, pageSize(request.GetLimit()))
	if err != nil {
		return nil, err
	}
	result := &pb.ListSessionsResponse{HasMore: more}
	for _, session := range page {
		result.NextSessionId = session.SessionID
		if len(wanted) > 0 && !wanted[pb.SessionKind(session.Kind)] {
			continue
		}
		result.Sessions = append(result.Sessions, message(session))
	}
	return result, nil
}

/* ------------------------------------------------------------------ writes */

// put is the one write path for a session's intent: CAS, publish, read back
// what was stored. Every mutation below reduces to it, so there is one place
// where a session reaches the database.
func (s *Service) put(ctx context.Context, operationID string, session storage.Session, expected uint64) (*pb.Session, *pb.CanvasOperationReceipt, error) {
	result, err := s.store.PutSession(ctx, operationID, session, expected)
	if err != nil {
		return nil, nil, err
	}
	stored, err := s.store.GetSession(ctx, session.SessionID)
	if err != nil {
		return nil, nil, err
	}
	return message(stored), receipt(result), nil
}

// CreateSession records the intent and starts nothing.
//
// This is the method that takes "should a process exist?" away from the
// browser. A mount used to create a session as a side effect of rendering,
// which meant a page that rendered twice started two programs; here the
// decision carries an operation id and the revision it was made against, so
// the second one is a refusal rather than a second shell.
func (s *Service) CreateSession(ctx context.Context, caller Caller, request *pb.CreateSessionRequest) (*pb.CreateSessionResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	input := request.GetSession()
	if input.GetWorkspaceId() != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	now := s.now()
	session, err := record(input, now, now)
	if err != nil {
		return nil, err
	}
	// A created session has never run. Accepting a status, generation or exit
	// code from the client would let it claim a process nobody started.
	session.Status = int32(pb.SessionStatus_SESSION_STATUS_PENDING)
	session.AttachState = int32(pb.SessionAttachState_SESSION_ATTACH_STATE_DETACHED)
	session.Intent = int32(pb.TerminationIntent_TERMINATION_INTENT_NONE)
	session.Generation, session.ExitCode, session.BackendKind = 0, nil, ""
	session.EndedAtMS, session.LastOutputMS, session.ReasonCode = 0, 0, ""
	if session, err = stamp(session); err != nil {
		return nil, err
	}
	value, receipt, err := s.put(ctx, request.GetOperationId(), session, request.GetExpectedRevision())
	if err != nil {
		return nil, err
	}
	return &pb.CreateSessionResponse{Session: value, Receipt: receipt}, nil
}

// StartSession asks the execution host for a run and records what it reports.
//
// The launch is not in the request: it was frozen at creation, and a start that
// could restate it would be a second place the command line is decided. What
// comes back — the generation, the backend and its reference — is recorded
// rather than checked against an expectation, because the machine that started
// the process is the only side that knows those values.
func (s *Service) StartSession(ctx context.Context, caller Caller, request *pb.StartSessionRequest) (*pb.StartSessionResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	session, err := s.Session(ctx, request.GetSessionId())
	if err != nil {
		return nil, err
	}
	if session.WorkspaceID != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	state, receipt, err := s.startRun(ctx, session, request.GetOperationId(), request.GetExpectedRevision(), false)
	if err != nil {
		return nil, err
	}
	return &pb.StartSessionResponse{Session: state.session, Run: state.run, Receipt: receipt}, nil
}

// RecycleSession ends the current run and starts the next generation of the
// same logical session. It is one method rather than terminate-then-start
// because the two together are not the same thing: a client that crashed
// between them would leave a session recorded as running with no process.
func (s *Service) RecycleSession(ctx context.Context, caller Caller, request *pb.RecycleSessionRequest) (*pb.RecycleSessionResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	session, err := s.Session(ctx, request.GetSessionId())
	if err != nil {
		return nil, err
	}
	if session.WorkspaceID != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	state, receipt, err := s.startRun(ctx, session, request.GetOperationId(), request.GetExpectedRevision(), true)
	if err != nil {
		return nil, err
	}
	return &pb.RecycleSessionResponse{Session: state.session, Run: state.run, Receipt: receipt}, nil
}

// TerminateSession ends the run and keeps the record. Terminating is not
// closing: the session still exists, with its history, and a client can start
// it again.
func (s *Service) TerminateSession(ctx context.Context, caller Caller, request *pb.TerminateSessionRequest) (*pb.TerminateSessionResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	session, err := s.Session(ctx, request.GetSessionId())
	if err != nil {
		return nil, err
	}
	if session.WorkspaceID != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	value, receipt, err := s.terminate(ctx, session, request)
	if err != nil {
		return nil, err
	}
	return &pb.TerminateSessionResponse{Session: value, Receipt: receipt}, nil
}

// CloseSession withdraws the intent.
//
// It does not kill anything. A caller that wants the process gone terminates
// first; conflating the two would mean closing a node could not be undone, and
// would make "remove this from my board" and "kill this program" one button.
func (s *Service) CloseSession(ctx context.Context, caller Caller, request *pb.CloseSessionRequest) (*pb.CloseSessionResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	session, err := s.Session(ctx, request.GetSessionId())
	if err != nil {
		return nil, err
	}
	if session.WorkspaceID != caller.WorkspaceID {
		return nil, ErrAuthorization
	}
	tombstone := storage.Session{
		SessionID:   session.SessionID,
		WorkspaceID: session.WorkspaceID,
		SessionKey:  session.SessionKey,
		Kind:        session.Kind,
		Status:      int32(pb.SessionStatus_SESSION_STATUS_EXITED),
		AttachState: int32(pb.SessionAttachState_SESSION_ATTACH_STATE_EXITED),
		Intent:      session.Intent,
		Deleted:     true,
		CreatedAtMS: session.CreatedAtMS,
		UpdatedAtMS: s.now(),
		EndedAtMS:   session.EndedAtMS,
	}
	if tombstone, err = stamp(tombstone); err != nil {
		return nil, err
	}
	_, receipt, err := s.put(ctx, request.GetOperationId(), tombstone, request.GetExpectedRevision())
	if err != nil {
		return nil, err
	}
	return &pb.CloseSessionResponse{SessionId: session.SessionID, Receipt: receipt}, nil
}

/* --------------------------------------------------------- forwarded reads */

// SuggestTitle and GetContextUsage are execution, forwarded unchanged.
//
// Both answers come from the transcript or the live pane, which are on the
// execution host. This Host resolves which session is being asked about and
// which machine holds it; it reads no transcript and computes no usage, because
// doing so would mean a second implementation of something the Worker already
// has and would need the files to be on this machine.

func (s *Service) SuggestTitle(ctx context.Context, caller Caller, request *pb.SuggestSessionTitleRequest) (*pb.SuggestSessionTitleResponse, error) {
	session, runner, done, err := s.reach(ctx, caller, request.GetSessionId())
	if err != nil {
		return nil, err
	}
	defer done()
	return runner.SuggestTitle(ctx, &pb.SuggestSessionTitleRequest{SessionId: session.SessionID})
}

func (s *Service) ContextUsage(ctx context.Context, caller Caller, request *pb.GetSessionContextUsageRequest) (*pb.GetSessionContextUsageResponse, error) {
	session, runner, done, err := s.reach(ctx, caller, request.GetSessionId())
	if err != nil {
		return nil, err
	}
	defer done()
	return runner.ContextUsage(ctx, &pb.GetSessionContextUsageRequest{SessionId: session.SessionID, Refresh: request.GetRefresh()})
}

// reach resolves a session the caller may read and opens a channel to the
// machine that holds it. It is a read authorization: asking a Worker what a
// pane says is reading, not running something.
func (s *Service) reach(ctx context.Context, caller Caller, sessionID string) (storage.Session, Runner, func(), error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return storage.Session{}, nil, nil, err
	}
	session, err := s.Session(ctx, sessionID)
	if err != nil {
		return storage.Session{}, nil, nil, err
	}
	if session.WorkspaceID != caller.WorkspaceID {
		return storage.Session{}, nil, nil, ErrAuthorization
	}
	runner, done, err := s.open(ctx, session.ExecutionHostID)
	if err != nil {
		return storage.Session{}, nil, nil, err
	}
	return session, runner, done, nil
}

func (s *Service) open(ctx context.Context, executionHostID string) (Runner, func(), error) {
	if s.options.Open == nil {
		return nil, nil, ErrNoWorker
	}
	runner, done, err := s.options.Open(ctx, executionHostID)
	if err != nil {
		return nil, nil, errors.Join(ErrNoWorker, err)
	}
	if done == nil {
		done = func() {}
	}
	return runner, done, nil
}
