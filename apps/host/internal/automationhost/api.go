package automationhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/automation"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
	"armadra.local/host/internal/worker"
	"google.golang.org/protobuf/proto"
)

const MaxPayloadBytes = storage.MaxAutomationPayloadBytes

func (c Caller) valid() bool {
	return c.PrincipalID != "" && c.DeviceID != "" && c.DeviceEpoch > 0 && idPattern.MatchString(c.WorkspaceID) && len(c.Scopes) > 0
}

// authorize checks the verified session's own grants for this workspace and
// execution host. It never widens an empty or host-wide request.
func (s *Service) authorize(caller Caller, permission string) error {
	if s == nil {
		return ErrUnsupported
	}
	if !caller.valid() {
		return automation.ErrAuthorization
	}
	if !auth.Permits(caller.Scopes, []auth.Scope{{Permission: permission, WorkspaceID: caller.WorkspaceID, ExecutionHostID: s.options.HostID}}) {
		return automation.ErrAuthorization
	}
	return nil
}

func (s *Service) authorization(caller Caller) automation.Authorization {
	return automation.Authorization{PrincipalID: caller.PrincipalID, AuthorizationID: caller.DeviceID}
}

// recordGrant stores the scopes this device held when it authorized the work.
// A later dispatch is re-checked against this record, not a live session.
func (s *Service) recordGrant(ctx context.Context, caller Caller) error {
	wire, err := auth.EncodeScopes(caller.Scopes)
	if err != nil {
		return automation.ErrAuthorization
	}
	now := s.now()
	return s.store.PutAutomationGrant(ctx, storage.AutomationGrant{AuthorizationID: caller.DeviceID, PrincipalID: caller.PrincipalID, DeviceID: caller.DeviceID, DeviceEpoch: caller.DeviceEpoch, Scopes: wire, CreatedAtMS: now, UpdatedAtMS: now})
}

func sessionMessage(record storage.CommandSession, rootPath string) *pb.AutomationCommandSession {
	launch := new(pb.CommandLaunchSpec)
	_ = proto.Unmarshal(record.Launch, launch)
	state := pb.AutomationCommandSessionState_AUTOMATION_COMMAND_SESSION_STATE_READY
	if record.State == storage.CommandSessionUnrebuildable {
		state = pb.AutomationCommandSessionState_AUTOMATION_COMMAND_SESSION_STATE_UNREBUILDABLE
	}
	return &pb.AutomationCommandSession{SessionId: record.SessionID, WorkspaceId: record.WorkspaceID, ExecutionHostId: record.ExecutionHostID, RootPath: rootPath, Launch: launch, Generation: record.Generation, LaunchSha256: append([]byte(nil), record.LaunchSHA256[:]...), State: state, ReasonCode: record.ReasonCode, Revision: record.Revision, CreatedAtUnixMs: record.CreatedAtMS, UpdatedAtUnixMs: record.UpdatedAtMS}
}

func rootIdentifier(workspace, path string) string {
	sum := sha256.Sum256([]byte(workspace + "\x00" + path))
	return "root-" + hex.EncodeToString(sum[:16])
}

// DefineCommandSession binds a root and freezes a NEW non-interactive command
// session on the Worker, then records the definition so the Host can rebuild
// it after the Worker is replaced. It writes into no existing terminal.
func (s *Service) DefineCommandSession(ctx context.Context, caller Caller, sessionID, rootPath string, launch *pb.CommandLaunchSpec) (*pb.AutomationCommandSession, error) {
	if err := s.authorize(caller, ScopeManage); err != nil {
		return nil, err
	}
	if !idPattern.MatchString(sessionID) || launch == nil || !filepath.IsAbs(rootPath) || strings.IndexByte(rootPath, 0) >= 0 {
		return nil, automation.ErrInvalid
	}
	client, _, _ := s.current()
	if client == nil {
		return nil, ErrUnsupported
	}
	rootID := rootIdentifier(caller.WorkspaceID, rootPath)
	root, err := client.BindCommandRoot(ctx, &pb.BindCommandRootRequest{RootId: rootID, WorkspaceId: caller.WorkspaceID, Path: rootPath})
	if err != nil {
		return nil, commandError(err)
	}
	now := s.now()
	stored, err := s.store.PutCommandRoot(ctx, storage.CommandRoot{RootID: rootID, WorkspaceID: caller.WorkspaceID, Path: root.CanonicalPath, CreatedAtMS: now})
	if err != nil {
		return nil, err
	}
	session, err := client.CreateCommandSession(ctx, &pb.CreateCommandSessionRequest{SessionId: sessionID, RootId: rootID, WorkspaceId: caller.WorkspaceID, Kind: pb.CommandSessionKind_COMMAND_SESSION_KIND_NON_INTERACTIVE_COMMAND, Launch: launch})
	if err != nil {
		return nil, commandError(err)
	}
	frozen, err := (proto.MarshalOptions{Deterministic: true}).Marshal(session.FrozenLaunch)
	if err != nil {
		return nil, err
	}
	record := storage.CommandSession{SessionID: sessionID, RootID: rootID, WorkspaceID: caller.WorkspaceID, ExecutionHostID: s.options.HostID, Launch: frozen, LaunchSHA256: sha256.Sum256(frozen), Generation: session.Generation, State: storage.CommandSessionReady, CreatedAtMS: now, UpdatedAtMS: now}
	if string(record.LaunchSHA256[:]) != string(session.LaunchSha256) {
		return nil, automation.ErrUnsupported
	}
	saved, err := s.store.PutCommandSession(ctx, record)
	if err != nil {
		return nil, err
	}
	if err = s.recordGrant(ctx, caller); err != nil {
		return nil, err
	}
	return sessionMessage(saved, stored.Path), nil
}

// ListCommandSessions reads this workspace's stored definitions, including the
// ones a rebuild marked unrebuildable and why.
func (s *Service) ListCommandSessions(ctx context.Context, caller Caller, after string, limit int) (*pb.ListCommandSessionsResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	page, err := s.store.CommandSessions(ctx, caller.WorkspaceID, after, limit+1)
	if err != nil {
		return nil, err
	}
	roots, err := s.store.CommandRoots(ctx)
	if err != nil {
		return nil, err
	}
	paths := map[string]string{}
	for _, root := range roots {
		paths[root.RootID] = root.Path
	}
	result := &pb.ListCommandSessionsResponse{}
	for index, record := range page {
		if index == limit {
			result.HasMore = true
			break
		}
		result.Sessions = append(result.Sessions, sessionMessage(record, paths[record.RootID]))
		result.NextId = record.SessionID
	}
	return result, nil
}

func planSnapshot(snapshot automation.PlanSnapshot) (*pb.AutomationPlanSnapshot, error) {
	digest, err := automation.ConfigurationHash(snapshot.Plan.Config)
	if err != nil {
		return nil, err
	}
	return &pb.AutomationPlanSnapshot{Plan: snapshot.Plan, Revision: snapshot.Revision, ConfigSha256: digest}, nil
}

// Define stores a plan configuration and its immutable payload. The Host owns
// the payload reference and digest; whatever the client wrote there is
// replaced, so a plan can never point at content the Host did not store.
func (s *Service) Define(ctx context.Context, caller Caller, planID string, config *pb.AutomationPlanConfig, payload []byte, expectedRevision uint64) (*pb.AutomationPlanSnapshot, error) {
	if err := s.authorize(caller, ScopeManage); err != nil {
		return nil, err
	}
	if !idPattern.MatchString(planID) || config == nil || config.Target == nil || len(payload) > MaxPayloadBytes {
		return nil, automation.ErrInvalid
	}
	prepared := proto.Clone(config).(*pb.AutomationPlanConfig)
	prepared.WorkspaceId = caller.WorkspaceID
	if prepared.Target.ExecutionHostId != s.options.HostID {
		return nil, ErrUnsupported
	}
	record, err := s.store.CommandSession(ctx, prepared.Target.SessionId)
	if err != nil {
		return nil, err
	}
	if record.WorkspaceID != caller.WorkspaceID || record.State != storage.CommandSessionReady {
		return nil, ErrUnsupported
	}
	if prepared.Target.Generation == 0 {
		prepared.Target.Generation = record.Generation
	}
	if prepared.Target.Generation != record.Generation {
		return nil, storage.ErrConflict
	}
	digest := sha256.Sum256(payload)
	prepared.PayloadRef = hex.EncodeToString(digest[:])
	prepared.PayloadSha256 = digest[:]
	if err = s.store.PutAutomationPayload(ctx, storage.AutomationPayload{WorkspaceID: caller.WorkspaceID, Ref: prepared.PayloadRef, Payload: payload, SHA256: digest, CreatedAtMS: s.now()}); err != nil {
		return nil, err
	}
	if err = s.recordGrant(ctx, caller); err != nil {
		return nil, err
	}
	snapshot, err := s.engine.Define(ctx, s.authorization(caller), planID, prepared, expectedRevision)
	if err != nil {
		return nil, err
	}
	return planSnapshot(snapshot)
}

// Activate requires the exact revision, configuration version and digest the
// caller reviewed. Editing a plan invalidates the activation by design.
func (s *Service) Activate(ctx context.Context, caller Caller, planID string, expectedRevision, configVersion uint64, digest []byte) (*pb.AutomationPlanSnapshot, error) {
	if err := s.authorize(caller, ScopeManage); err != nil {
		return nil, err
	}
	if err := s.recordGrant(ctx, caller); err != nil {
		return nil, err
	}
	snapshot, err := s.engine.Activate(ctx, s.authorization(caller), caller.WorkspaceID, planID, expectedRevision, configVersion, digest)
	if err != nil {
		return nil, err
	}
	return planSnapshot(snapshot)
}

func (s *Service) Pause(ctx context.Context, caller Caller, planID string, expectedRevision uint64) (*pb.AutomationPlanSnapshot, error) {
	if err := s.authorize(caller, ScopeManage); err != nil {
		return nil, err
	}
	snapshot, err := s.engine.Pause(ctx, s.authorization(caller), caller.WorkspaceID, planID, expectedRevision)
	if err != nil {
		return nil, err
	}
	return planSnapshot(snapshot)
}

func (s *Service) RunNow(ctx context.Context, caller Caller, planID string, expectedRevision uint64) (*pb.AutomationRunSnapshot, error) {
	if err := s.authorize(caller, ScopeManage); err != nil {
		return nil, err
	}
	if err := s.recordGrant(ctx, caller); err != nil {
		return nil, err
	}
	run, err := s.engine.RunNow(ctx, s.authorization(caller), caller.WorkspaceID, planID, expectedRevision)
	if err != nil {
		return nil, err
	}
	return &pb.AutomationRunSnapshot{Run: run.Run, Revision: run.Revision}, nil
}

func (s *Service) ListPlans(ctx context.Context, caller Caller, after string, limit int) (*pb.ListAutomationPlansResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	page, err := s.engine.ListPlans(ctx, caller.WorkspaceID, after, limit)
	if err != nil {
		return nil, err
	}
	result := &pb.ListAutomationPlansResponse{NextId: page.NextID, HasMore: page.HasMore}
	for _, snapshot := range page.Plans {
		message, err := planSnapshot(snapshot)
		if err != nil {
			return nil, err
		}
		result.Plans = append(result.Plans, message)
	}
	return result, nil
}

func (s *Service) ListRuns(ctx context.Context, caller Caller, planID, after string, limit int) (*pb.ListAutomationRunsResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	page, err := s.engine.ListRuns(ctx, caller.WorkspaceID, planID, after, limit)
	if err != nil {
		return nil, err
	}
	result := &pb.ListAutomationRunsResponse{NextId: page.NextID, HasMore: page.HasMore}
	for _, snapshot := range page.Runs {
		result.Runs = append(result.Runs, &pb.AutomationRunSnapshot{Run: snapshot.Run, Revision: snapshot.Revision})
	}
	return result, nil
}

// commandError translates a Worker refusal into a Host-level meaning without
// leaking the Worker's own diagnostics. An unrecognised failure stays opaque
// rather than being downgraded to a friendly, misleading code.
func commandError(err error) error {
	var problem *worker.Error
	if !errors.As(err, &problem) {
		return err
	}
	switch problem.Code {
	case worker.CodeInvalid, worker.CodeProtocol:
		return automation.ErrInvalid
	case worker.CodeUnsupported:
		return ErrUnsupported
	case worker.CodeRemote:
		switch problem.RemoteCode {
		case "NOT_FOUND":
			return storage.ErrNotFound
		case "CONFLICT", "STALE_GENERATION":
			return storage.ErrConflict
		case "PERMISSION_DENIED":
			return automation.ErrAuthorization
		case "UNSUPPORTED":
			return ErrUnsupported
		}
		return automation.ErrInvalid
	}
	return err
}

// Unsupported reports whether an error means this Host cannot serve the
// request at all, so a caller answers UNSUPPORTED instead of inventing data.
func Unsupported(err error) bool {
	return errors.Is(err, ErrUnsupported) || errors.Is(err, automation.ErrUnsupported)
}
