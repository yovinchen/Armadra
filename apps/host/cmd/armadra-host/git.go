package main

import (
	"context"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/githost"
	"armadra.local/host/internal/worker"
)

// How this Host reaches Git (Go Host 业务所有权迁移 §2.8, §2.9).
//
// Every git frame runs in its own short-lived Worker, and that is a deliberate
// choice rather than a missing optimisation. The exclusion that matters — one
// write per worktree, refs taken in a fixed lock order — is established by the
// Host's queue before a Worker is started at all, so a per-operation process
// adds no race; what it does add is isolation. A `git rebase` that wedges, a
// credential helper that hangs on a prompt, a hook that never returns: each of
// those takes down one process that was running one operation, rather than the
// resident Worker that also serves files and terminals.
//
// The Worker is started in the plain read-only mode: no state directory, so it
// cannot run arbitrary commands, and no canvas database, so it cannot move an
// epoch. The only thing it can do is answer git frames for the workspace root
// the Host resolved from the filesystem domain and handed it.
//
// The cost is a process spawn per operation, which is small next to the `git`
// subprocess it exists to run, and none at all on the read path a panel repaints
// from — `Read` and `RepositoryState` pay it too, which is the honest trade to
// record: this batch buys isolation and a simple lifetime with a spawn, and a
// resident git Worker is the optimisation to make when the read path shows it
// is needed.
type gitExecutor struct {
	executable string
	hostID     string
	timeout    time.Duration
}

// newGitExecutor answers an untyped nil when there is no Runtime binary to run,
// rather than a typed nil that would satisfy the interface and then fail on
// every call. "This Host has no execution channel" is a thing the service
// answers UNSUPPORTED for, and it has to be able to see it.
func newGitExecutor(executable, hostID string) githost.Executor {
	if executable == "" {
		return nil
	}
	return &gitExecutor{executable: executable, hostID: hostID, timeout: gitFrameTimeout}
}

// gitFrameTimeout is the Worker transport's own ceiling for one frame, and this
// executor asks for all of it.
//
// It is a real limit rather than a generous one: a `git push` to a slow remote
// can outlast a minute, and when it does this Host reports UNKNOWN_OUTCOME —
// which is the correct answer, because the frame ended without a reading and
// nobody here knows whether the remote took it. What it costs is that an
// operation which *did* succeed can be recorded as unknown, and resolving that
// needs the resident git Worker rather than a longer timeout: a longer frame
// would only move the same cliff further out.
const gitFrameTimeout = time.Minute

// with opens one Worker, runs `action`, and closes it. A Worker that did not
// advertise the git capability is refused here rather than sent a frame it
// would answer with an error.
func (g *gitExecutor) with(ctx context.Context, action func(client *worker.Client) error) error {
	client, err := worker.Start(ctx, worker.Options{
		Executable:     g.executable,
		HostID:         g.hostID,
		RequestTimeout: g.timeout,
	})
	if err != nil {
		return err
	}
	defer client.Close()
	if !client.SupportsGit() {
		return githost.ErrUnsupported
	}
	return action(client)
}

func (g *gitExecutor) RunGitOperation(ctx context.Context, operation *pb.GitOperation, workspaceRoot string) (*pb.GitOperation, error) {
	var outcome *pb.GitOperation
	err := g.with(ctx, func(client *worker.Client) error {
		result, err := client.RunGitOperation(ctx, operation, workspaceRoot)
		outcome = result
		return err
	})
	return outcome, err
}

// CancelGitOperation cannot reach the process that is running the operation:
// that process is a different Worker, and this one has no handle on it. What it
// does instead is ask the execution host to record the cancellation for the
// operation id, which the running Worker checks between steps.
func (g *gitExecutor) CancelGitOperation(ctx context.Context, operationID, workspaceRoot, repositoryPath string) error {
	return g.with(ctx, func(client *worker.Client) error {
		return client.CancelGitOperation(ctx, operationID, workspaceRoot, repositoryPath)
	})
}

func (g *gitExecutor) ObserveRepository(ctx context.Context, scope *pb.RepositoryScope, workspaceRoot string) (*pb.RepositoryState, error) {
	var state *pb.RepositoryState
	err := g.with(ctx, func(client *worker.Client) error {
		result, err := client.ObserveRepository(ctx, scope, workspaceRoot)
		state = result
		return err
	})
	return state, err
}

func (g *gitExecutor) ReadGit(ctx context.Context, read *pb.GitRead) (*pb.GitReadResult, error) {
	var result *pb.GitReadResult
	err := g.with(ctx, func(client *worker.Client) error {
		value, err := client.ReadGit(ctx, read)
		result = value
		return err
	})
	return result, err
}

// GitSnapshot asks a fresh Worker what it holds, which is always nothing: a
// process that has just started has no queue. That is the correct answer rather
// than a useless one — this Host runs every git operation in its own Worker, so
// "what does the Runtime still hold" is genuinely zero, and the check that
// matters for a switch is the *Host's* own queue, which `githost` reads
// directly.
//
// It is still asked over the channel rather than answered here, because the
// statement has to come from the side that would know if it were not true.
func (g *gitExecutor) GitSnapshot(ctx context.Context) (*pb.GitDomainSnapshot, error) {
	var snapshot *pb.GitDomainSnapshot
	err := g.with(ctx, func(client *worker.Client) error {
		result, err := client.GitSnapshot(ctx)
		snapshot = result
		return err
	})
	return snapshot, err
}
