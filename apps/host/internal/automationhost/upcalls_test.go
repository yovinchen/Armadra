package automationhost

import (
	"context"
	"errors"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/sessionhost"
	"armadra.local/host/internal/storage"
	"armadra.local/host/internal/worker"
)

// observer is a SessionObserver that answers from a script. It records what
// reached it, because "the frame was recorded" and "the session domain heard
// about it" were the same claim before this batch and are not now.
type observer struct {
	seen []*pb.WorkerSessionUpcall
	err  error
}

func (o *observer) ObserveRun(_ context.Context, report *pb.WorkerSessionUpcall) error {
	o.seen = append(o.seen, report)
	return o.err
}

func sessionFrame(sequence uint64, kind pb.WorkerSessionUpcallKind) worker.Upcall {
	return worker.Upcall{
		Frame: &pb.WorkerUpcall{
			RequestId:        "w-1",
			WorkerInstanceId: "worker-a",
			Sequence:         sequence,
			Event: &pb.WorkerUpcall_Session{Session: &pb.WorkerSessionUpcall{
				SessionId:   "session-one",
				WorkspaceId: "workspace-one",
				Kind:        kind,
			}},
		},
		Attempt: 1,
	}
}

// A run report reaches the domain that owns the records it is about, and is
// still recorded raw. Recording alone was the old behaviour, and it left a
// vanished pane RUNNING in the session records forever.
func TestARunReportReachesTheSessionDomain(t *testing.T) {
	store := testStore(t)
	seen := &observer{}
	recorder := upcallRecorder{store: store, hostInstance: "host-1", sessions: seen}

	if err := recorder.Deliver(testContext, sessionFrame(1, pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_LOST)); err != nil {
		t.Fatal(err)
	}
	if len(seen.seen) != 1 || seen.seen[0].GetSessionId() != "session-one" {
		t.Fatalf("the report did not reach the session domain: %+v", seen.seen)
	}
	if _, err := store.Read(testContext, storage.Key{Kind: UpcallEntityKind, ID: "worker-a/1", WorkspaceID: "workspace-one"}); err != nil {
		t.Fatalf("the raw frame was not recorded: %v", err)
	}
}

// A Host with no session service still accepts the frame. The Worker retires it
// from its outbox on the strength of the acknowledgement, so refusing here
// would lose the report to buy nothing.
func TestAHostWithoutASessionServiceStillAcceptsTheFrame(t *testing.T) {
	store := testStore(t)
	recorder := upcallRecorder{store: store, hostInstance: "host-1"}
	if err := recorder.Deliver(testContext, sessionFrame(1, pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_EXITED)); err != nil {
		t.Fatal(err)
	}
}

// A report about a session no record exists for cannot be made true by
// replaying it, so it is named unacceptable and dropped. Anything else is left
// unacknowledged, because a locked database is a reason to come back.
func TestAPermanentRefusalIsToldFromATransientOne(t *testing.T) {
	store := testStore(t)
	permanent := upcallRecorder{store: store, hostInstance: "host-1", sessions: &observer{err: sessionhost.ErrUnknownSession}}
	err := permanent.Deliver(testContext, sessionFrame(1, pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_LOST))
	if !errors.Is(err, worker.ErrUpcallUnacceptable) {
		t.Fatalf("a report nobody can ever apply was not dropped: %v", err)
	}

	transient := upcallRecorder{store: store, hostInstance: "host-1", sessions: &observer{err: context.DeadlineExceeded}}
	err = transient.Deliver(testContext, sessionFrame(2, pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_LOST))
	if err == nil || errors.Is(err, worker.ErrUpcallUnacceptable) {
		t.Fatalf("a transient failure was treated as permanent: %v", err)
	}
	// And nothing was recorded, so the replay lands on a fresh id rather than a
	// revision conflict that would report success.
	if _, err = store.Read(testContext, storage.Key{Kind: UpcallEntityKind, ID: "worker-a/2", WorkspaceID: "workspace-one"}); err == nil {
		t.Fatal("a frame that was not applied was recorded anyway")
	}
}

// A replay after a Host restart projects again before it finds the record it
// already wrote. Every projection is idempotent, so doing it twice is free —
// and doing it *only* after the record would let a Host that died between the
// two writes drop the report.
func TestAReplayProjectsBeforeItFindsItsOwnRecord(t *testing.T) {
	store := testStore(t)
	seen := &observer{}
	recorder := upcallRecorder{store: store, hostInstance: "host-1", sessions: seen}
	frame := sessionFrame(7, pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_LOST)
	if err := recorder.Deliver(testContext, frame); err != nil {
		t.Fatal(err)
	}
	replay := sessionFrame(7, pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_LOST)
	replay.Attempt = 2
	if err := recorder.Deliver(testContext, replay); err != nil {
		t.Fatalf("a replay was refused: %v", err)
	}
	if len(seen.seen) != 2 {
		t.Fatalf("the replay did not reach the domain: %d", len(seen.seen))
	}
}
