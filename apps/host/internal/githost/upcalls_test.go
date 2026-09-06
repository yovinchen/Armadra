package githost

import (
	"errors"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
)

// A progress report moves the entry a client is watching, and only while that
// entry is still running.
func TestProgressAdvancesOnlyARunningEntry(t *testing.T) {
	f := newFixture(t)
	f.own()
	gate := f.executor.open("0000000000000001-operation")
	queued := f.enqueue(pb.GitActionKind_GIT_ACTION_KIND_PUSH, scopeAt(mainPath, repositoryA), "push-1")
	id := queued.GetOperationId()
	// Wait until the queue has written RUNNING; before that there is nothing a
	// progress frame may move, which is itself the rule under test.
	running := f.awaitState(id, pb.GitOperationState_GIT_OPERATION_STATE_RUNNING)
	if running.GetProgress() != 0 {
		t.Fatalf("a fresh entry reports no progress: %d", running.GetProgress())
	}

	report := func(percent uint32) error {
		return f.service.ApplyUpcall(fixtureContext, &pb.WorkerGitUpcall{
			WorkspaceId:    workspaceID,
			OperationId:    id,
			RepositoryPath: mainPath,
			Progress:       percent,
			State:          pb.GitOperationState_GIT_OPERATION_STATE_RUNNING,
			Kind:           pb.WorkerGitUpcallKind_WORKER_GIT_UPCALL_KIND_OPERATION_PROGRESS,
		})
	}
	if err := report(37); err != nil {
		t.Fatal(err)
	}
	if got := f.read(id).GetProgress(); got != 37 {
		t.Fatalf("progress did not reach the entry: %d", got)
	}
	// Git reports several phases, each restarting at zero. A bar that jumped
	// back would read as a retry that did not happen.
	if err := report(12); err != nil {
		t.Fatal(err)
	}
	if got := f.read(id).GetProgress(); got != 37 {
		t.Fatalf("progress went backwards: %d", got)
	}
	// Out of range is dropped rather than clamped: a Worker that reports 250
	// has not said anything this Host can render.
	if err := report(250); err != nil {
		t.Fatal(err)
	}
	if got := f.read(id).GetProgress(); got != 37 {
		t.Fatalf("an impossible percentage was recorded: %d", got)
	}

	close(gate)
	settled := f.settled(id)
	if settled.GetState() != pb.GitOperationState_GIT_OPERATION_STATE_SUCCEEDED {
		t.Fatalf("state %v", settled.GetState())
	}
	// A frame written before the outcome can be delivered after it. Applying it
	// would move a finished push back to running.
	if err := report(50); err != nil {
		t.Fatal(err)
	}
	after := f.read(id)
	if after.GetState() != pb.GitOperationState_GIT_OPERATION_STATE_SUCCEEDED || after.GetProgress() != 100 {
		t.Fatalf("a settled entry was reopened: %v %d", after.GetState(), after.GetProgress())
	}
}

// A report for something this Host has never heard of is accepted and dropped:
// refusing it would make the Worker replay it forever with nowhere to land.
func TestAnUnknownSubjectIsAcceptedAndDropped(t *testing.T) {
	f := newFixture(t)
	for _, frame := range []*pb.WorkerGitUpcall{
		{WorkspaceId: workspaceID, OperationId: "no-such-operation", Kind: pb.WorkerGitUpcallKind_WORKER_GIT_UPCALL_KIND_OPERATION_PROGRESS, Progress: 10},
		{WorkspaceId: workspaceID, OperationId: "no-such-job", Kind: pb.WorkerGitUpcallKind_WORKER_GIT_UPCALL_KIND_CLONE_PROGRESS, Progress: 10},
		{WorkspaceId: "not a workspace", Kind: pb.WorkerGitUpcallKind_WORKER_GIT_UPCALL_KIND_OPERATION_PROGRESS},
		{WorkspaceId: workspaceID, Kind: pb.WorkerGitUpcallKind_WORKER_GIT_UPCALL_KIND_CONFLICT_DETECTED},
	} {
		if err := f.service.ApplyUpcall(fixtureContext, frame); err != nil {
			t.Fatalf("%v: %v", frame.GetKind(), err)
		}
	}
}

// A clone is the one subject whose end does come from a report: there is no
// response frame to settle it, because the frame that started it returned as
// soon as `git` was running.
func TestACloneIsAdvancedAndSettledByItsReports(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.executor.readReply = &pb.GitReadResult{
		HttpStatus:   200,
		ResponseJson: []byte(`{"jobId":"clone-1","displayUrl":"https://example.invalid/repo.git","targetPath":"/home/用户/项目/repo","progress":0,"state":"running"}`),
	}
	started, err := f.service.Clone(fixtureContext, f.writer(), &pb.StartGitCloneRequest{
		Meta:        &pb.CommandMeta{RequestId: "clone-op", Scope: &pb.Scope{WorkspaceId: workspaceID}},
		OperationId: "clone-op",
		Url:         "https://example.invalid/repo.git",
	})
	if err != nil {
		t.Fatal(err)
	}
	job := started.GetJob()
	if job.GetState() != pb.GitCloneState_GIT_CLONE_STATE_RUNNING {
		t.Fatalf("state %v", job.GetState())
	}
	// The URL is never stored; only its digest and the redacted display form.
	if job.GetDisplayUrl() != "https://example.invalid/repo.git" || len(job.GetUrlSha256()) != 32 {
		t.Fatalf("clone record: %+v", job)
	}

	if err = f.service.ApplyUpcall(fixtureContext, &pb.WorkerGitUpcall{
		WorkspaceId: workspaceID,
		OperationId: job.GetJobId(),
		Progress:    64,
		Kind:        pb.WorkerGitUpcallKind_WORKER_GIT_UPCALL_KIND_CLONE_PROGRESS,
	}); err != nil {
		t.Fatal(err)
	}
	current, err := f.service.cloneJob(fixtureContext, workspaceID, job.GetJobId())
	if err != nil {
		t.Fatal(err)
	}
	if current.GetProgress() != 64 {
		t.Fatalf("clone progress: %d", current.GetProgress())
	}

	if err = f.service.ApplyUpcall(fixtureContext, &pb.WorkerGitUpcall{
		WorkspaceId: workspaceID,
		OperationId: job.GetJobId(),
		Progress:    100,
		State:       pb.GitOperationState_GIT_OPERATION_STATE_SUCCEEDED,
		Kind:        pb.WorkerGitUpcallKind_WORKER_GIT_UPCALL_KIND_CLONE_FINISHED,
		ReasonCode:  "git.clone.succeeded",
	}); err != nil {
		t.Fatal(err)
	}
	finished, err := f.service.cloneJob(fixtureContext, workspaceID, job.GetJobId())
	if err != nil {
		t.Fatal(err)
	}
	if finished.GetState() != pb.GitCloneState_GIT_CLONE_STATE_SUCCEEDED || finished.GetMessageCode() != "git.clone.succeeded" {
		t.Fatalf("clone did not settle: %+v", finished)
	}
	// A second report about a settled job changes nothing.
	if err = f.service.ApplyUpcall(fixtureContext, &pb.WorkerGitUpcall{
		WorkspaceId: workspaceID,
		OperationId: job.GetJobId(),
		Progress:    100,
		State:       pb.GitOperationState_GIT_OPERATION_STATE_FAILED,
		Kind:        pb.WorkerGitUpcallKind_WORKER_GIT_UPCALL_KIND_CLONE_FINISHED,
	}); err != nil {
		t.Fatal(err)
	}
	again, err := f.service.cloneJob(fixtureContext, workspaceID, job.GetJobId())
	if err != nil {
		t.Fatal(err)
	}
	if again.GetState() != pb.GitCloneState_GIT_CLONE_STATE_SUCCEEDED {
		t.Fatalf("a settled clone was reopened: %v", again.GetState())
	}
}

// Starting a clone makes the machine fetch a repository. A device holding only
// `git:read` must not reach it through the read channel's own shape.
func TestCloneMethodsOnTheReadChannelNeedTheExecuteGrant(t *testing.T) {
	f := newFixture(t)
	f.own()
	reader := f.caller(ScopeRead)
	for _, method := range []pb.GitReadMethod{
		pb.GitReadMethod_GIT_READ_METHOD_CLONE_START,
		pb.GitReadMethod_GIT_READ_METHOD_CLONE_CANCEL,
	} {
		_, err := f.service.Read(fixtureContext, reader, &pb.ReadGitRequest{
			Meta: &pb.CommandMeta{RequestId: "read", Scope: &pb.Scope{WorkspaceId: workspaceID}},
			Read: &pb.GitRead{Scope: scopeAt(mainPath, repositoryA), Method: method},
		})
		if !errors.Is(err, ErrAuthorization) {
			t.Fatalf("%v was allowed with git:read alone: %v", method, err)
		}
	}
}

// Every entry point refuses a checkout that is not under the registered root,
// and says which refusal it is.
func TestACheckoutOutsideTheRegisteredRootIsRefusedByName(t *testing.T) {
	f := newFixture(t)
	f.own()
	outside := scopeAt("/home/用户/别的项目", repositoryA)

	action := []byte(`{"kind":"stage"}`)
	_, err := f.service.Enqueue(fixtureContext, f.writer(), &pb.EnqueueGitOperationRequest{
		Meta:         &pb.CommandMeta{RequestId: "outside", Scope: &pb.Scope{WorkspaceId: workspaceID}},
		OperationId:  "outside",
		Scope:        outside,
		Action:       action,
		ActionSha256: digest(action),
		Kind:         pb.GitActionKind_GIT_ACTION_KIND_STAGE,
	})
	if !errors.Is(err, ErrOutsideRoot) {
		t.Fatalf("enqueue: %v", err)
	}

	_, err = f.service.Read(fixtureContext, f.writer(), &pb.ReadGitRequest{
		Meta: &pb.CommandMeta{RequestId: "read", Scope: &pb.Scope{WorkspaceId: workspaceID}},
		Read: &pb.GitRead{Scope: outside, Method: pb.GitReadMethod_GIT_READ_METHOD_STATUS},
	})
	if !errors.Is(err, ErrOutsideRoot) {
		t.Fatalf("read: %v", err)
	}

	_, err = f.service.RepositoryState(fixtureContext, f.writer(), &pb.GetRepositoryStateRequest{
		Meta:    &pb.CommandMeta{RequestId: "state", Scope: &pb.Scope{WorkspaceId: workspaceID}},
		Scope:   outside,
		Refresh: true,
	})
	if !errors.Is(err, ErrOutsideRoot) {
		t.Fatalf("repository state: %v", err)
	}

	// The workspace-wide scan names no checkout, so it is exempt by
	// construction rather than by an exception somebody has to remember.
	if _, err = f.service.Read(fixtureContext, f.writer(), &pb.ReadGitRequest{
		Meta: &pb.CommandMeta{RequestId: "scan", Scope: &pb.Scope{WorkspaceId: workspaceID}},
		Read: &pb.GitRead{Scope: &pb.RepositoryScope{WorkspaceId: workspaceID}, Method: pb.GitReadMethod_GIT_READ_METHOD_REPOSITORIES},
	}); err != nil {
		t.Fatalf("the repository scan was refused: %v", err)
	}
}

// A Frame binding names a directory in its *body*, so the containment rule has
// to be applied there too.
func TestAFrameBindingOutsideTheRootIsRefusedAndARelativeOneIsForwarded(t *testing.T) {
	f := newFixture(t)
	f.own()
	read := func(body string) error {
		_, err := f.service.Read(fixtureContext, f.writer(), &pb.ReadGitRequest{
			Meta: &pb.CommandMeta{RequestId: "binding", Scope: &pb.Scope{WorkspaceId: workspaceID}},
			Read: &pb.GitRead{
				Scope:       scopeAt(mainPath, repositoryA),
				RequestJson: []byte(body),
				Method:      pb.GitReadMethod_GIT_READ_METHOD_WORKTREE_BINDING,
			},
		})
		return err
	}
	if err := read(`{"worktreePath":"/home/用户/别的项目/功能"}`); !errors.Is(err, ErrOutsideRoot) {
		t.Fatalf("an absolute path outside the root was accepted: %v", err)
	}
	if err := read(`{"worktreePath":""}`); !errors.Is(err, ErrInvalid) {
		t.Fatalf("an empty binding path was accepted: %v", err)
	}
	// A relative path is resolved against the root by the execution host, which
	// is the side that can refuse a traversal against the real directory.
	if err := read(`{"worktreePath":"worktrees/功能","branch":"feature/x"}`); err != nil {
		t.Fatalf("a relative binding path was refused here: %v", err)
	}
	calls := f.executor.readCalls
	if len(calls) == 0 || calls[len(calls)-1].GetMethod() != pb.GitReadMethod_GIT_READ_METHOD_WORKTREE_BINDING {
		t.Fatalf("the binding read was not forwarded: %+v", calls)
	}
	if calls[len(calls)-1].GetWorkspaceRoot() != "/home/用户/项目" {
		t.Fatalf("the root was not resolved by the Host: %q", calls[len(calls)-1].GetWorkspaceRoot())
	}
}

// The two spellings macOS gives one directory are the same directory. Comparing
// them as written would refuse a checkout inside the very root registered for
// it.
func TestASymlinkedPrefixIsNotAnEscape(t *testing.T) {
	cases := []struct {
		root, path string
		inside     bool
	}{
		{"/private/var/folders/x/project", "/var/folders/x/project/worktrees/a", true},
		{"/var/folders/x/project", "/private/var/folders/x/project", true},
		{"/home/用户/项目", "/home/用户/项目", true},
		{"/home/用户/项目", "/home/用户/项目-old", false},
		{"/home/用户/项目", "/home/用户", false},
		{`C:\项目`, `C:/项目/worktrees/a`, true},
		{"/home/用户/项目", "", false},
	}
	for _, item := range cases {
		if got := insideRoot(item.root, item.path); got != item.inside {
			t.Fatalf("insideRoot(%q, %q) = %v", item.root, item.path, got)
		}
	}
}
