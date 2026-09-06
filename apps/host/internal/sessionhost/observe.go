package sessionhost

import (
	"context"
	"errors"
	"strconv"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// The Worker's own report about a run, landing (business migration §2.6, Worker
// upcall 140).
//
// `Reclaim` asks. This is told. The difference matters at exactly one point: a
// reclaim can only ever see the state a machine is in *when it is asked*, so a
// pane that started and died between two passes is invisible to it. An upcall
// is the machine saying "this just happened", which is the only way that pane's
// end is ever learned.
//
// The one-directional rule is unchanged and is the reason nothing here decides
// anything: the execution host observed it, this Host writes it down. In
// particular RUN_LOST is **not** folded into EXITED. The Worker is saying it
// went looking and the pane was not where it left it — nobody watched it end,
// the tmux server is very likely still up with the pane intact, and telling a
// client it exited would invite a second program on top of the first.
//
// Two guards, both about identity rather than about content:
//
//   - a report about a **generation this Host has already replaced** is
//     recorded as nothing. It is true about a pane that no longer exists, and
//     applying it would move the pane that replaced it.
//   - a report about a session this Host has **no record of** is refused as
//     unacceptable rather than left unacknowledged, because replaying it
//     forever cannot make the record appear.
//
// Everything here is idempotent by construction: a replayed frame reaches the
// same comparison and writes nothing, so the Worker's outbox can retry as often
// as it likes without republishing a session to every connected client.

// ErrUnknownSession is a report about a session this Host does not have. The
// caller turns it into a permanent refusal: retrying cannot help.
var ErrUnknownSession = errors.New("no session record for this run report")

// ObserveRun records one Worker→Host run report.
func (s *Service) ObserveRun(ctx context.Context, report *pb.WorkerSessionUpcall) error {
	if s == nil || report == nil || report.GetSessionId() == "" {
		return ErrInvalid
	}
	session, err := s.store.GetSession(ctx, report.GetSessionId())
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return ErrUnknownSession
		}
		return err
	}
	if session.Deleted {
		// A closed intent. The pane may well have ended; there is no record
		// left for that to be true of.
		return nil
	}
	// A generation of zero is a Worker that did not say which pane it meant.
	// It is taken as "the current one" rather than refused, because the older
	// upcalls the session bridge already sends leave it unset.
	if generation := report.GetGeneration(); generation != 0 && generation < session.Generation {
		return nil
	}
	next := session
	switch report.GetKind() {
	case pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_STARTED:
		next.Status = int32(pb.SessionStatus_SESSION_STATUS_RUNNING)
		next.ReasonCode = "session.run.started"
		next.ExitCode = nil
		next.EndedAtMS = 0
	case pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_EXITED:
		next.Status = int32(pb.SessionStatus_SESSION_STATUS_EXITED)
		next.AttachState = int32(pb.SessionAttachState_SESSION_ATTACH_STATE_EXITED)
		next.ReasonCode = "session.run.exited"
		next.ExitCode = nil
		if report.ExitCode != nil {
			code := report.GetExitCode()
			next.ExitCode = &code
		}
	case pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_LOST:
		// Already ended is not downgraded to lost: somebody *did* watch that
		// one end, and "nobody could see it" is the weaker statement.
		if session.Status == int32(pb.SessionStatus_SESSION_STATUS_EXITED) {
			return nil
		}
		next.Status = int32(pb.SessionStatus_SESSION_STATUS_LOST)
		next.AttachState = int32(pb.SessionAttachState_SESSION_ATTACH_STATE_DETACHED)
		next.ReasonCode = "session.run.unreachable"
	case pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_ATTACH_COUNT_CHANGED:
		// Not a lifecycle change. Only the attach state moves, and a report
		// that carries none moves nothing.
		if report.GetAttachState() == pb.SessionAttachState_SESSION_ATTACH_STATE_UNSPECIFIED {
			return nil
		}
	default:
		// A kind this build does not know is not guessed at. It stays recorded
		// as a raw upcall by the caller and changes no session.
		return nil
	}
	if state := report.GetAttachState(); state != pb.SessionAttachState_SESSION_ATTACH_STATE_UNSPECIFIED &&
		report.GetKind() != pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_EXITED {
		next.AttachState = int32(state)
	}
	if generation := report.GetGeneration(); generation > next.Generation {
		next.Generation = generation
	}
	if same(session, next) {
		return nil
	}
	now := s.now()
	next.UpdatedAtMS = now
	if next.Status == int32(pb.SessionStatus_SESSION_STATUS_EXITED) && next.EndedAtMS == 0 {
		next.EndedAtMS = now
	}
	stamped, err := stamp(next)
	if err != nil {
		return err
	}
	// The operation id names the frame's own subject, so a replay of the same
	// report is the same operation rather than a second one.
	operation := "session/" + session.SessionID + "/observed/" +
		strconv.Itoa(int(report.GetKind())) + "/" +
		strconv.FormatUint(next.Generation, 10) + "/" +
		strconv.FormatUint(session.Revision, 10)
	_, err = s.store.PutSession(ctx, operation, stamped, session.Revision)
	return err
}
