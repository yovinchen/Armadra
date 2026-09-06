package githost

import (
	"errors"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// A write is refused until this Host is the settled owner. There is no
// dual-write mode: two queues over one repository is the thing the record
// exists to prevent, and "the switch is halfway" is a refusal on both sides
// rather than a race between them.
func TestAWriteIsRefusedUntilTheDomainHasMoved(t *testing.T) {
	f := newFixture(t)
	action := []byte(`{"kind":"stage"}`)
	request := &pb.EnqueueGitOperationRequest{
		OperationId:  "git/stage-1",
		Scope:        scopeAt(mainPath, repositoryA),
		Action:       action,
		ActionSha256: digest(action),
		Kind:         pb.GitActionKind_GIT_ACTION_KIND_STAGE,
	}
	if _, err := f.service.Enqueue(fixtureContext, f.writer(), request); !errors.Is(err, ErrOwnershipMoved) {
		t.Fatalf("expected ownership_moved before the switch, got %v", err)
	}
	// A switch that is open is not a switch that is done.
	if _, err := f.store.PutOwnership(fixtureContext, storage.Ownership{
		Domain: Domain, Owner: storage.OwnerHost, Epoch: 2, Phase: storage.OwnershipSwitching,
		ReasonCode: "ownership.switch.pending", CreatedAtMS: 1, UpdatedAtMS: 1,
	}, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Enqueue(fixtureContext, f.writer(), request); !errors.Is(err, ErrOwnershipMoved) {
		t.Fatalf("expected ownership_moved while switching, got %v", err)
	}
}

// Running a Git command makes the machine execute something. A device with
// git:write and no terminal:write may look at the panel and may not push, which
// is the same answer `scopes.go` gives for the Runtime's own git routes -- and
// keeping it the same is what makes the permission table comparable across the
// switch (§6.3).
func TestGitWriteAloneCannotRunACommand(t *testing.T) {
	f := newFixture(t)
	f.own()
	action := []byte(`{"kind":"push"}`)
	_, err := f.service.Enqueue(fixtureContext, f.caller(ScopeRead, ScopeWrite), &pb.EnqueueGitOperationRequest{
		OperationId:  "git/push-1",
		Scope:        scopeAt(mainPath, repositoryA),
		Action:       action,
		ActionSha256: digest(action),
		Kind:         pb.GitActionKind_GIT_ACTION_KIND_PUSH,
	})
	if !errors.Is(err, ErrAuthorization) {
		t.Fatalf("expected a permission refusal without terminal:write, got %v", err)
	}
}

// A workspace whose registration withholds execute is not one this device may
// make the machine act on, whatever its own grants say. The two checks are
// different questions and both have to hold.
func TestARootWithoutExecuteRefusesEveryCommand(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.roots.execute = false
	action := []byte(`{"kind":"commit"}`)
	_, err := f.service.Enqueue(fixtureContext, f.writer(), &pb.EnqueueGitOperationRequest{
		OperationId:  "git/commit-1",
		Scope:        scopeAt(mainPath, repositoryA),
		Action:       action,
		ActionSha256: digest(action),
		Kind:         pb.GitActionKind_GIT_ACTION_KIND_COMMIT,
	})
	if !errors.Is(err, ErrAuthorization) {
		t.Fatalf("expected a refusal for a root without execute, got %v", err)
	}
}

// The action body and its digest are checked here, not only at the Worker. A
// rewritten body has to be refused before it is recorded as an authorized
// decision, because the record is what a reconciliation later trusts.
func TestARewrittenActionBodyIsRefused(t *testing.T) {
	f := newFixture(t)
	f.own()
	_, err := f.service.Enqueue(fixtureContext, f.writer(), &pb.EnqueueGitOperationRequest{
		OperationId:  "git/stage-1",
		Scope:        scopeAt(mainPath, repositoryA),
		Action:       []byte(`{"kind":"stage","paths":["a"]}`),
		ActionSha256: digest([]byte(`{"kind":"stage","paths":["b"]}`)),
		Kind:         pb.GitActionKind_GIT_ACTION_KIND_STAGE,
	})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected a refusal for a digest that does not describe the body, got %v", err)
	}
}

// A kind this build cannot classify is refused rather than queued: the Host
// decides serialization and lock order from the kind, and cannot order an
// action it cannot name.
func TestAnUnclassifiableKindIsNeverQueued(t *testing.T) {
	f := newFixture(t)
	f.own()
	for _, kind := range []pb.GitActionKind{
		pb.GitActionKind_GIT_ACTION_KIND_UNSPECIFIED,
		pb.GitActionKind_GIT_ACTION_KIND_UNSUPPORTED,
		pb.GitActionKind(9999),
	} {
		action := []byte(`{"kind":"?"}`)
		_, err := f.service.Enqueue(fixtureContext, f.writer(), &pb.EnqueueGitOperationRequest{
			OperationId:  "git/unknown-" + kind.String(),
			Scope:        scopeAt(mainPath, repositoryA),
			Action:       action,
			ActionSha256: digest(action),
			Kind:         kind,
		})
		if !errors.Is(err, ErrInvalid) {
			t.Fatalf("kind %v was not refused: %v", kind, err)
		}
	}
}

// Two writes to one checkout are sequential. The second does not start until
// the first has finished -- not merely "both were attempted", which is what a
// test that only counted calls would prove.
func TestOneWorktreeSerializesItsWrites(t *testing.T) {
	f := newFixture(t)
	f.own()
	gate := f.executor.open("0000000000000001-operation")
	first := f.enqueue(pb.GitActionKind_GIT_ACTION_KIND_STAGE, scopeAt(mainPath, repositoryA), "git/stage-1")
	second := f.enqueue(pb.GitActionKind_GIT_ACTION_KIND_COMMIT, scopeAt(mainPath, repositoryA), "git/commit-1")

	// While the first is held open the second must not have started at all.
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		started, _ := f.executor.order()
		for _, id := range started {
			if id == second.GetOperationId() {
				t.Fatal("a second write started while the first held the worktree")
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	close(gate)
	f.settled(first.GetOperationId())
	f.settled(second.GetOperationId())
	started, finished := f.executor.order()
	if len(started) != 2 || started[0] != first.GetOperationId() || started[1] != second.GetOperationId() {
		t.Fatalf("the queue did not preserve submission order: %v", started)
	}
	if finished[0] != first.GetOperationId() {
		t.Fatalf("the first write did not finish first: %v", finished)
	}
}

// Different checkouts run in parallel. Sharing a repository id is not sharing a
// worktree: a linked worktree and its main checkout are one repository, and
// serializing their index writes against each other would make every worktree
// pointless.
func TestTwoWorktreesRunInParallel(t *testing.T) {
	f := newFixture(t)
	f.own()
	gate := f.executor.open("0000000000000001-operation")
	first := f.enqueue(pb.GitActionKind_GIT_ACTION_KIND_STAGE, scopeAt(mainPath, repositoryA), "git/stage-main")
	second := f.enqueue(pb.GitActionKind_GIT_ACTION_KIND_STAGE, scopeAt(linkedPath, repositoryA), "git/stage-linked")

	deadline := time.Now().Add(2 * time.Second)
	for {
		started, _ := f.executor.order()
		if len(started) == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the second worktree never started while the first was held: %v", started)
		}
		time.Sleep(2 * time.Millisecond)
	}
	close(gate)
	f.settled(first.GetOperationId())
	f.settled(second.GetOperationId())
}

// Ref work takes the common git dir. Two checkouts of one repository may stage
// in parallel and may not both push, because a push moves a ref both of them
// share.
func TestRefWorkSerializesAcrossWorktreesOfOneRepository(t *testing.T) {
	f := newFixture(t)
	f.own()
	gate := f.executor.open("0000000000000001-operation")
	first := f.enqueue(pb.GitActionKind_GIT_ACTION_KIND_PUSH, scopeAt(mainPath, repositoryA), "git/push-main")
	second := f.enqueue(pb.GitActionKind_GIT_ACTION_KIND_CREATE_BRANCH, scopeAt(linkedPath, repositoryA), "git/branch-linked")

	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		started, _ := f.executor.order()
		for _, id := range started {
			if id == second.GetOperationId() {
				t.Fatal("two ref writes of one repository ran at once")
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	close(gate)
	f.settled(first.GetOperationId())
	f.settled(second.GetOperationId())

	// A different repository's ref work is unaffected.
	third := f.enqueue(pb.GitActionKind_GIT_ACTION_KIND_PUSH, scopeAt("/home/用户/项目/其他", repositoryB), "git/push-other")
	f.settled(third.GetOperationId())
}

// A lost channel is an unknown outcome, never a failure. Whether the command
// ran is exactly what this Host cannot know, and a retry decided from FAILED
// would push twice.
func TestALostChannelLeavesTheOutcomeUnknown(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.executor.runErr["0000000000000001-operation"] = errors.New("the worker went away")
	operation := f.enqueue(pb.GitActionKind_GIT_ACTION_KIND_PUSH, scopeAt(mainPath, repositoryA), "git/push-1")
	settled := f.settled(operation.GetOperationId())
	if settled.GetState() != pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME {
		t.Fatalf("expected an unknown outcome, got %v", settled.GetState())
	}
	if settled.GetMessageCode() != "git.operation.channel_lost" {
		t.Fatalf("the reason was not recorded: %q", settled.GetMessageCode())
	}
}

// A Worker that answered with a non-final state has not said what happened.
// Reading that as "still running" would leave an entry the queue has already
// released, and reading it as success would be an invention.
func TestANonFinalOutcomeIsUnknownRatherThanRunning(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.executor.outcome["0000000000000001-operation"] = pb.GitOperationState_GIT_OPERATION_STATE_RUNNING
	operation := f.enqueue(pb.GitActionKind_GIT_ACTION_KIND_COMMIT, scopeAt(mainPath, repositoryA), "git/commit-1")
	settled := f.settled(operation.GetOperationId())
	if settled.GetState() != pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME {
		t.Fatalf("expected an unknown outcome, got %v", settled.GetState())
	}
}

// A conflict is not a failure. An integration that stopped for a person keeps
// its own state all the way to the record, so a panel shows "resolve this"
// rather than "this went wrong".
func TestAConflictKeepsItsOwnState(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.executor.outcome["0000000000000001-operation"] = pb.GitOperationState_GIT_OPERATION_STATE_AWAITING_RESOLUTION
	operation := f.enqueue(pb.GitActionKind_GIT_ACTION_KIND_START_MERGE, scopeAt(mainPath, repositoryA), "git/merge-1")
	settled := f.settled(operation.GetOperationId())
	if settled.GetState() != pb.GitOperationState_GIT_OPERATION_STATE_AWAITING_RESOLUTION {
		t.Fatalf("a conflict was reported as %v", settled.GetState())
	}
}

// The same request twice is the same operation. A retried enqueue replays its
// receipt instead of queueing a second commit.
func TestARetriedEnqueueReplaysRatherThanQueueingTwice(t *testing.T) {
	f := newFixture(t)
	f.own()
	action := []byte(`{"kind":"commit","message":"提交"}`)
	request := &pb.EnqueueGitOperationRequest{
		OperationId:  "git/commit-1",
		Scope:        scopeAt(mainPath, repositoryA),
		Action:       action,
		ActionSha256: digest(action),
		Kind:         pb.GitActionKind_GIT_ACTION_KIND_COMMIT,
	}
	first, err := f.service.Enqueue(fixtureContext, f.writer(), request)
	if err != nil {
		t.Fatal(err)
	}
	f.settled(first.GetOperation().GetOperationId())
	second, err := f.service.Enqueue(fixtureContext, f.writer(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !second.GetReceipt().GetReplayed() {
		t.Fatal("the second attempt was not reported as a replay")
	}
	if second.GetOperation().GetOperationId() != first.GetOperation().GetOperationId() {
		t.Fatal("a retry produced a second operation")
	}
	started, _ := f.executor.order()
	if len(started) != 1 {
		t.Fatalf("a retry ran the command again: %v", started)
	}
}

// Cancelling something that has not started is this Host's own decision, and
// nothing is unknown about it. Cancelling something already handed to the
// execution host is a request whose answer belongs to that host.
func TestCancellingBeforeAndAfterTheMutationDiffer(t *testing.T) {
	f := newFixture(t)
	f.own()
	gate := f.executor.open("0000000000000001-operation")
	running := f.enqueue(pb.GitActionKind_GIT_ACTION_KIND_PUSH, scopeAt(mainPath, repositoryA), "git/push-1")
	queued := f.enqueue(pb.GitActionKind_GIT_ACTION_KIND_COMMIT, scopeAt(mainPath, repositoryA), "git/commit-1")

	response, err := f.service.CancelOperation(fixtureContext, f.writer(), &pb.CancelGitOperationRequest{
		OperationId:       "git/cancel-1",
		TargetOperationId: queued.GetOperationId(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.GetOperation().GetState() != pb.GitOperationState_GIT_OPERATION_STATE_CANCELLED {
		t.Fatalf("a queued entry was not cancelled: %v", response.GetOperation().GetState())
	}

	if _, err = f.service.CancelOperation(fixtureContext, f.writer(), &pb.CancelGitOperationRequest{
		OperationId:       "git/cancel-2",
		TargetOperationId: running.GetOperationId(),
	}); err != nil {
		t.Fatal(err)
	}
	f.executor.mu.Lock()
	asked := len(f.executor.cancelled)
	f.executor.mu.Unlock()
	if asked != 1 {
		t.Fatalf("the execution host was not asked to stop the running operation (%d asks)", asked)
	}
	close(gate)
	f.settled(running.GetOperationId())

	if _, err = f.service.CancelOperation(fixtureContext, f.writer(), &pb.CancelGitOperationRequest{
		OperationId:       "git/cancel-3",
		TargetOperationId: running.GetOperationId(),
	}); !errors.Is(err, ErrTerminal) {
		t.Fatalf("cancelling a finished operation was not refused: %v", err)
	}
}

// A forwarded read never carries the caller's own idea of where the files are.
// A workspace root inside a request would be the caller choosing which
// directory this Host reads.
func TestAForwardedReadUsesTheRegisteredRoot(t *testing.T) {
	f := newFixture(t)
	f.own()
	_, err := f.service.Read(fixtureContext, f.caller(ScopeRead), &pb.ReadGitRequest{
		Read: &pb.GitRead{
			Scope:         scopeAt(mainPath, repositoryA),
			Method:        pb.GitReadMethod_GIT_READ_METHOD_HISTORY,
			WorkspaceRoot: "/etc",
			RequestJson:   []byte(`{"reference":"HEAD"}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.executor.mu.Lock()
	defer f.executor.mu.Unlock()
	if len(f.executor.readCalls) != 1 {
		t.Fatalf("expected one forwarded read, got %d", len(f.executor.readCalls))
	}
	if root := f.executor.readCalls[0].GetWorkspaceRoot(); root != "/home/用户/项目" {
		t.Fatalf("the request's own root was forwarded: %q", root)
	}
}

// Reads keep answering after the domain has moved, and before it. The whole
// point of the switch is that who writes changes and what a person can look at
// does not.
func TestReadsDoNotNeedOwnership(t *testing.T) {
	f := newFixture(t)
	if _, err := f.service.Read(fixtureContext, f.caller(ScopeRead), &pb.ReadGitRequest{
		Read: &pb.GitRead{Scope: scopeAt(mainPath, repositoryA), Method: pb.GitReadMethod_GIT_READ_METHOD_STATUS},
	}); err != nil {
		t.Fatalf("a read was refused while the Runtime owned the domain: %v", err)
	}
}

// Drafting a commit message runs a CLI with the user's own account, so it needs
// the execute grant even though it changes nothing in the repository.
func TestDraftingAMessageNeedsTheExecuteGrant(t *testing.T) {
	f := newFixture(t)
	f.own()
	request := &pb.GenerateGitMessageRequest{Scope: scopeAt(mainPath, repositoryA), RequestJson: []byte(`{}`)}
	if _, err := f.service.GenerateMessage(fixtureContext, f.caller(ScopeRead, ScopeWrite), request); !errors.Is(err, ErrAuthorization) {
		t.Fatalf("a draft was allowed without terminal:write: %v", err)
	}
	if _, err := f.service.GenerateMessage(fixtureContext, f.writer(), request); err != nil {
		t.Fatal(err)
	}
}

// The cached snapshot is a reading with a time on it, and asking for a refresh
// is asking the repository rather than the cache.
func TestTheRepositorySnapshotIsACacheWithAnObservationTime(t *testing.T) {
	f := newFixture(t)
	f.own()
	scope := scopeAt(mainPath, repositoryA)
	if _, err := f.service.RepositoryState(fixtureContext, f.caller(ScopeRead), &pb.GetRepositoryStateRequest{Scope: scope}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an unobserved repository answered something: %v", err)
	}
	response, err := f.service.RepositoryState(fixtureContext, f.caller(ScopeRead), &pb.GetRepositoryStateRequest{Scope: scope, Refresh: true})
	if err != nil {
		t.Fatal(err)
	}
	if response.GetState().GetObservedAtUnixMs() == 0 {
		t.Fatal("a snapshot was stored without the time it was observed")
	}
	// A second read without refresh answers from the cache and does not
	// re-observe: a panel repainting must not run `git status` per frame.
	before := f.executor.observed
	if _, err = f.service.RepositoryState(fixtureContext, f.caller(ScopeRead), &pb.GetRepositoryStateRequest{Scope: scope}); err != nil {
		t.Fatal(err)
	}
	if f.executor.observed != before {
		t.Fatal("a cached read re-observed the repository")
	}
}

// A clone URL can carry a credential. What is stored is the digest and the
// redacted form the execution host produced; the URL itself never reaches the
// database.
func TestACloneStoresADigestAndNeverTheURL(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.executor.readReply = &pb.GitReadResult{HttpStatus: 200, ResponseJson: []byte(
		`{"jobId":"clone-1","displayUrl":"https://example.invalid/org/repo.git","targetPath":"/home/用户/项目/repo","progress":0,"state":"running"}`)}
	url := "https://someone:a-secret-token@example.invalid/org/repo.git"
	response, err := f.service.Clone(fixtureContext, f.writer(), &pb.StartGitCloneRequest{OperationId: "git/clone-1", Url: url})
	if err != nil {
		t.Fatal(err)
	}
	job := response.GetJob()
	if string(job.GetUrlSha256()) != string(digest([]byte(url))) {
		t.Fatal("the clone was not recorded under the digest of its URL")
	}
	entity, err := f.store.Read(fixtureContext, f.service.cloneKey(workspaceID, job.GetJobId()))
	if err != nil {
		t.Fatal(err)
	}
	if bytesContain(entity.Payload, []byte("a-secret-token")) {
		t.Fatal("the stored clone row carries the credential from the URL")
	}
	if job.GetDisplayUrl() != "https://example.invalid/org/repo.git" {
		t.Fatalf("the display URL was not the redacted one: %q", job.GetDisplayUrl())
	}
}

func bytesContain(haystack, needle []byte) bool {
	if len(needle) == 0 || len(needle) > len(haystack) {
		return false
	}
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if string(haystack[index:index+len(needle)]) == string(needle) {
			return true
		}
	}
	return false
}
