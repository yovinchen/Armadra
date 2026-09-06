package worker

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
)

// Git frames over a Worker that *can* report upward (§2.9 上行帧 180).
//
// The difference from `git_real_test.go` is one option: a state directory,
// which is what opens the durable outbox and lets the execution host send
// progress. Everything else has to keep working exactly as it did — a Worker
// that gained a channel must not have lost a frame — and that is what this
// asserts, including the case the Host actually produces: several of these
// Workers running at once, sharing one state directory, because the queue runs
// different worktrees in parallel.

// realProgressWorker starts a Worker with the outbox enabled.
func realProgressWorker(t *testing.T, executable, state string, sink UpcallSink) *Client {
	t.Helper()
	client, err := Start(context.Background(), Options{
		Executable: executable,
		HostID:     fixtureHost,
		StateDir:   state,
		Upcalls:    sink,
	})
	if err != nil {
		t.Fatalf("the Worker with a state directory did not start: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	if !client.SupportsGit() {
		t.Fatal("the real Runtime does not advertise the git capability")
	}
	return client
}

func TestRealRustWorkerWithAnOutboxStillAnswersGitFrames(t *testing.T) {
	executable := os.Getenv("ARMADRA_TEST_REAL_WORKER")
	if executable == "" {
		t.Skip("set ARMADRA_TEST_REAL_WORKER to an existing native Runtime binary")
	}
	project := realWorkerRepository(t)
	if err := os.WriteFile(filepath.Join(project, "新文件.txt"), []byte("内容\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	state := t.TempDir()
	sink := &recordingSink{}
	client := realProgressWorker(t, executable, state, sink)

	// The channel is what the state directory buys, and the handshake has to
	// say so truthfully: a Worker that cannot persist a report must not claim
	// it can deliver one.
	if !containsCapability(client.hello.GetCapabilities(), UpcallCapability) {
		t.Fatalf("the Worker with an outbox does not advertise %s: %v", UpcallCapability, client.hello.GetCapabilities())
	}

	action := []byte(`{"paths":["新文件.txt"],"path":"."}`)
	sum := sha256.Sum256(action)
	outcome, err := client.RunGitOperation(context.Background(), &pb.GitOperation{
		OperationId:  "0000000000000001-operation",
		Scope:        &pb.RepositoryScope{WorkspaceId: "w", RepositoryPath: project},
		Action:       action,
		ActionSha256: sum[:],
		Kind:         pb.GitActionKind_GIT_ACTION_KIND_STAGE,
		State:        pb.GitOperationState_GIT_OPERATION_STATE_RUNNING,
	}, project)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.GetState() != pb.GitOperationState_GIT_OPERATION_STATE_SUCCEEDED {
		t.Fatalf("the stage reported %v (%s)", outcome.GetState(), outcome.GetMessageCode())
	}

	// A forwarded read still keeps the Runtime's own status. The reader pump
	// now owns the output stream, so this is the assertion that a response is
	// still routed to the caller waiting for it rather than to the sink.
	read, err := client.ReadGit(context.Background(), &pb.GitRead{
		Scope:         &pb.RepositoryScope{WorkspaceId: "w", RepositoryPath: project},
		RequestJson:   []byte(`{"reference":"HEAD","limit":5}`),
		WorkspaceRoot: project,
		Method:        pb.GitReadMethod_GIT_READ_METHOD_HISTORY,
	})
	if err != nil {
		t.Fatal(err)
	}
	if read.GetHttpStatus() != 200 {
		t.Fatalf("the forwarded history read answered %d: %s", read.GetHttpStatus(), read.GetResponseJson())
	}
}

// The Host runs different worktrees in parallel, so several of these Workers
// run at once — each with its **own** state directory, which is what makes that
// safe. A state directory is a Worker's own journal and outbox, and two
// processes opening one is a contended SQLite file that fails a frame outright.
// That is the trap the executor's `privateState` exists to avoid, and this is
// the shape it has to keep working in.
func TestRealRustWorkersRunConcurrentlyWithPrivateStateDirectories(t *testing.T) {
	executable := os.Getenv("ARMADRA_TEST_REAL_WORKER")
	if executable == "" {
		t.Skip("set ARMADRA_TEST_REAL_WORKER to an existing native Runtime binary")
	}
	project := realWorkerRepository(t)
	root := t.TempDir()

	const workers = 4
	var group sync.WaitGroup
	failures := make([]error, workers)
	for index := range workers {
		group.Add(1)
		go func() {
			defer group.Done()
			state := filepath.Join(root, fmt.Sprint(index))
			if err := os.MkdirAll(state, 0o700); err != nil {
				failures[index] = err
				return
			}
			client, err := Start(context.Background(), Options{
				Executable: executable,
				HostID:     fixtureHost,
				StateDir:   state,
				Upcalls:    &recordingSink{},
			})
			if err != nil {
				failures[index] = err
				return
			}
			defer client.Close()
			if !client.SupportsGit() {
				failures[index] = &Error{Code: CodeUnsupported}
				return
			}
			read, err := client.ReadGit(context.Background(), &pb.GitRead{
				Scope:         &pb.RepositoryScope{WorkspaceId: "w", RepositoryPath: project},
				RequestJson:   []byte(`{"path":"."}`),
				WorkspaceRoot: project,
				Method:        pb.GitReadMethod_GIT_READ_METHOD_STATUS,
			})
			if err != nil {
				failures[index] = err
				return
			}
			if read.GetHttpStatus() != 200 {
				failures[index] = &Error{Code: CodeProtocol}
			}
		}()
	}
	group.Wait()
	for index, err := range failures {
		if err != nil {
			t.Fatalf("worker %d with its own state directory failed: %v", index, err)
		}
	}
}
