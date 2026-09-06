// Package automationhost assembles the Host's production scheduling path: an
// owned Rust command Worker, the frozen session definitions the Host rebuilds
// on it, the persistent automation engine and the payload/authorization
// lookups a dispatch is re-checked against. It opens no listener of its own and
// never writes into an interactive PTY.
package automationhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/automation"
	"armadra.local/host/internal/commanddispatch"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
	"armadra.local/host/internal/worker"
	"google.golang.org/protobuf/proto"
)

var (
	// ErrUnsupported means this Host was started without an execution Worker,
	// or the request asks for a capability it does not have. It is never
	// answered with empty data pretending the operation succeeded.
	ErrUnsupported = errors.New("automation execution is unavailable on this Host")
	ErrInvalid     = automation.ErrInvalid
	idPattern      = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
)

const (
	// Scope names checked against the verified session's recorded grants.
	ScopeRead   = "automation:read"
	ScopeManage = "automation:manage"

	defaultMaxRestarts   = 5
	defaultRestartBase   = time.Second
	defaultRestartCap    = 30 * time.Second
	defaultHealthyAfter  = time.Minute
	defaultRequestBudget = 10 * time.Second
	rebuildPage          = 200
)

type Options struct {
	// Executable and StateDir are explicit configuration. An unset pair means
	// automation is not enabled; a half-configured pair is a startup error.
	Executable, StateDir string
	HostID, InstanceID   string
	Store                *storage.Store
	// Sessions is the session domain's landing point for a run report. Nil on a
	// Host that assembles no session service: the frame is still recorded, it
	// simply changes no session record.
	Sessions SessionObserver
	// Agents is the agent domain's landing point for a Hook report, on the same
	// terms.
	Agents AgentObserver
	Clock                func() time.Time
	RequestTimeout       time.Duration
	PollInterval         time.Duration
	MaxRestarts          int
	RestartBackoff       time.Duration
	HealthyAfter         time.Duration
}

// Caller is the verified session's own identity and grants. Nothing here comes
// from a client-supplied field.
type Caller struct {
	PrincipalID, DeviceID, WorkspaceID string
	DeviceEpoch                        uint64
	Scopes                             []auth.Scope
}

type Service struct {
	options   Options
	store     *storage.Store
	engine    *automation.Engine
	clock     func() time.Time
	mu        sync.Mutex
	client    *worker.Client
	inner     *commanddispatch.Dispatcher
	startedAt time.Time
	reason    string
	closing   sync.Once
	closeErr  error
	closed    bool
}

// Configured reports whether the operator asked for an execution Worker at all.
func Configured(options Options) bool { return options.Executable != "" || options.StateDir != "" }

// New starts the Worker, rebuilds the stored command definitions on it and
// prepares the engine. It does not begin scheduling; Run does.
func New(ctx context.Context, options Options) (*Service, error) {
	if options.Executable == "" || options.StateDir == "" || options.Store == nil {
		return nil, ErrUnsupported
	}
	if !filepath.IsAbs(options.Executable) || !filepath.IsAbs(options.StateDir) {
		return nil, errors.New("automation requires absolute Worker executable and state directory paths")
	}
	if options.Clock == nil {
		options.Clock = time.Now
	}
	if options.RequestTimeout == 0 {
		options.RequestTimeout = defaultRequestBudget
	}
	if options.MaxRestarts == 0 {
		options.MaxRestarts = defaultMaxRestarts
	}
	if options.RestartBackoff == 0 {
		options.RestartBackoff = defaultRestartBase
	}
	if options.HealthyAfter == 0 {
		options.HealthyAfter = defaultHealthyAfter
	}
	s := &Service{options: options, store: options.Store, clock: options.Clock, reason: "WORKER_NOT_STARTED"}
	engine, err := automation.New(options.Store, s, s, automation.Options{Clock: options.Clock, InstanceID: options.InstanceID, PollInterval: options.PollInterval})
	if err != nil {
		return nil, err
	}
	s.engine = engine
	// Runs written before the history index existed are projected into it once,
	// before anything can page them: a run history that silently began at the
	// upgrade would look truncated rather than ordered.
	if err = engine.EnsureRunHistory(ctx); err != nil {
		return nil, err
	}
	if err = s.start(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// Run owns the Host lifetime, never a page or request. It returns only after
// both the schedule loop and Worker supervision have stopped.
func (s *Service) Run(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	supervision := make(chan struct{})
	go func() { defer close(supervision); s.supervise(ctx) }()
	err := s.engine.Run(ctx)
	cancel()
	<-supervision
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return nil
	}
	return err
}

// Close stops the owned Worker and reports whether its children were reclaimed.
// Callers stop Run first: a Worker must not be shut down under a live dispatch.
func (s *Service) Close() error {
	if s == nil {
		return nil
	}
	s.closing.Do(func() {
		s.mu.Lock()
		client := s.client
		s.client, s.inner, s.closed, s.reason = nil, nil, true, "HOST_STOPPING"
		s.mu.Unlock()
		s.closeErr = client.Close()
	})
	return s.closeErr
}

func (s *Service) now() int64 { return s.clock().UnixMilli() }

func (s *Service) current() (*worker.Client, *commanddispatch.Dispatcher, time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.client, s.inner, s.startedAt
}

// Unavailable reports the recorded reason no Worker is currently serving, or
// an empty string while one is live. It is diagnostic, not an authorization.
func (s *Service) Unavailable() string {
	if s == nil {
		return "AUTOMATION_NOT_CONFIGURED"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client != nil {
		return ""
	}
	return s.reason
}

func (s *Service) start(ctx context.Context) error {
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return ErrUnsupported
	}
	// Every rebuilt Worker gets the upcall sink, so the supervisor's existing
	// restart path is also the channel's reconnect path: a Worker that comes
	// back replays what it owes over the new pipe with no extra machinery.
	client, err := worker.Start(ctx, worker.Options{Executable: s.options.Executable, HostID: s.options.HostID, StateDir: s.options.StateDir, RequestTimeout: s.options.RequestTimeout, Upcalls: upcallRecorder{store: s.store, hostInstance: s.options.InstanceID, sessions: s.options.Sessions, agents: s.options.Agents}})
	if err != nil {
		s.disable("WORKER_START_FAILED")
		return err
	}
	inner, err := commanddispatch.New(client, payloads{s.store})
	if err != nil {
		s.disable("WORKER_COMMANDS_UNAVAILABLE")
		return errors.Join(err, client.Close())
	}
	if err = s.rebuild(ctx, client); err != nil {
		s.disable("DEFINITION_REBUILD_FAILED")
		return errors.Join(err, client.Close())
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return errors.Join(ErrUnsupported, client.Close())
	}
	s.client, s.inner, s.startedAt, s.reason = client, inner, s.clock(), ""
	s.mu.Unlock()
	return nil
}

func (s *Service) disable(reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.client, s.inner, s.reason = nil, nil, reason
	}
}

func backoff(attempt int, base, limit time.Duration) time.Duration {
	wait := base
	for range attempt {
		if wait >= limit/2 {
			return limit
		}
		wait *= 2
	}
	return wait
}

func wait(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// supervise restarts an unexpectedly exited Worker a bounded number of times.
// A restart re-applies the stored definitions; it never re-sends a dispatch,
// which stays keyed by its stable operation ID and its durable receipt.
func (s *Service) supervise(ctx context.Context) {
	attempts := 0
	for {
		client, _, startedAt := s.current()
		if client != nil {
			select {
			case <-ctx.Done():
				return
			case <-client.Done():
			}
			_ = client.Close()
			s.disable("WORKER_EXITED")
			if s.clock().Sub(startedAt) >= s.options.HealthyAfter {
				attempts = 0
			}
		}
		if ctx.Err() != nil {
			return
		}
		if attempts >= s.options.MaxRestarts {
			s.disable("WORKER_RESTART_BUDGET_EXHAUSTED")
			return
		}
		if !wait(ctx, backoff(attempts, s.options.RestartBackoff, defaultRestartCap)) {
			return
		}
		attempts++
		if err := s.start(ctx); err != nil {
			continue
		}
	}
}

// rebuild re-applies the Host's own stored definitions to a fresh Worker and
// verifies the generation it reports. A definition that cannot be rebuilt, or
// that comes back with a different generation or launch digest, is recorded as
// unrebuildable so plans targeting it are refused instead of waiting forever.
func (s *Service) rebuild(ctx context.Context, client *worker.Client) error {
	roots, err := s.store.CommandRoots(ctx)
	if err != nil {
		return err
	}
	bound := map[string]bool{}
	for _, root := range roots {
		if _, err = client.BindCommandRoot(ctx, &pb.BindCommandRootRequest{RootId: root.RootID, WorkspaceId: root.WorkspaceID, Path: root.Path}); err == nil {
			bound[root.RootID] = true
		}
	}
	after := ""
	for {
		page, err := s.store.CommandSessions(ctx, "", after, rebuildPage)
		if err != nil {
			return err
		}
		for _, record := range page {
			after = record.SessionID
			if record.State != storage.CommandSessionReady {
				continue
			}
			reason := s.rebuildSession(ctx, client, record, bound[record.RootID])
			if reason == "" {
				continue
			}
			if _, err = s.store.UpdateCommandSession(ctx, record.SessionID, record.Revision, record.Generation, storage.CommandSessionUnrebuildable, reason, s.now()); err != nil && !errors.Is(err, storage.ErrConflict) {
				return err
			}
		}
		if len(page) < rebuildPage {
			return nil
		}
	}
}

func (s *Service) rebuildSession(ctx context.Context, client *worker.Client, record storage.CommandSession, rootBound bool) string {
	if !rootBound {
		return "ROOT_UNAVAILABLE"
	}
	launch := new(pb.CommandLaunchSpec)
	if proto.Unmarshal(record.Launch, launch) != nil {
		return "LAUNCH_UNREADABLE"
	}
	session, err := client.CreateCommandSession(ctx, &pb.CreateCommandSessionRequest{SessionId: record.SessionID, RootId: record.RootID, WorkspaceId: record.WorkspaceID, Kind: pb.CommandSessionKind_COMMAND_SESSION_KIND_NON_INTERACTIVE_COMMAND, Launch: launch})
	if err != nil || session == nil {
		return "REBUILD_FAILED"
	}
	if session.Generation != record.Generation {
		return "GENERATION_CHANGED"
	}
	if [32]byte(sha256.Sum256(record.Launch)) != record.LaunchSHA256 || string(session.LaunchSha256) != string(record.LaunchSHA256[:]) {
		return "LAUNCH_DIGEST_CHANGED"
	}
	return ""
}

// payloads resolves immutable Host-owned content. It independently re-checks
// the digest; it never accepts a browser token or a caller-supplied body.
type payloads struct{ store *storage.Store }

func (p payloads) Resolve(ctx context.Context, workspace, reference string) ([]byte, error) {
	record, err := p.store.AutomationPayload(ctx, workspace, reference)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(record.Payload)
	if digest != record.SHA256 || hex.EncodeToString(digest[:]) != reference {
		return nil, storage.ErrCorrupt
	}
	return record.Payload, nil
}

// Verify re-checks a stored authorization at dispatch time without any browser
// credential: the device must still exist, be unrevoked, keep the epoch the
// grant recorded, and still hold automation:manage for this exact workspace
// and execution host.
func (s *Service) Verify(ctx context.Context, authorization automation.Authorization, config *pb.AutomationPlanConfig) error {
	if config == nil || config.Target == nil {
		return automation.ErrAuthorization
	}
	grant, epoch, revoked, err := s.store.AutomationGrant(ctx, authorization.AuthorizationID)
	if err != nil {
		return automation.ErrAuthorization
	}
	if grant.PrincipalID != authorization.PrincipalID || revoked != 0 || epoch != grant.DeviceEpoch {
		return automation.ErrAuthorization
	}
	scopes, err := auth.DecodeScopes(grant.Scopes)
	if err != nil {
		return automation.ErrAuthorization
	}
	if !auth.Permits(scopes, []auth.Scope{{Permission: ScopeManage, WorkspaceID: config.WorkspaceId, ExecutionHostID: config.Target.ExecutionHostId}}) {
		return automation.ErrAuthorization
	}
	return nil
}

// Supports answers from the Host's own definition first: an unrebuildable or
// unknown target is explicitly unsupported, not an indefinite wait.
func (s *Service) Supports(ctx context.Context, target *pb.AutomationTarget) (automation.TargetStatus, error) {
	if target == nil || target.ExecutionHostId != s.options.HostID {
		return automation.TargetStatus{State: automation.TargetUnsupported}, nil
	}
	// An agent target names a canvas node, not a session this Host froze, so
	// there is no stored definition to answer from: the Runtime that owns the
	// terminal is the only thing that can say whether it is writable.
	if automation.AgentTarget(target) {
		_, inner, _ := s.current()
		if inner == nil {
			return automation.TargetStatus{State: automation.TargetUnknown}, ErrUnsupported
		}
		return inner.Supports(ctx, target)
	}
	record, err := s.store.CommandSession(ctx, target.SessionId)
	if errors.Is(err, storage.ErrNotFound) {
		return automation.TargetStatus{State: automation.TargetUnsupported}, nil
	}
	if err != nil {
		return automation.TargetStatus{State: automation.TargetUnknown}, err
	}
	if record.State != storage.CommandSessionReady || record.ExecutionHostID != s.options.HostID || record.Generation != target.Generation {
		return automation.TargetStatus{State: automation.TargetUnsupported, Generation: record.Generation}, nil
	}
	_, inner, _ := s.current()
	if inner == nil {
		return automation.TargetStatus{State: automation.TargetUnknown}, ErrUnsupported
	}
	return inner.Supports(ctx, target)
}

func (s *Service) Dispatch(ctx context.Context, run *pb.AutomationRun) (*pb.AutomationReceipt, error) {
	_, inner, _ := s.current()
	if inner == nil {
		return nil, ErrUnsupported
	}
	return inner.Dispatch(ctx, run)
}

func (s *Service) Lookup(ctx context.Context, run *pb.AutomationRun) (*pb.AutomationReceipt, error) {
	_, inner, _ := s.current()
	if inner == nil {
		return nil, ErrUnsupported
	}
	return inner.Lookup(ctx, run)
}

var (
	_ automation.Dispatcher = (*Service)(nil)
	_ automation.Authorizer = (*Service)(nil)
)
