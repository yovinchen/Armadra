package sessionhost

import (
	"context"
	"errors"
	"strconv"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// Reconciling three parties: this Host's records, the Worker's records, and the
// processes that are actually there (Go Host 业务所有权迁移 §5.3, §6.2 session 行).
//
// After a restart on either side, three things can disagree. The rule that
// resolves them is one-directional and stated once, here:
//
//	**The execution host's listing is the truth about processes. This Host's
//	records are a projection of it, never a correction to it.**
//
// So a reclaim never kills anything and never starts anything. It reads what
// the machine holds and writes down what it saw, which means the only outcomes
// are RUNNING, EXITED and LOST — and the distinction between the last two is
// the entire reason this function exists.
//
// A session the Worker *answered about* and did not list has ended: somebody
// was in a position to watch, and did not see it. A session on a machine whose
// Worker did not answer at all is LOST: nobody watched, the tmux server is very
// likely still running with every pane intact, and calling that EXITED would
// invite a client to start a second program on top of the first.
//
// Generation is what makes the RUNNING case decidable. A Worker that restarted
// reports a *higher* generation for the same logical key — it created a new
// pane — and the old socket sees a stale generation and reconnects. A Worker
// that merely reconnected reports the same generation, and everything anybody
// was typing into keeps working. This Host records the number either way; it
// never invents one, because it never created a pane.

// ReclaimOutcome is what one reclaim changed. It is returned rather than logged
// because a switch and an operator both want to see it, and "nothing changed"
// is a meaningful answer.
type ReclaimOutcome struct {
	// Reconciled is every session the Worker listed and this Host now agrees
	// about.
	Reconciled []string
	// Ended is the sessions the Worker was in a position to see and did not
	// list. They are recorded EXITED.
	Ended []string
	// Lost is the sessions on a machine that did not answer. They are recorded
	// LOST, which is a state a later reclaim can still resolve.
	Lost []string
	// Regenerated is the sessions whose generation moved: a Worker restarted
	// and created a new pane under the same logical key.
	Regenerated []string
}

// Reclaim reconciles this Host's session records with what one execution host
// actually holds.
//
// It is called after a switch settles (the Host has just taken over records for
// processes it did not start), and it is safe to call at any other time: it is
// idempotent, because it only ever writes what it read.
func (s *Service) Reclaim(ctx context.Context, executionHostID string) (ReclaimOutcome, error) {
	var outcome ReclaimOutcome
	sessions, err := s.store.AllSessions(ctx)
	if err != nil {
		return outcome, err
	}
	// Only the live sessions on this machine are this reclaim's business. A
	// tombstone is a closed intent, and a session on another execution host is
	// answered by that host's Worker.
	mine := make([]storage.Session, 0, len(sessions))
	for _, session := range sessions {
		if session.Deleted || session.ExecutionHostID != executionHostID {
			continue
		}
		if session.Status == int32(pb.SessionStatus_SESSION_STATUS_PENDING) {
			// Never started, so there is nothing to reconcile: a pending
			// session is an intent, and a Worker that has never heard of it is
			// exactly what "not started" means.
			continue
		}
		mine = append(mine, session)
	}
	if len(mine) == 0 {
		return outcome, nil
	}

	runner, done, err := s.open(ctx, executionHostID)
	if err != nil {
		// Nobody can see this machine. Every session on it is LOST, not
		// ended — and the reclaim reports that rather than failing, because a
		// Host that refused to record anything would leave the sessions
		// claiming to be RUNNING behind a Worker that is gone.
		for _, session := range mine {
			if lostErr := s.reclaimLost(ctx, session); lostErr != nil {
				return outcome, lostErr
			}
			outcome.Lost = append(outcome.Lost, session.SessionID)
		}
		return outcome, nil
	}
	defer done()

	identifiers := make([]string, 0, len(mine))
	for _, session := range mine {
		identifiers = append(identifiers, session.SessionID)
	}
	states, err := runner.ReclaimRuns(ctx, identifiers)
	if err != nil {
		for _, session := range mine {
			if lostErr := s.reclaimLost(ctx, session); lostErr != nil {
				return outcome, errors.Join(err, lostErr)
			}
			outcome.Lost = append(outcome.Lost, session.SessionID)
		}
		return outcome, nil
	}

	held := map[string]*pb.WorkerSessionState{}
	for _, state := range states.GetSessions() {
		held[state.GetSessionId()] = state
	}
	instance := states.GetWorkerInstanceId()
	if instance != "" {
		if err = s.store.PutSessionClaim(ctx, storage.SessionClaim{
			ExecutionHostID:  executionHostID,
			WorkerInstanceID: instance,
			ClaimedAtMS:      s.now(),
		}); err != nil {
			return outcome, err
		}
	}
	for _, session := range mine {
		state, ok := held[session.SessionID]
		if !ok {
			// The Worker answered and did not list it. Somebody was watching,
			// so this is an ending rather than a disappearance.
			if err = s.reclaimEnded(ctx, session); err != nil {
				return outcome, err
			}
			outcome.Ended = append(outcome.Ended, session.SessionID)
			continue
		}
		moved, err := s.reclaimHeld(ctx, session, state, instance)
		if err != nil {
			return outcome, err
		}
		outcome.Reconciled = append(outcome.Reconciled, session.SessionID)
		if moved {
			outcome.Regenerated = append(outcome.Regenerated, session.SessionID)
		}
	}
	return outcome, nil
}

// reclaimHeld records a session the Worker still holds, and reports whether its
// generation moved.
//
// A generation that moved is a new pane, so it gets a new run row: the old one
// stays as history, which is what lets an operator see that a Worker restart
// replaced somebody's shell rather than that it never happened.
func (s *Service) reclaimHeld(ctx context.Context, session storage.Session, state *pb.WorkerSessionState, instance string) (bool, error) {
	generation := state.GetGeneration()
	moved := generation != 0 && generation != session.Generation
	now := s.now()
	if moved {
		run := storage.SessionRun{
			SessionID:        session.SessionID,
			Generation:       generation,
			WorkerInstanceID: instance,
			BackendRef:       state.GetBackendRef(),
			ReasonCode:       "session.run.reclaimed",
			StartedAtMS:      now,
		}
		if started := state.GetCreatedAtUnixMs(); started > 0 {
			run.StartedAtMS = started
		}
		stamped, err := stampRun(run)
		if err != nil {
			return false, err
		}
		if _, err = s.store.PutSessionRun(ctx, "session/"+session.SessionID+"/reclaim/"+strconv.FormatUint(generation, 10), stamped); err != nil {
			return false, err
		}
	}
	next := session
	next.Generation = generation
	if generation == 0 {
		next.Generation = session.Generation
	}
	next.Status = int32(state.GetStatus())
	if next.Status == int32(pb.SessionStatus_SESSION_STATUS_UNSPECIFIED) {
		next.Status = int32(pb.SessionStatus_SESSION_STATUS_RUNNING)
	}
	next.AttachState = int32(state.GetAttachState())
	if next.AttachState == int32(pb.SessionAttachState_SESSION_ATTACH_STATE_UNSPECIFIED) {
		next.AttachState = int32(pb.SessionAttachState_SESSION_ATTACH_STATE_DETACHED)
	}
	if kind := state.GetBackendKind(); kind != "" {
		next.BackendKind = kind
	}
	if output := state.GetLastOutputAtUnixMs(); output > 0 {
		next.LastOutputMS = output
	}
	next.ExitCode = nil
	if state.ExitCode != nil {
		code := state.GetExitCode()
		next.ExitCode = &code
	}
	// The reason code is stamped only when something actually differs, so it
	// stays out of the comparison below: a reclaim that set it unconditionally
	// would make every session look changed and defeat the check.
	next.UpdatedAtMS = now
	// A reclaim writes only when something changed. Re-publishing an unchanged
	// session would tell every connected client that every terminal moved,
	// every time a Host restarted.
	if same(session, next) {
		return moved, nil
	}
	next.ReasonCode = "session.run.reclaimed"
	stamped, err := stamp(next)
	if err != nil {
		return false, err
	}
	_, err = s.store.PutSession(ctx, "session/"+session.SessionID+"/reclaim/"+strconv.FormatUint(next.Generation, 10)+"/"+strconv.FormatUint(session.Revision, 10), stamped, session.Revision)
	return moved, err
}

// reclaimEnded records a session the Worker could see and did not have.
func (s *Service) reclaimEnded(ctx context.Context, session storage.Session) error {
	if session.Status == int32(pb.SessionStatus_SESSION_STATUS_EXITED) {
		return nil
	}
	ended := session
	ended.Status = int32(pb.SessionStatus_SESSION_STATUS_EXITED)
	ended.AttachState = int32(pb.SessionAttachState_SESSION_ATTACH_STATE_EXITED)
	ended.ReasonCode = "session.run.gone"
	ended.UpdatedAtMS = s.now()
	if ended.EndedAtMS == 0 {
		ended.EndedAtMS = ended.UpdatedAtMS
	}
	stamped, err := stamp(ended)
	if err != nil {
		return err
	}
	_, err = s.store.PutSession(ctx, "session/"+session.SessionID+"/ended/"+strconv.FormatUint(session.Revision, 10), stamped, session.Revision)
	return err
}

// reclaimLost records a session on a machine nobody could reach. It is not an
// ending, and the reason code says which.
func (s *Service) reclaimLost(ctx context.Context, session storage.Session) error {
	if session.Status == int32(pb.SessionStatus_SESSION_STATUS_LOST) ||
		session.Status == int32(pb.SessionStatus_SESSION_STATUS_EXITED) {
		return nil
	}
	lost := session
	lost.Status = int32(pb.SessionStatus_SESSION_STATUS_LOST)
	lost.AttachState = int32(pb.SessionAttachState_SESSION_ATTACH_STATE_DETACHED)
	lost.ReasonCode = "session.run.unreachable"
	lost.UpdatedAtMS = s.now()
	stamped, err := stamp(lost)
	if err != nil {
		return err
	}
	_, err = s.store.PutSession(ctx, "session/"+session.SessionID+"/lost/"+strconv.FormatUint(session.Revision, 10), stamped, session.Revision)
	return err
}

// same compares the fields a reclaim can change. Timestamps and the revision
// are excluded: they are how the record was reached, not what it says.
func same(left, right storage.Session) bool {
	if (left.ExitCode == nil) != (right.ExitCode == nil) {
		return false
	}
	if left.ExitCode != nil && *left.ExitCode != *right.ExitCode {
		return false
	}
	return left.Generation == right.Generation && left.Status == right.Status &&
		left.AttachState == right.AttachState && left.BackendKind == right.BackendKind &&
		left.ReasonCode == right.ReasonCode && left.LastOutputMS == right.LastOutputMS
}
