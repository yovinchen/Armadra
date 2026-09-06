package sessionhost

import (
	"context"
	"errors"
	"strconv"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// Runs: asking the execution host to start, stop and account for processes
// (Go Host 业务所有权迁移 §2.6 Worker 通道, §5.3 会话重认领三方).
//
// Every function here follows one shape, and the order is the point:
//
//  1. ask the Worker,
//  2. record what it said.
//
// Never the reverse. A Host that recorded RUNNING first and then asked would,
// on any failure in between, be holding a record of a process that does not
// exist — and the client's next act would be to attach to it. Recording second
// means the worst case is a run the Worker holds and this Host has not written
// down yet, which is exactly the case `ReclaimRuns` exists to resolve.
//
// The one thing that is recorded before the ask is STARTING, and only because
// it is true: a start has been decided, and the client is entitled to see that
// rather than a session that appears to do nothing for a second.

// runState is a session plus the run that backs it, as they now stand.
type runState struct {
	session *pb.Session
	run     *pb.SessionRun
}

// reasonFor spells why a run ended, in the execution host's own vocabulary.
// It is carried as a reason code rather than folded into TerminationIntent
// because the Runtime's four words (`none`, `process`, `session`, `recycle`)
// do not map onto the enum's four values one-for-one — `process` and `session`
// are both a user's intent and different kills — and a rollback has to put the
// exact word back into the row it came from.
func reasonFor(mode string) string {
	switch mode {
	case "interrupt", "process", "session", "recycle", "none":
		return "session.termination." + mode
	default:
		return ""
	}
}

// intentFor is the enum a client renders for one of those words. It is lossy on
// purpose and never the storage of record: `reason_code` keeps the word.
func intentFor(mode string) pb.TerminationIntent {
	switch mode {
	case "recycle":
		return pb.TerminationIntent_TERMINATION_INTENT_RECYCLE
	case "interrupt", "process", "session":
		return pb.TerminationIntent_TERMINATION_INTENT_USER
	default:
		return pb.TerminationIntent_TERMINATION_INTENT_NONE
	}
}

// modeOf recovers the Runtime's word from a stored reason code, so a reverse
// export writes back the value the row had rather than one derived from the
// enum. An unrecognised code answers empty, and the exporter falls back to the
// enum — a lossy answer being better than a wrong one.
func modeOf(reasonCode string) string {
	const prefix = "session.termination."
	if len(reasonCode) <= len(prefix) || reasonCode[:len(prefix)] != prefix {
		return ""
	}
	mode := reasonCode[len(prefix):]
	if reasonFor(mode) == "" {
		return ""
	}
	return mode
}

// startRun asks the Worker for a run and records it. `recycle` distinguishes
// the two callers: a start expects no live run, a recycle expects one and asks
// for it to be replaced.
//
// The CAS is checked once, at the STARTING write, and the run that follows is
// recorded under the revision that write produced. That is what makes two
// clients pressing start at the same moment produce one process: the second one
// loses the CAS before any Worker is asked.
func (s *Service) startRun(ctx context.Context, session storage.Session, operationID string, expected uint64, recycle bool) (runState, *pb.CanvasOperationReceipt, error) {
	if operationID == "" {
		return runState{}, nil, ErrInvalid
	}
	runner, done, err := s.open(ctx, session.ExecutionHostID)
	if err != nil {
		return runState{}, nil, err
	}
	defer done()

	// STARTING is written first because it is true and because it is the CAS.
	// A client watching the session sees the decision land rather than a
	// record that appears inert while a process is being created.
	starting := session
	starting.Status = int32(pb.SessionStatus_SESSION_STATUS_STARTING)
	starting.AttachState = int32(pb.SessionAttachState_SESSION_ATTACH_STATE_DETACHED)
	starting.Intent = int32(pb.TerminationIntent_TERMINATION_INTENT_NONE)
	starting.ExitCode, starting.EndedAtMS = nil, 0
	starting.ReasonCode = ""
	// A session that is starting has no run yet, so the fields that describe
	// one are cleared. That is honest — nothing has been created — and it is
	// also what makes this write replayable: the idempotency digest covers the
	// stored columns, so leaving the previous run's generation and backend in
	// place would make a retry after a successful start look like a different
	// request and be refused as a reused operation id.
	starting.Generation, starting.BackendKind, starting.LastOutputMS = 0, "", 0
	if recycle {
		starting.Intent = int32(pb.TerminationIntent_TERMINATION_INTENT_RECYCLE)
		starting.ReasonCode = reasonFor("recycle")
	}
	starting.UpdatedAtMS = s.now()
	if starting, err = stamp(starting); err != nil {
		return runState{}, nil, err
	}
	result, err := s.store.PutSession(ctx, operationID+"/starting", starting, expected)
	if err != nil {
		return runState{}, nil, err
	}
	// A replayed start must not ask the Worker a second time. The receipt says
	// this decision already reached the database, so the answer is what is
	// already recorded.
	if result.Replayed {
		return s.currentState(ctx, session.SessionID, result)
	}

	launch := new(pb.SessionLaunch)
	if len(starting.Launch) > 0 && proto.Unmarshal(starting.Launch, launch) != nil {
		return runState{}, nil, storage.ErrCorrupt
	}
	var state *pb.WorkerSessionState
	if recycle {
		state, err = runner.SignalRun(ctx, &pb.SignalSessionRunRequest{
			SessionId:  session.SessionID,
			Generation: session.Generation,
			Mode:       "recycle",
		})
	} else {
		state, err = runner.StartRun(ctx, &pb.StartSessionRunRequest{
			SessionId:   session.SessionID,
			WorkspaceId: session.WorkspaceID,
			SessionKey:  session.SessionKey,
			OwnerNodeId: session.OwnerNodeID,
			Launch:      launch,
			Kind:        pb.SessionKind(session.Kind),
		})
	}
	if err != nil {
		// The Worker refused or could not be reached. The session is recorded
		// as LOST rather than EXITED, because nobody watched anything end —
		// and a LOST session is one a reclaim can resolve, where an EXITED one
		// invites a second process on top of a first.
		return runState{}, nil, errors.Join(s.markLost(ctx, starting, result.LastSequence), err)
	}
	return s.recordRun(ctx, starting, state, operationID)
}

// recordRun writes what the Worker reported: the run row first, then the
// session that points at it.
//
// That order matters on a crash. A session claiming generation 5 with no run
// row is a record whose generation nothing accounts for, which a reclaim cannot
// tell from a stale one; a run row nobody points at yet is simply history that
// arrived early.
func (s *Service) recordRun(ctx context.Context, session storage.Session, state *pb.WorkerSessionState, operationID string) (runState, *pb.CanvasOperationReceipt, error) {
	if state == nil || state.GetGeneration() == 0 {
		return runState{}, nil, storage.ErrCorrupt
	}
	now := s.now()
	run := storage.SessionRun{
		SessionID:        session.SessionID,
		Generation:       state.GetGeneration(),
		WorkerInstanceID: state.GetWorkerInstanceId(),
		BackendRef:       state.GetBackendRef(),
		StartedAtMS:      now,
	}
	if started := state.GetCreatedAtUnixMs(); started > 0 {
		run.StartedAtMS = started
	}
	run, err := stampRun(run)
	if err != nil {
		return runState{}, nil, err
	}
	if _, err = s.store.PutSessionRun(ctx, operationID+"/run", run); err != nil {
		return runState{}, nil, err
	}
	if state.GetWorkerInstanceId() != "" {
		// Which Worker instance now speaks for this execution host. It is what
		// makes a later EXITED/LOST decision a reading rather than a guess.
		if err = s.store.PutSessionClaim(ctx, storage.SessionClaim{
			ExecutionHostID:  session.ExecutionHostID,
			WorkerInstanceID: state.GetWorkerInstanceId(),
			ClaimedAtMS:      now,
		}); err != nil {
			return runState{}, nil, err
		}
	}
	running := session
	running.Generation = state.GetGeneration()
	running.BackendKind = state.GetBackendKind()
	running.Status = int32(pb.SessionStatus_SESSION_STATUS_RUNNING)
	running.AttachState = int32(state.GetAttachState())
	if running.AttachState == int32(pb.SessionAttachState_SESSION_ATTACH_STATE_UNSPECIFIED) {
		running.AttachState = int32(pb.SessionAttachState_SESSION_ATTACH_STATE_DETACHED)
	}
	running.ExitCode, running.EndedAtMS = nil, 0
	running.UpdatedAtMS = now
	if running, err = stamp(running); err != nil {
		return runState{}, nil, err
	}
	result, err := s.store.PutSession(ctx, operationID+"/running", running, session.Revision+1)
	if err != nil {
		return runState{}, nil, err
	}
	stored, err := s.store.GetSession(ctx, session.SessionID)
	if err != nil {
		return runState{}, nil, err
	}
	return runState{session: message(stored), run: runMessage(run)}, receipt(result), nil
}

// markLost records a session whose Worker did not answer. It is a separate,
// small write rather than part of the failure path's error, because the state
// is the thing a client needs: LOST is drawn as "waiting to be recovered", and
// a reclaim resolves it into RUNNING or EXITED once somebody can see the
// machine again.
func (s *Service) markLost(ctx context.Context, session storage.Session, sequence uint64) error {
	lost := session
	lost.Status = int32(pb.SessionStatus_SESSION_STATUS_LOST)
	lost.AttachState = int32(pb.SessionAttachState_SESSION_ATTACH_STATE_DETACHED)
	lost.ReasonCode = "session.run.unreachable"
	lost.UpdatedAtMS = s.now()
	stamped, err := stamp(lost)
	if err != nil {
		return err
	}
	_, err = s.store.PutSession(ctx, "session/"+session.SessionID+"/lost/"+strconv.FormatUint(sequence, 10), stamped, session.Revision+1)
	return err
}

// currentState reads back a session and its run, for a replayed operation.
func (s *Service) currentState(ctx context.Context, sessionID string, result storage.ApplyResult) (runState, *pb.CanvasOperationReceipt, error) {
	stored, err := s.store.GetSession(ctx, sessionID)
	if err != nil {
		return runState{}, nil, err
	}
	state := runState{session: message(stored)}
	if stored.Generation > 0 {
		run, err := s.store.GetSessionRun(ctx, sessionID, stored.Generation)
		if err == nil {
			state.run = runMessage(run)
		} else if !errors.Is(err, storage.ErrNotFound) {
			return runState{}, nil, err
		}
	}
	return state, receipt(result), nil
}

// terminate signals the run and records the outcome.
//
// A signal aimed at a generation the execution host has already replaced is
// refused rather than applied to the current one. That refusal is the whole
// reason a generation is a number and not a boolean: "stop what I am looking
// at" must never become "stop whatever is there now".
func (s *Service) terminate(ctx context.Context, session storage.Session, request *pb.TerminateSessionRequest) (*pb.Session, *pb.CanvasOperationReceipt, error) {
	mode := request.GetMode()
	if mode == "" {
		mode = "process"
	}
	if reasonFor(mode) == "" || mode == "recycle" {
		// `recycle` is not a termination: it has its own method, because
		// terminate-then-start is not the same thing and a client that died
		// between the two would leave a session recorded as running with no
		// process behind it.
		return nil, nil, ErrInvalid
	}
	runner, done, err := s.open(ctx, session.ExecutionHostID)
	if err != nil {
		return nil, nil, err
	}
	defer done()
	state, err := runner.SignalRun(ctx, &pb.SignalSessionRunRequest{
		SessionId:  session.SessionID,
		Generation: session.Generation,
		Mode:       mode,
	})
	if err != nil {
		return nil, nil, err
	}
	now := s.now()
	ended := session
	ended.UpdatedAtMS = now
	ended.ReasonCode = reasonFor(mode)
	if intent := request.GetIntent(); intent != pb.TerminationIntent_TERMINATION_INTENT_UNSPECIFIED {
		ended.Intent = int32(intent)
	} else {
		ended.Intent = int32(intentFor(mode))
	}
	// An interrupt stops the foreground program and leaves the shell. The
	// session is still running, and recording it as ended would make the pane
	// the user is still typing into look dead.
	if mode == "interrupt" {
		if state != nil && state.GetStatus() != pb.SessionStatus_SESSION_STATUS_UNSPECIFIED {
			ended.Status = int32(state.GetStatus())
		}
		if ended, err = stamp(ended); err != nil {
			return nil, nil, err
		}
		value, receipt, err := s.put(ctx, request.GetOperationId(), ended, request.GetExpectedRevision())
		return value, receipt, err
	}
	ended.Status = int32(pb.SessionStatus_SESSION_STATUS_EXITED)
	ended.AttachState = int32(pb.SessionAttachState_SESSION_ATTACH_STATE_EXITED)
	ended.EndedAtMS = now
	if state != nil && state.ExitCode != nil {
		code := state.GetExitCode()
		ended.ExitCode = &code
	}
	if ended, err = stamp(ended); err != nil {
		return nil, nil, err
	}
	value, receipt, err := s.put(ctx, request.GetOperationId(), ended, request.GetExpectedRevision())
	if err != nil {
		return nil, nil, err
	}
	// The run's ending is history, and it is recorded after the session so a
	// crash leaves a run that outlived its record rather than a record that
	// points at a run nobody closed.
	if session.Generation > 0 {
		if err = s.closeRun(ctx, session, ended, request.GetOperationId()); err != nil {
			return nil, nil, err
		}
	}
	return value, receipt, nil
}

func (s *Service) closeRun(ctx context.Context, session, ended storage.Session, operationID string) error {
	run, err := s.store.GetSessionRun(ctx, session.SessionID, session.Generation)
	if errors.Is(err, storage.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	run.EndedAtMS = ended.EndedAtMS
	run.ExitCode = ended.ExitCode
	run.ReasonCode = ended.ReasonCode
	if run, err = stampRun(run); err != nil {
		return err
	}
	_, err = s.store.PutSessionRun(ctx, operationID+"/run-ended", run)
	return err
}
