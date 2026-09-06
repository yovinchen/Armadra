// Package sessionhost is the Host's session domain: whether a session should
// exist, which node it belongs to, what it was frozen to launch, and what the
// last thing anybody observed about it was (Go Host 业务所有权迁移 §2.6, §3.1 v8).
//
// It owns no process and never will. A PTY, a tmux server handle, a replay log
// and a write gate all live where the program runs; a Host that claimed to own
// them would be claiming something it loses on every restart. What it does own
// is the decision — and that decision used to be taken by a browser as a side
// effect of rendering a node, which meant a page that mounted twice could start
// two programs. Here creation is a request with an operation id and a CAS
// revision, and starting is a second, separate decision.
//
// Two values are deliberately the Worker's rather than this Host's:
//
//   - `generation`, which distinguishes the pane you are typing into from the
//     pane that replaced it while you were away. Only the side that created the
//     new pane knows when that happened.
//   - `backend_ref`, a handle on an object inside another process. It is
//     carried opaquely and never parsed here.
package sessionhost

import (
	"crypto/sha256"
	"errors"
	"regexp"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const (
	// The session surface is governed by the grants that already govern the
	// Runtime terminal routes this Host proxies, for the reason the filesystem
	// domain reuses `files:*`: the same device with the same grants must get
	// the same allow/deny answer before and after the domain moves (§6.3,
	// 权限对照). A new `session:*` permission would make that table
	// incomparable by construction and would lock out every device paired
	// before it existed, since a device's grants are frozen at pairing.
	//
	// Reading which sessions exist is a read; creating, starting, terminating
	// and recycling all make the machine run or stop a program, which is what
	// `terminal:write` has always meant.
	ScopeRead  = "terminal:read"
	ScopeWrite = "terminal:write"

	// MaxPage bounds one listing. A workspace with more live sessions than
	// this has a problem the page size will not fix.
	MaxPage = 500

	// MaxLaunchArgs and MaxArgBytes bound a frozen argv. They are generous for
	// any real command line and small enough that an argv can never be a
	// payload smuggled through the session table.
	MaxLaunchArgs = 256
	MaxArgBytes   = 8192
	// MaxPathBytes bounds a working directory, matching the filesystem domain.
	MaxPathBytes = 4096
)

var (
	ErrInvalid       = errors.New("invalid session request")
	ErrAuthorization = errors.New("session permission denied")
	// ErrOwnershipMoved is the stable refusal a write gets when this process is
	// not the settled owner of the session domain. There is no dual-write mode:
	// while the Runtime owns the domain, or while a switch is open, this Host
	// answers reads and refuses every mutation.
	ErrOwnershipMoved = errors.New("ownership_moved")
	// ErrNotFound means no session with that identifier or key was recorded. It
	// is distinct from a closed one, which still has a revision a caller has to
	// name before creating another under the same key.
	ErrNotFound = errors.New("no such session")
	// ErrNoWorker means this Host has no channel to the execution host, so it
	// cannot ask for a run. It is not "the session failed": nothing was
	// started, and the intent is untouched.
	ErrNoWorker = errors.New("no Worker is reachable for this execution host")
	// ErrStaleGeneration means the caller decided against a generation the
	// execution host has already replaced. Applying the decision to the new
	// generation would signal a pane the caller has never seen.
	ErrStaleGeneration = errors.New("that generation has been replaced")
)

// Domain is the name this package is registered under in the switch order.
const Domain = storage.OwnershipDomainSession

// Identifiers are the ones the client already uses, so the switch keeps them
// unchanged.
var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$`)

func validID(value string) bool { return idPattern.MatchString(value) }

// validPath is what this Host will freeze as a working directory. It is checked
// rather than resolved: for a remote session the path is on another machine,
// and for a local one the Worker canonicalizes it. What is refused is a shape
// that could not be an absolute path anywhere.
func validPath(value string) bool {
	if value == "" || len(value) > MaxPathBytes || strings.ContainsRune(value, 0) {
		return false
	}
	if !strings.HasPrefix(value, "/") && !windowsAbsolute(value) {
		return false
	}
	for _, segment := range strings.Split(strings.ReplaceAll(value, "\\", "/"), "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

// windowsAbsolute recognises `C:\dir` and `\\server\share`. A Host on Linux
// still records sessions for Windows execution hosts, so the shape is accepted
// by spelling rather than by the Host's own operating system.
func windowsAbsolute(value string) bool {
	if strings.HasPrefix(value, `\\`) {
		return true
	}
	return len(value) >= 3 && value[1] == ':' && (value[2] == '\\' || value[2] == '/') &&
		((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z'))
}

// text screens a free-form value a person may have chosen: bounded, no NUL. It
// is not held to the identifier alphabet, because refusing a host somebody
// called 构建机 would make the domain unusable in the installations it exists
// for.
func text(value string, max int) bool {
	return len(value) <= max && !strings.ContainsRune(value, 0)
}

// LaunchDigest is the frozen definition's fingerprint (§3.3
// `session.launch_sha256`).
//
// It covers the directory, the shell, the command, the argv, the SSH target and
// the agent identity — everything that decides which program runs — and nothing
// that moves on its own. No timestamps, no generation, no revision: a digest
// that changed every time a session was observed would make the switch check
// that compares two sides permanently false.
//
// Environment values are absent by construction; only the names are in the
// launch at all, and a name is part of the decision while a value is a secret
// belonging to the machine that has it.
func LaunchDigest(launch *pb.SessionLaunch) []byte {
	digest := sha256.New()
	part := func(value string) {
		var size [8]byte
		size[7] = byte(len(value))
		size[6] = byte(len(value) >> 8)
		size[5] = byte(len(value) >> 16)
		size[4] = byte(len(value) >> 24)
		digest.Write(size[:])
		digest.Write([]byte(value))
	}
	part("armadra.session.launch.v1")
	part(launch.GetWorkingDirectory())
	part(launch.GetShell())
	part(launch.GetCommand())
	for _, arg := range launch.GetArgs() {
		part(arg)
	}
	part(launch.GetSshTargetId())
	agent := launch.GetAgent()
	part(agent.GetAgentId())
	part(agent.GetWorkingDirectory())
	for _, arg := range agent.GetArgs() {
		part(arg)
	}
	part(agent.GetPermissionMode())
	part(agent.GetModelId())
	part(agent.GetAccountId())
	for _, name := range launch.GetEnvRefs() {
		part(name)
	}
	return digest.Sum(nil)
}

// freeze validates a launch and stamps its digest. A launch this Host cannot
// store faithfully is refused rather than truncated: a session started from a
// shortened argv is a different program from the one that was approved.
func freeze(launch *pb.SessionLaunch) (*pb.SessionLaunch, error) {
	if launch == nil || !validPath(launch.GetWorkingDirectory()) {
		return nil, ErrInvalid
	}
	if !text(launch.GetShell(), MaxArgBytes) || !text(launch.GetCommand(), MaxArgBytes) ||
		!text(launch.GetSshTargetId(), 256) {
		return nil, ErrInvalid
	}
	if len(launch.GetArgs()) > MaxLaunchArgs || len(launch.GetEnvRefs()) > MaxLaunchArgs {
		return nil, ErrInvalid
	}
	for _, arg := range launch.GetArgs() {
		if !text(arg, MaxArgBytes) {
			return nil, ErrInvalid
		}
	}
	for _, name := range launch.GetEnvRefs() {
		// A name, not a value. A caller that put a token here would be putting
		// a secret into the Host's database, so the shape is held to what an
		// environment variable name can be.
		if name == "" || len(name) > 256 || strings.ContainsAny(name, "=\x00") {
			return nil, ErrInvalid
		}
	}
	if agent := launch.GetAgent(); agent != nil {
		if !validID(agent.GetAgentId()) || len(agent.GetArgs()) > MaxLaunchArgs {
			return nil, ErrInvalid
		}
		if agent.GetWorkingDirectory() != "" && !validPath(agent.GetWorkingDirectory()) {
			return nil, ErrInvalid
		}
		for _, arg := range agent.GetArgs() {
			if !text(arg, MaxArgBytes) {
				return nil, ErrInvalid
			}
		}
	}
	frozen, _ := proto.Clone(launch).(*pb.SessionLaunch)
	frozen.LaunchSha256 = LaunchDigest(frozen)
	return frozen, nil
}

// message is the stored row as the contract sees it. The revision comes from
// the row, never from a copy inside the payload: keeping two would let them
// drift, and the row is what the CAS is checked against.
func message(session storage.Session) *pb.Session {
	value := &pb.Session{
		SessionId:          session.SessionID,
		WorkspaceId:        session.WorkspaceID,
		ExecutionHostId:    session.ExecutionHostID,
		SessionKey:         session.SessionKey,
		OwnerNodeId:        session.OwnerNodeID,
		BackendKind:        session.BackendKind,
		Generation:         session.Generation,
		Kind:               pb.SessionKind(session.Kind),
		Status:             pb.SessionStatus(session.Status),
		AttachState:        pb.SessionAttachState(session.AttachState),
		TerminationIntent:  pb.TerminationIntent(session.Intent),
		ReasonCode:         session.ReasonCode,
		CreatedAtUnixMs:    session.CreatedAtMS,
		UpdatedAtUnixMs:    session.UpdatedAtMS,
		EndedAtUnixMs:      session.EndedAtMS,
		LastOutputAtUnixMs: session.LastOutputMS,
		Revision:           session.Revision,
		Deleted:            session.Deleted,
	}
	if session.ExitCode != nil {
		code := *session.ExitCode
		value.ExitCode = &code
	}
	// A tombstone carries no launch at all, not an empty one: "this session is
	// gone" and "this session runs nothing" are different statements.
	if !session.Deleted && len(session.Launch) > 0 {
		launch := new(pb.SessionLaunch)
		if proto.Unmarshal(session.Launch, launch) == nil {
			value.Launch = launch
		}
	}
	return value
}

func runMessage(run storage.SessionRun) *pb.SessionRun {
	value := &pb.SessionRun{
		SessionId:        run.SessionID,
		Generation:       run.Generation,
		WorkerInstanceId: run.WorkerInstanceID,
		BackendRef:       run.BackendRef,
		ReasonCode:       run.ReasonCode,
		StartedAtUnixMs:  run.StartedAtMS,
		EndedAtUnixMs:    run.EndedAtMS,
		Revision:         run.Revision,
	}
	if run.ExitCode != nil {
		code := *run.ExitCode
		value.ExitCode = &code
	}
	return value
}

// payload is the entity as it is published on the event stream: the same
// message with the revision cleared, marshalled deterministically so an
// unchanged session produces identical bytes.
func payload(value proto.Message) ([]byte, error) {
	switch typed := value.(type) {
	case *pb.Session:
		clone, _ := proto.Clone(typed).(*pb.Session)
		clone.Revision = 0
		return (proto.MarshalOptions{Deterministic: true}).Marshal(clone)
	case *pb.SessionRun:
		clone, _ := proto.Clone(typed).(*pb.SessionRun)
		clone.Revision = 0
		return (proto.MarshalOptions{Deterministic: true}).Marshal(clone)
	}
	return nil, ErrInvalid
}

// record turns a validated request into the row to store.
func record(value *pb.Session, createdAt, updatedAt int64) (storage.Session, error) {
	if value == nil || !validID(value.GetSessionId()) || !validID(value.GetWorkspaceId()) {
		return storage.Session{}, ErrInvalid
	}
	if !text(value.GetExecutionHostId(), 256) || !text(value.GetBackendKind(), 64) ||
		!text(value.GetReasonCode(), 64) {
		return storage.Session{}, ErrInvalid
	}
	// The logical key is what survives a recycle, so it has to exist. Callers
	// that have a node use the node id; ones that do not use the session id,
	// which is what the Runtime has always done.
	key := value.GetSessionKey()
	if key == "" {
		key = value.GetSessionId()
	}
	if !validID(key) {
		return storage.Session{}, ErrInvalid
	}
	if node := value.GetOwnerNodeId(); node != "" && !validID(node) {
		return storage.Session{}, ErrInvalid
	}
	if value.GetKind() == pb.SessionKind_SESSION_KIND_UNSPECIFIED {
		return storage.Session{}, ErrInvalid
	}
	launch, err := freeze(value.GetLaunch())
	if err != nil {
		return storage.Session{}, err
	}
	encoded, err := (proto.MarshalOptions{Deterministic: true}).Marshal(launch)
	if err != nil {
		return storage.Session{}, err
	}
	session := storage.Session{
		SessionID:       value.GetSessionId(),
		WorkspaceID:     value.GetWorkspaceId(),
		ExecutionHostID: value.GetExecutionHostId(),
		SessionKey:      key,
		OwnerNodeID:     value.GetOwnerNodeId(),
		Kind:            int32(value.GetKind()),
		Status:          int32(value.GetStatus()),
		AttachState:     int32(value.GetAttachState()),
		Intent:          int32(value.GetTerminationIntent()),
		BackendKind:     value.GetBackendKind(),
		Generation:      value.GetGeneration(),
		Launch:          encoded,
		LaunchSHA256:    launch.GetLaunchSha256(),
		ReasonCode:      value.GetReasonCode(),
		CreatedAtMS:     createdAt,
		UpdatedAtMS:     updatedAt,
		EndedAtMS:       value.GetEndedAtUnixMs(),
		LastOutputMS:    value.GetLastOutputAtUnixMs(),
	}
	if value.ExitCode != nil {
		code := value.GetExitCode()
		session.ExitCode = &code
	}
	if session.Status == int32(pb.SessionStatus_SESSION_STATUS_UNSPECIFIED) {
		session.Status = int32(pb.SessionStatus_SESSION_STATUS_PENDING)
	}
	if session.AttachState == int32(pb.SessionAttachState_SESSION_ATTACH_STATE_UNSPECIFIED) {
		session.AttachState = int32(pb.SessionAttachState_SESSION_ATTACH_STATE_DETACHED)
	}
	if session.Intent == int32(pb.TerminationIntent_TERMINATION_INTENT_UNSPECIFIED) {
		session.Intent = int32(pb.TerminationIntent_TERMINATION_INTENT_NONE)
	}
	if session.Payload, err = payload(message(session)); err != nil {
		return storage.Session{}, err
	}
	return session, nil
}

// stamp re-encodes a row's published payload after its fields changed. Every
// mutation goes through it, so a row and the event that announces it can never
// describe different things.
func stamp(session storage.Session) (storage.Session, error) {
	encoded, err := payload(message(session))
	if err != nil {
		return storage.Session{}, err
	}
	session.Payload = encoded
	return session, nil
}

func stampRun(run storage.SessionRun) (storage.SessionRun, error) {
	encoded, err := payload(runMessage(run))
	if err != nil {
		return storage.SessionRun{}, err
	}
	run.Payload = encoded
	return run, nil
}

// receipt is the operation's outcome in the shared shape. Its `revisions` list
// stays empty for the reason the filesystem domain leaves it empty: that list
// exists so a caller can find one object's new revision inside a batch, and a
// session change is always one object, returned in full beside the receipt.
func receipt(result storage.ApplyResult) *pb.CanvasOperationReceipt {
	return &pb.CanvasOperationReceipt{
		OperationId:   result.OperationID,
		TransactionId: result.TransactionID,
		FirstSequence: result.FirstSequence,
		LastSequence:  result.LastSequence,
		Replayed:      result.Replayed,
	}
}
