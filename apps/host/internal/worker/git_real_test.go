package worker

import (
	"context"
	"crypto/sha256"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
)

// The git frames against a real Rust Runtime and a real repository
// (Go Host 业务所有权迁移 §2.8, action 29).
//
// Every other test of this frame talks to a fake, which proves the Go client
// and nothing about whether the two sides agree on what a queued operation is.
// This one runs the real binary over the real Worker channel against a real
// `git init`, and asserts the two things that cannot be faked: the command
// actually ran, and the answer is a reading of what happened rather than an
// echo of what was asked.
//
// It matters because everything the Host records about a push -- including
// whether its outcome is knowable -- comes from this reply.
//
// Opt-in: ARMADRA_TEST_REAL_WORKER must name an already built native Runtime,
// so an ordinary `go test ./...` needs no Rust toolchain.
func realWorkerRepository(t *testing.T) string {
	t.Helper()
	project := filepath.Join(t.TempDir(), "project")
	if err := os.MkdirAll(project, 0o700); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) {
		t.Helper()
		command := exec.Command("git", args...)
		command.Dir = project
		command.Env = append(os.Environ(),
			"GIT_CONFIG_GLOBAL=/dev/null",
			"GIT_CONFIG_SYSTEM=/dev/null",
			"GIT_AUTHOR_NAME=测试",
			"GIT_AUTHOR_EMAIL=test@example.invalid",
			"GIT_COMMITTER_NAME=测试",
			"GIT_COMMITTER_EMAIL=test@example.invalid",
		)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, output)
		}
	}
	git("init", "--initial-branch=main")
	if err := os.WriteFile(filepath.Join(project, "README.md"), []byte("# 项目\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	git("add", "README.md")
	git("commit", "-m", "initial")
	return project
}

func TestRealRustWorkerRunsAQueuedGitOperation(t *testing.T) {
	executable := os.Getenv("ARMADRA_TEST_REAL_WORKER")
	if executable == "" {
		t.Skip("set ARMADRA_TEST_REAL_WORKER to an existing native Runtime binary")
	}
	project := realWorkerRepository(t)
	if err := os.WriteFile(filepath.Join(project, "新文件.txt"), []byte("内容\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// No state directory and no canvas database: running a Git command needs
	// the workspace root the frame names and nothing else, which is what makes
	// every Worker able to answer.
	client, err := Start(context.Background(), Options{Executable: executable, HostID: fixtureHost})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if !client.SupportsGit() {
		t.Fatal("the real Runtime does not advertise the git capability")
	}

	// The queue is empty in a process that has just started, which is the
	// answer a switch proceeds on.
	snapshot, err := client.GitSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.GetQueued() != 0 || snapshot.GetRunning() != 0 || snapshot.GetCloneJobs() != 0 {
		t.Fatalf("a fresh Worker reported work in flight: %+v", snapshot)
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
	// The command ran: the file is in the index, not merely reported as staged.
	staged := exec.Command("git", "-c", "core.quotepath=false", "diff", "--cached", "--name-only")
	staged.Dir = project
	output, err := staged.Output()
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(output)) != "新文件.txt" {
		t.Fatalf("the index does not hold the staged file: %q", output)
	}

	// An observation carries the time it was taken, which is what makes the
	// Host's copy a cache rather than a claim.
	state, err := client.ObserveRepository(context.Background(), &pb.RepositoryScope{
		WorkspaceId: "w", RepositoryPath: project,
	}, project)
	if err != nil {
		t.Fatal(err)
	}
	if state.GetBranch() != "main" || len(state.GetHeadOid()) != 40 || state.GetObservedAtUnixMs() <= 0 {
		t.Fatalf("the observation is not a reading of the repository: %+v", state)
	}

	// A forwarded read keeps the status the Runtime's own route would return.
	read, err := client.ReadGit(context.Background(), &pb.GitRead{
		Scope:         &pb.RepositoryScope{WorkspaceId: "w", RepositoryPath: project},
		RequestJson:   []byte(`{"reference":"HEAD","limit":5}`),
		WorkspaceRoot: project,
		Method:        pb.GitReadMethod_GIT_READ_METHOD_HISTORY,
	})
	if err != nil {
		t.Fatal(err)
	}
	if read.GetHttpStatus() != 200 || !strings.Contains(string(read.GetResponseJson()), "commits") {
		t.Fatalf("the forwarded history read answered %d: %s", read.GetHttpStatus(), read.GetResponseJson())
	}
}
