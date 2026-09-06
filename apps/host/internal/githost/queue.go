package githost

import (
	"context"
	"sync"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The queue: what runs, in what order, and what never runs at the same time
// (Go Host 业务所有权迁移 §2.8, Git 设计 §2).
//
// Git is not a database and the execution host is not the only writer: a person
// with a terminal can run `git commit` in the same checkout at any moment. The
// queue therefore does not pretend to hold a lock on the repository. What it
// does is guarantee the one thing it can — that *this* Host never has two of
// its own writes in one checkout at once — and state every precondition so an
// external change is a refusal instead of an overwrite.
//
// Two locks, in a fixed order, and never the reverse:
//
//  1. the **common git dir** lock, taken by anything that touches refs, the
//     worktree list or a remote (Git 设计 §2 "改 refs、worktree 管理和网络 ref
//     更新按 common git dir 加仓库级锁, 锁排序固定");
//  2. the **worktree** lock, taken by every write, because every write touches
//     one checkout's index or files.
//
// Taking them in that order is what makes two repositories that share a common
// dir — a main checkout and its linked worktrees — impossible to deadlock: a
// cycle needs two holders acquiring in opposite orders, and there is only one
// order here.
//
// The common dir is not read from the repository. It is derived from the scope
// the caller addressed, whose `repository_id` is already the digest of the
// canonical common dir, so a linked worktree and its main checkout serialize
// against each other for ref work without this Host having to run `git` to find
// out that they are the same repository. A scope with no id falls back to the
// checkout path, which is the conservative reading: the operation then
// serializes against itself and nothing else.

// scheduled is one entry waiting for its turn.
type scheduled struct {
	workspaceID string
	operationID string
	root        string
	// commonKey and worktreeKey are the two locks, in acquisition order.
	commonKey   string
	worktreeKey string
	refWork     bool
}

// queue runs one operation at a time per lock set. It is not a thread pool: a
// git write is a subprocess on another machine, and the interesting property is
// exclusion, not throughput.
type queue struct {
	service *Service

	mu sync.Mutex
	// held is the set of lock keys currently taken.
	held map[string]bool
	// pending is the entries waiting, in submission order. It is a slice
	// rather than a map because the order is the queue.
	pending []scheduled
	// running names the operations that have been handed to the execution
	// host. An entry here can no longer be withdrawn: only the Worker's own
	// reading may end it.
	running map[string]bool
	// wait is closed and replaced whenever the scheduler makes progress, so a
	// test can await a quiet queue without polling a sleep.
	idle chan struct{}
	// timeout bounds one operation. A `git push` to an unreachable remote must
	// not hold a worktree forever.
	timeout time.Duration
}

func newQueue(service *Service) *queue {
	return &queue{
		service: service,
		held:    map[string]bool{},
		running: map[string]bool{},
		idle:    make(chan struct{}),
		timeout: 10 * time.Minute,
	}
}

func lockKeys(operation *pb.GitOperation) (common, worktree string, refWork bool) {
	scope := operation.GetScope()
	worktree = "worktree:" + scope.GetWorkspaceId() + "\x00" + scope.GetRepositoryPath()
	common = "common:" + scope.GetWorkspaceId() + "\x00" + scope.GetRepositoryId()
	if scope.GetRepositoryId() == "" {
		// No repository id means this Host cannot tell which checkouts share a
		// common dir. Serializing the operation against its own checkout only
		// is the conservative reading: it never claims an exclusion it has not
		// established.
		common = worktree
	}
	return common, worktree, refKind(operation.GetKind())
}

// submit adds one entry and starts whatever can now run.
func (q *queue) submit(workspaceID string, operation *pb.GitOperation, root string) {
	common, worktree, refWork := lockKeys(operation)
	q.mu.Lock()
	q.pending = append(q.pending, scheduled{
		workspaceID: workspaceID,
		operationID: operation.GetOperationId(),
		root:        root,
		commonKey:   common,
		worktreeKey: worktree,
		refWork:     refWork,
	})
	q.mu.Unlock()
	q.dispatch()
}

// withdraw removes a still-queued entry and reports whether it did. An entry
// that has already been handed to the execution host is not withdrawn: the
// caller then has to ask the execution host to stop, and take its answer.
func (q *queue) withdraw(workspaceID, operationID string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.running[operationID] {
		return false
	}
	for index, entry := range q.pending {
		if entry.workspaceID == workspaceID && entry.operationID == operationID {
			q.pending = append(q.pending[:index], q.pending[index+1:]...)
			return true
		}
	}
	// Not pending and not running: nothing of this Host's is in flight, so the
	// caller may end it as its own decision.
	return true
}

// dispatch starts every pending entry whose locks are free.
//
// It walks the queue head first and does not skip past a blocked entry onto a
// later one for the *same* locks — that is what makes one worktree's writes
// sequential in submission order — but it does start a later entry for
// different locks, which is what makes two worktrees parallel.
func (q *queue) dispatch() {
	q.mu.Lock()
	blocked := map[string]bool{}
	started := []scheduled{}
	remaining := q.pending[:0:0]
	for _, entry := range q.pending {
		keys := entry.locks()
		free := true
		for _, key := range keys {
			if q.held[key] || blocked[key] {
				free = false
			}
		}
		if !free {
			// Everything this entry wanted is now spoken for by an earlier
			// entry, so a later one asking for the same key waits behind it
			// rather than overtaking it.
			for _, key := range keys {
				blocked[key] = true
			}
			remaining = append(remaining, entry)
			continue
		}
		for _, key := range keys {
			q.held[key] = true
		}
		q.running[entry.operationID] = true
		started = append(started, entry)
	}
	q.pending = remaining
	q.mu.Unlock()
	for _, entry := range started {
		go q.run(entry)
	}
}

// locks returns this entry's keys in acquisition order: the common git dir
// first when the operation touches refs, then the worktree.
func (s scheduled) locks() []string {
	if s.refWork && s.commonKey != s.worktreeKey {
		return []string{s.commonKey, s.worktreeKey}
	}
	if s.refWork {
		return []string{s.commonKey}
	}
	return []string{s.worktreeKey}
}

// run hands one entry to the execution host and records what came back.
func (q *queue) run(entry scheduled) {
	defer q.release(entry)
	service := q.service
	ctx, cancel := context.WithTimeout(context.Background(), q.timeout)
	defer cancel()

	operation, err := service.operation(ctx, entry.workspaceID, entry.operationID)
	if err != nil {
		return
	}
	// The entry is marked RUNNING *before* the command starts, and that write
	// is committed. It is the whole point of the domain: a Host killed a
	// millisecond later still holds the record that this was attempted, which
	// is what the reconciler reads.
	starting := proto.Clone(operation).(*pb.GitOperation)
	starting.State = pb.GitOperationState_GIT_OPERATION_STATE_RUNNING
	starting.StartedAtUnixMs = service.now()
	running, err := service.record(ctx, entry.workspaceID, starting, operation.GetRevision(), "start")
	if err != nil {
		return
	}
	outcome, err := service.executor.RunGitOperation(ctx, running, entry.root)
	next := proto.Clone(running).(*pb.GitOperation)
	next.FinishedAtUnixMs = service.now()
	switch {
	case err != nil:
		// The Worker did not answer. Whether the command ran is exactly what
		// this Host cannot know, so it says so rather than choosing.
		next.State = pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME
		next.MessageCode = "git.operation.channel_lost"
	case outcome == nil:
		next.State = pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME
		next.MessageCode = "git.operation.no_outcome"
	default:
		// The Worker's reading wins on everything it observed; the identity,
		// the decision and the times stay this Host's.
		next.State = outcome.GetState()
		next.MessageCode = outcome.GetMessageCode()
		next.Progress = outcome.GetProgress()
		next.Affected = boundedAffected(outcome.GetAffected())
		if !terminal(next.GetState()) {
			// A Worker that answered with a non-final state has not said what
			// happened, which is an unknown outcome and not a queue that is
			// still running.
			next.State = pb.GitOperationState_GIT_OPERATION_STATE_UNKNOWN_OUTCOME
			next.MessageCode = "git.operation.no_outcome"
		}
	}
	// The row may have moved while the command ran: a progress report from the
	// execution host advances the same entry. Re-reading the revision here is
	// what keeps the outcome from being lost to a percentage — the outcome is
	// the one write in this domain that must not fail a compare-and-set, since
	// nothing else will ever say what happened.
	expected := running.GetRevision()
	if current, readErr := service.operation(ctx, entry.workspaceID, entry.operationID); readErr == nil {
		expected = current.GetRevision()
	}
	if _, err = service.record(ctx, entry.workspaceID, next, expected, "finish"); err != nil {
		return
	}
	// A write that changed the checkout invalidates the cached snapshot, so the
	// next reader sees the repository rather than the picture from before.
	service.refresh(ctx, entry.workspaceID, running.GetScope(), entry.root)
}

func boundedAffected(values []string) []string {
	if len(values) > MaxAffected {
		values = values[:MaxAffected]
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if len(value) <= MaxPathBytes {
			result = append(result, value)
		}
	}
	return result
}

func (q *queue) release(entry scheduled) {
	q.mu.Lock()
	for _, key := range entry.locks() {
		delete(q.held, key)
	}
	delete(q.running, entry.operationID)
	close(q.idle)
	q.idle = make(chan struct{})
	q.mu.Unlock()
	q.dispatch()
}

// quiet blocks until nothing is pending or running, or the deadline passes. It
// exists for tests and for the switch, which has to be able to say "the queue
// is empty" rather than "the queue was empty a moment ago".
func (q *queue) quiet(ctx context.Context) bool {
	for {
		q.mu.Lock()
		empty := len(q.pending) == 0 && len(q.running) == 0
		wait := q.idle
		q.mu.Unlock()
		if empty {
			return true
		}
		select {
		case <-wait:
		case <-ctx.Done():
			return false
		}
	}
}

// active reports how many of this Host's own git writes are in flight. A switch
// reads it, and refuses to move the domain while it is not zero.
func (q *queue) active() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.pending) + len(q.running)
}
