package v1_test

import (
	"bytes"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The git domain's wire shapes (Go Host 业务所有权迁移 §2.8).
//
// Six shapes are pinned, because each one is a decision the other two runtimes
// have to read the same way:
//
//   - a queued push with its version-locked action body, its digest and the
//     remote ref it was decided against;
//   - the same operation after the process was interrupted, which is the state
//     this whole domain exists to be able to say;
//   - a repository snapshot in the middle of a conflict;
//   - a clone job, which carries a digest and a redacted URL and never the URL
//     that may have had a credential in it;
//   - the Worker's snapshot of what it still holds, which is what a switch is
//     refused on;
//   - a git envelope on the shared event stream.
func TestGitWire(t *testing.T) {
	scope := &pb.RepositoryScope{
		WorkspaceId:    "0123456789abcdef0123456789abcdef",
		RepositoryId:   "3b1f0a2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8",
		RepositoryPath: "/home/用户/项目/armadra",
	}
	for name, message := range map[string]proto.Message{
		// A push, queued. The action body is the Runtime's own camelCase JSON,
		// the digest is over exactly those bytes, and `expected` names the
		// remote OID the lease will be taken against — the three things that
		// make this a decision rather than a wish.
		"git_operation_queued": &pb.GitOperation{
			OperationId:     "0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8e9f",
			Scope:           scope,
			Action:          []byte(`{"kind":"push","remote":"origin","branch":"功能/推送"}`),
			ActionSha256:    bytes.Repeat([]byte{9}, 32),
			Expected:        &pb.GitExpectation{HeadOid: "1f2e3d4c5b6a798807162534435261708f9e0d1c", RefName: "refs/heads/功能/推送", RefOid: "aabbccddeeff00112233445566778899aabbccdd"},
			Kind:            pb.GitActionKind_GIT_ACTION_KIND_PUSH,
			State:           pb.GitOperationState_GIT_OPERATION_STATE_QUEUED,
			CreatedAtUnixMs: 1788557000000,
			Revision:        1,
		},
		// The interrupted push. `UNKNOWN_OUTCOME` is not a failure and must not
		// decode as one: the remote may have accepted it, and the affected ref
		// is what an operator reconciles against.
		"git_operation_unknown_outcome": &pb.GitOperation{
			OperationId:      "0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8e9f",
			Scope:            scope,
			ActionSha256:     bytes.Repeat([]byte{9}, 32),
			Affected:         []string{"refs/heads/功能/推送"},
			Progress:         60,
			Kind:             pb.GitActionKind_GIT_ACTION_KIND_PUSH,
			State:            pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME,
			MessageCode:      "git.operation.interrupted",
			CreatedAtUnixMs:  1788557000000,
			StartedAtUnixMs:  1788557000500,
			FinishedAtUnixMs: 1788557900000,
			Revision:         4,
		},
		// A checkout stopped on a conflict. `operation_state` is what makes
		// "in the middle of a rebase" different from "idle and behind".
		"git_repository_state_conflict": &pb.RepositoryState{
			Scope:               scope,
			HeadOid:             "1f2e3d4c5b6a798807162534435261708f9e0d1c",
			Detached:            true,
			IndexFingerprint:    bytes.Repeat([]byte{3}, 32),
			WorktreeFingerprint: bytes.Repeat([]byte{4}, 32),
			Upstream:            "origin/main",
			Ahead:               2,
			Behind:              7,
			OperationState:      pb.GitOperationState_GIT_OPERATION_STATE_AWAITING_RESOLUTION,
			ObservedAtUnixMs:    1788557900000,
			Revision:            9007199254740993,
		},
		// The URL is absent by construction: only its digest and the redacted
		// display form are ever stored.
		"git_clone_job": &pb.GitCloneJob{
			JobId:           "0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8ea0",
			WorkspaceId:     "0123456789abcdef0123456789abcdef",
			UrlSha256:       bytes.Repeat([]byte{5}, 32),
			DisplayUrl:      "https://example.invalid/组织/仓库.git",
			TargetPath:      "/home/用户/项目/仓库",
			Progress:        42,
			State:           pb.GitCloneState_GIT_CLONE_STATE_RUNNING,
			CreatedAtUnixMs: 1788557000000,
			UpdatedAtUnixMs: 1788557900000,
			Revision:        2,
		},
		// What the Worker still holds. A switch reads it and refuses on a
		// non-zero count rather than moving the domain out from under a push.
		"git_worker_snapshot": &pb.GitWorkerResponse{
			Result: &pb.GitWorkerResponse_Snapshot{Snapshot: &pb.GitDomainSnapshot{
				Queued:             1,
				Running:            1,
				CloneJobs:          0,
				ActiveOperationIds: []string{"0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8e9f"},
			}},
		},
		// One forwarded read, with the status the Runtime's own route would
		// have returned so a not-found stays a not-found.
		"git_worker_read": &pb.GitWorkerRequest{
			Action: &pb.GitWorkerRequest_Read{Read: &pb.GitRead{
				Scope:         scope,
				RequestJson:   []byte(`{"path":".","reference":"HEAD"}`),
				WorkspaceRoot: "/home/用户/项目",
				Method:        pb.GitReadMethod_GIT_READ_METHOD_HISTORY,
			}},
		},
		// The Worker's own report of a repository an external `git` changed.
		"git_upcall_repository_changed": &pb.WorkerUpcall{
			RequestId:        "w-7",
			WorkerInstanceId: "abcdef0123456789abcdef0123456789",
			Sequence:         7,
			Attempt:          1,
			EmittedAtUnixMs:  1788557900000,
			Event: &pb.WorkerUpcall_Git{Git: &pb.WorkerGitUpcall{
				WorkspaceId:      "0123456789abcdef0123456789abcdef",
				RepositoryPath:   "/home/用户/项目/armadra",
				Kind:             pb.WorkerGitUpcallKind_WORKER_GIT_UPCALL_KIND_REPOSITORY_CHANGED,
				ReasonCode:       "git.repository.external",
				ObservedAtUnixMs: 1788557900000,
				Repository: &pb.RepositoryState{
					Scope:            scope,
					HeadOid:          "aabbccddeeff00112233445566778899aabbccdd",
					Branch:           "main",
					ObservedAtUnixMs: 1788557900000,
				},
			}},
		},
		// The git domain on the shared event stream. Its numbers are 220-222,
		// the range §2.3 reserves for git; 180-219 belong to the agent domain.
		"git_event_envelope": &pb.EventEnvelope{
			Sequence:         41,
			TransactionId:    12,
			OperationId:      "git/0123456789abcdef0123456789abcdef/push-1",
			TransactionIndex: 0,
			TransactionSize:  1,
			WorkspaceId:      "0123456789abcdef0123456789abcdef",
			Domain:           pb.EventDomain_EVENT_DOMAIN_GIT,
			Kind:             "operation",
			EntityId:         "0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8e9f",
			Priority:         pb.EventPriority_EVENT_PRIORITY_NORMAL,
			Revision:         4,
			Entity: &pb.EventEnvelope_GitOperation{GitOperation: &pb.GitOperation{
				OperationId: "0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8e9f",
				Scope:       scope,
				Kind:        pb.GitActionKind_GIT_ACTION_KIND_PUSH,
				State:       pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME,
			}},
		},
		// The single write entry. Everything the panel used to send as its own
		// route arrives here, classified by `kind`.
		"git_enqueue_request": &pb.EnqueueGitOperationRequest{
			Meta:         &pb.CommandMeta{RequestId: "git-1", Scope: &pb.Scope{WorkspaceId: "0123456789abcdef0123456789abcdef"}},
			OperationId:  "git/0123456789abcdef0123456789abcdef/stage-1",
			Scope:        scope,
			Action:       []byte(`{"kind":"stage","paths":["源码/主.rs"]}`),
			ActionSha256: bytes.Repeat([]byte{6}, 32),
			Expected:     &pb.GitExpectation{IndexFingerprint: bytes.Repeat([]byte{3}, 32)},
			Kind:         pb.GitActionKind_GIT_ACTION_KIND_STAGE,
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

// An operation that finished is not the same message as one that never ran.
// `finished_at` alone does not say which; the state does, and a reader that
// treated an unset state as SUCCEEDED would report an interrupted push as done.
func TestGitOperationStateIsExplicit(t *testing.T) {
	unspecified := &pb.GitOperation{OperationId: "o"}
	if unspecified.GetState() != pb.GitOperationState_GIT_OPERATION_STATE_UNSPECIFIED {
		t.Fatal("an absent state decoded as a real one")
	}
	queued := &pb.GitOperation{OperationId: "o", State: pb.GitOperationState_GIT_OPERATION_STATE_QUEUED}
	left, err := proto.Marshal(unspecified)
	if err != nil {
		t.Fatal(err)
	}
	right, err := proto.Marshal(queued)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(left, right) {
		t.Fatal("an unspecified state encodes like a queued one")
	}
}

// The action body and its digest travel together. A frame that carried one
// without the other would let a rewritten command be run as though it had been
// authorized, so both fields exist and neither has a default that means "skip".
func TestGitActionCarriesItsOwnDigest(t *testing.T) {
	operation := &pb.GitOperation{
		OperationId:  "o",
		Action:       []byte(`{"kind":"commit","message":"提交"}`),
		ActionSha256: bytes.Repeat([]byte{1}, 32),
		Kind:         pb.GitActionKind_GIT_ACTION_KIND_COMMIT,
	}
	data, err := proto.Marshal(operation)
	if err != nil {
		t.Fatal(err)
	}
	decoded := new(pb.GitOperation)
	if err = proto.Unmarshal(data, decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.GetActionSha256()) != 32 || len(decoded.GetAction()) == 0 {
		t.Fatal("the action or its digest did not survive the round trip")
	}
}
