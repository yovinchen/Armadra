package v1_test

import (
	"math"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The session domain's wire shapes (Go Host 业务所有权迁移 §2.6).
//
// Five shapes are pinned, because each is a statement the other two runtimes
// have to read identically: a running agent session with its frozen launch, the
// run that backs it, the tombstone a close leaves, the Worker's own reading of
// its sessions — which a switch and a handback are verified against — and the
// upcall that says a run was lost rather than that it ended.
func TestSessionWire(t *testing.T) {
	exit := int32(130)
	for name, message := range map[string]proto.Message{
		// An agent session on a remote execution host. The launch is frozen:
		// the argv is the one that was reviewed, and `env_refs` names the
		// variable the launch depends on without carrying its value.
		"session_agent_running": &pb.Session{
			SessionId:       "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
			WorkspaceId:     "0123456789abcdef0123456789abcdef",
			ExecutionHostId: "构建机",
			SessionKey:      "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
			OwnerNodeId:     "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
			Launch: &pb.SessionLaunch{
				Shell:            "/bin/zsh",
				Command:          "claude",
				Args:             []string{"--permission-mode", "plan"},
				Agent:            &pb.AgentLaunchSpec{AgentId: "claude", WorkingDirectory: "/srv/项目/armadra", Args: []string{"--permission-mode", "plan"}, PermissionMode: "plan"},
				EnvRefs:          []string{"ANTHROPIC_API_KEY"},
				LaunchSha256:     []byte("0123456789abcdef0123456789abcdef"),
				WorkingDirectory: "/srv/项目/armadra",
			},
			BackendKind:        "tmux",
			Generation:         7,
			Kind:               pb.SessionKind_SESSION_KIND_AGENT,
			Status:             pb.SessionStatus_SESSION_STATUS_RUNNING,
			AttachState:        pb.SessionAttachState_SESSION_ATTACH_STATE_ATTACHED,
			TerminationIntent:  pb.TerminationIntent_TERMINATION_INTENT_NONE,
			CreatedAtUnixMs:    1788557000000,
			UpdatedAtUnixMs:    1788557900000,
			LastOutputAtUnixMs: 1788557800000,
			Revision:           9007199254740993,
		},
		// One generation of it. The backend reference is opaque here on
		// purpose: it names an object inside a process this Host does not run.
		"session_run": &pb.SessionRun{
			SessionId:        "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
			Generation:       7,
			WorkerInstanceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
			BackendRef:       "armadra-3f7c0a12:0.0",
			ExitCode:         &exit,
			ReasonCode:       "session.terminated.process",
			StartedAtUnixMs:  1788557000000,
			EndedAtUnixMs:    1788557900000,
			Revision:         math.MaxUint64,
		},
		// The tombstone a close leaves. `deleted` alone is the statement, and
		// the revision is what a re-creation under the same key has to name.
		"session_tombstone": &pb.Session{
			SessionId:       "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
			WorkspaceId:     "0123456789abcdef0123456789abcdef",
			SessionKey:      "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
			UpdatedAtUnixMs: 1788557900000,
			Revision:        4,
			Deleted:         true,
		},
		// The Worker's own reading. It carries no revision anywhere: the Worker
		// stores no CAS token for a domain it no longer owns, and a value there
		// would be one the Host could mistake for agreement.
		"session_worker_states": &pb.SessionWorkerResponse{
			Result: &pb.SessionWorkerResponse_Sessions{Sessions: &pb.WorkerSessionStates{
				WorkerInstanceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
				Sessions: []*pb.WorkerSessionState{{
					SessionId:   "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
					WorkspaceId: "0123456789abcdef0123456789abcdef",
					SessionKey:  "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
					OwnerNodeId: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
					BackendKind: "tmux",
					BackendRef:  "armadra-3f7c0a12:0.0",
					Generation:  7,
					Kind:        pb.SessionKind_SESSION_KIND_TERMINAL,
					Status:      pb.SessionStatus_SESSION_STATUS_RUNNING,
					AttachState: pb.SessionAttachState_SESSION_ATTACH_STATE_DETACHED,
					Launch:      &pb.SessionLaunch{Shell: "/bin/zsh", WorkingDirectory: "/home/用户/项目"},
				}},
			}},
		},
		// A lost run. It is a different kind from an exit and carries no exit
		// code, because nobody observed one.
		"session_upcall_run_lost": &pb.WorkerSessionUpcall{
			SessionId:        "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
			WorkspaceId:      "0123456789abcdef0123456789abcdef",
			SessionKey:       "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
			Generation:       7,
			WorkerInstanceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
			Kind:             pb.WorkerSessionUpcallKind_WORKER_SESSION_UPCALL_KIND_RUN_LOST,
			ReasonCode:       "session.run.unreachable",
			ObservedAtUnixMs: 1788557900000,
		},
	} {
		data, err := proto.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		wire := fixture(t, name, data)
		decoded := message.ProtoReflect().New().Interface()
		if err = proto.Unmarshal(wire, decoded); err != nil || !proto.Equal(decoded, message) {
			t.Fatalf("%s changed", name)
		}
	}
}

// A session that exited with status zero is not a session that never reported
// an exit code. The first is a program that finished successfully; the second
// is one nobody watched end, and a client offers to restart only the second.
func TestSessionExitCodeZeroIsNotAbsent(t *testing.T) {
	zero := int32(0)
	finished := &pb.Session{SessionId: "s", ExitCode: &zero}
	unknown := &pb.Session{SessionId: "s"}
	finishedWire, err := proto.Marshal(finished)
	if err != nil {
		t.Fatal(err)
	}
	unknownWire, err := proto.Marshal(unknown)
	if err != nil {
		t.Fatal(err)
	}
	if len(finishedWire) == len(unknownWire) {
		t.Fatal("an exit code of zero must occupy the wire; an absent one must not")
	}
	decoded := new(pb.Session)
	if err = proto.Unmarshal(unknownWire, decoded); err != nil || decoded.ExitCode != nil {
		t.Fatal("an absent exit code decoded as a value")
	}
}

// The session and its run are separate members of the reverse export record.
// A package that carried only sessions would restore rows claiming a generation
// nothing accounts for, which is exactly the state a reclaim cannot resolve.
func TestSessionReverseExportCarriesBothRecords(t *testing.T) {
	for _, record := range []*pb.ReverseExportRecord{
		{Entity: &pb.ReverseExportRecord_Session{Session: &pb.Session{SessionId: "s", Revision: 1}}},
		{Entity: &pb.ReverseExportRecord_SessionRun{SessionRun: &pb.SessionRun{SessionId: "s", Generation: 1}}},
	} {
		data, err := proto.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		decoded := new(pb.ReverseExportRecord)
		if err = proto.Unmarshal(data, decoded); err != nil || !proto.Equal(decoded, record) {
			t.Fatal("a reverse export record changed")
		}
	}
}
