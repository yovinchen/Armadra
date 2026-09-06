package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"sync"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/githost"
	"armadra.local/host/internal/storage"
	"armadra.local/host/internal/worker"
)

// How this Host reaches Git (Go Host 业务所有权迁移 §2.8, §2.9).
//
// There are two shapes of Worker here, and the difference between them is the
// lifetime of the work rather than a preference.
//
// **One Worker per operation.** A `git commit`, a `push`, a branch switch: the
// exclusion that matters — one write per worktree, refs taken in a fixed lock
// order — is established by the Host's queue before a Worker is started at all,
// so a per-operation process adds no race; what it adds is isolation. A rebase
// that wedges, a credential helper that hangs on a prompt, a hook that never
// returns: each takes down one process that was running one operation, rather
// than a resident Worker that also serves files and terminals.
//
// **One resident Worker for clones.** A clone is the one thing whose job
// outlives the frame that started it: `git clone` keeps running after the
// answer is written, and the job lives in the Worker's own registry. A process
// that ended would take the job with it and no later process could poll what it
// began — which is why clones used to answer UNSUPPORTED. So the clone frames,
// and only those, go to a Worker this Host keeps open.
//
// Both are started with a private state directory, which is what opens the
// durable upcall outbox and lets the execution host report progress upward
// (§2.9 上行帧 180). The earlier build withheld it deliberately, on the grounds
// that a Worker without one cannot run arbitrary commands. That reasoning was
// about a surface nobody can reach: the only thing that ever writes to this
// process's stdin is this Host, and it writes git frames. What the directory
// buys is the thing a person actually sees — a progress bar that moves during a
// fetch, a push and a clone instead of a spinner that ends.
//
// **Private** is the operative word: one directory per Worker, not one shared
// between them. A state directory is a Worker's own journal and outbox, and two
// processes opening one is a contended SQLite file that fails a frame outright
// — which `TestRealRustWorkersShareOneStateDirectoryConcurrently` demonstrates,
// and which the queue would produce constantly, since running different
// worktrees in parallel is the whole point of it.
type gitExecutor struct {
	executable string
	hostID     string
	// stateRoot is where each Worker's private state directory is made. Empty
	// means this Host takes no progress reports and every Worker runs exactly as
	// it did before.
	stateRoot string
	upcalls   worker.UpcallSink
	timeout   time.Duration

	mu sync.Mutex
	// resident serves the clone frames. It is opened on the first clone and
	// kept until it fails, because a clone job cannot be polled from a
	// different process than the one that started it.
	resident *worker.Client
	// residentState removes that Worker's private state directory when it goes.
	residentState func()
	closed        bool
}

// newGitExecutor answers an untyped nil when there is no Runtime binary to run,
// rather than a typed nil that would satisfy the interface and then fail on
// every call. "This Host has no execution channel" is a thing the service
// answers UNSUPPORTED for, and it has to be able to see it.
func newGitExecutor(executable, hostID, stateRoot string, upcalls worker.UpcallSink) githost.Executor {
	if executable == "" {
		return nil
	}
	if stateRoot != "" {
		// A state root that cannot be made private is not used. Losing progress
		// reports is visible and harmless; running with a directory somebody
		// else can read is neither.
		if err := os.MkdirAll(stateRoot, 0o700); err != nil {
			stateRoot = ""
		} else if err = storage.ProtectArtifactDirectory(stateRoot); err != nil {
			stateRoot = ""
		}
	}
	return &gitExecutor{executable: executable, hostID: hostID, stateRoot: stateRoot, upcalls: upcalls, timeout: gitFrameTimeout}
}

// privateState makes one Worker's own state directory and answers the function
// that removes it.
//
// An empty name is a Worker without an outbox, which is a Worker that cannot
// report progress and is otherwise identical. That is the right failure: a
// directory this Host could not create privately must not become a directory it
// uses anyway, and a stalled progress bar is a smaller loss than a shared
// journal that fails frames.
func (g *gitExecutor) privateState() (string, func()) {
	if g.stateRoot == "" {
		return "", func() {}
	}
	name := make([]byte, 8)
	if _, err := rand.Read(name); err != nil {
		return "", func() {}
	}
	// Short on purpose: the Worker binds a Unix socket inside this directory,
	// and that path has a hard length limit far below what a filesystem allows.
	directory := filepath.Join(g.stateRoot, hex.EncodeToString(name))
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", func() {}
	}
	if err := storage.ProtectArtifactDirectory(directory); err != nil {
		_ = os.RemoveAll(directory)
		return "", func() {}
	}
	return directory, func() { _ = os.RemoveAll(directory) }
}

// gitFrameTimeout is the Worker transport's own ceiling for one frame, and this
// executor asks for all of it.
//
// It is a real limit rather than a generous one: a `git push` to a slow remote
// can outlast a minute, and when it does this Host reports UNKNOWN_OUTCOME —
// which is the correct answer, because the frame ended without a reading and
// nobody here knows whether the remote took it. What it costs is that an
// operation which *did* succeed can be recorded as unknown. Progress reports do
// not move that cliff; they only make it visible while it approaches.
const gitFrameTimeout = time.Minute

// cloneFrameTimeout bounds one *clone* frame, which is not the clone. Starting,
// polling and cancelling a clone are each a question with an immediate answer;
// the `git clone` itself runs on in the resident Worker and is bounded by that
// Worker's own clone timeout, not by this.
const cloneFrameTimeout = 30 * time.Second

func (g *gitExecutor) options(state string, timeout time.Duration) worker.Options {
	return worker.Options{
		Executable:     g.executable,
		HostID:         g.hostID,
		StateDir:       state,
		RequestTimeout: timeout,
		Upcalls:        g.upcalls,
	}
}

// with opens one Worker, runs `action`, and closes it. A Worker that did not
// advertise the git capability is refused here rather than sent a frame it
// would answer with an error.
func (g *gitExecutor) with(ctx context.Context, action func(client *worker.Client) error) error {
	state, discard := g.privateState()
	defer discard()
	client, err := worker.Start(ctx, g.options(state, g.timeout))
	if err != nil {
		return err
	}
	defer client.Close()
	if !client.SupportsGit() {
		return githost.ErrUnsupported
	}
	return action(client)
}

// withResident runs `action` against the Worker this Host keeps open for
// clones, starting it if there is none.
//
// A failure closes it. The next call then starts a fresh one, which is the only
// honest recovery: a channel that answered an error is a channel whose clone
// registry this Host can no longer reason about, and reusing it would report
// progress for jobs that may no longer exist.
func (g *gitExecutor) withResident(ctx context.Context, action func(client *worker.Client) error) error {
	client, err := g.residentClient(ctx)
	if err != nil {
		return err
	}
	if err = action(client); err != nil {
		g.dropResident(client)
	}
	return err
}

func (g *gitExecutor) residentClient(ctx context.Context) (*worker.Client, error) {
	g.mu.Lock()
	if g.closed {
		g.mu.Unlock()
		return nil, githost.ErrUnsupported
	}
	if g.resident != nil {
		client := g.resident
		g.mu.Unlock()
		return client, nil
	}
	g.mu.Unlock()
	// Started outside the lock: spawning a process takes long enough that
	// holding a mutex across it would serialize every clone status poll behind
	// one start. A second start that loses the race is closed below.
	state, discard := g.privateState()
	client, err := worker.Start(context.WithoutCancel(ctx), g.options(state, cloneFrameTimeout))
	if err != nil {
		discard()
		return nil, err
	}
	if !client.SupportsGit() {
		_ = client.Close()
		discard()
		return nil, githost.ErrUnsupported
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed || g.resident != nil {
		existing := g.resident
		_ = client.Close()
		discard()
		if existing != nil {
			return existing, nil
		}
		return nil, githost.ErrUnsupported
	}
	g.resident, g.residentState = client, discard
	return client, nil
}

func (g *gitExecutor) dropResident(client *worker.Client) {
	g.mu.Lock()
	discard := func() {}
	if g.resident == client {
		g.resident = nil
		if g.residentState != nil {
			discard, g.residentState = g.residentState, nil
		}
	} else {
		client = nil
	}
	g.mu.Unlock()
	if client != nil {
		_ = client.Close()
	}
	discard()
}

// Close stops the resident clone Worker. A clone still running inside it ends
// with the process, which is the same thing that happens when the Host stops
// for any other reason — and the job's last recorded state stays in the store,
// so what is lost is the progress after that point, never the record that a
// clone was started.
func (g *gitExecutor) Close() error {
	g.mu.Lock()
	client := g.resident
	discard := g.residentState
	g.resident, g.residentState, g.closed = nil, nil, true
	g.mu.Unlock()
	if discard != nil {
		defer discard()
	}
	if client == nil {
		return nil
	}
	return client.Close()
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

// cloneMethod names the reads whose work outlives the frame, and which
// therefore have to reach the same process every time.
func cloneMethod(method pb.GitReadMethod) bool {
	switch method {
	case pb.GitReadMethod_GIT_READ_METHOD_CLONE_START,
		pb.GitReadMethod_GIT_READ_METHOD_CLONE_STATUS,
		pb.GitReadMethod_GIT_READ_METHOD_CLONE_CANCEL:
		return true
	default:
		return false
	}
}

func (g *gitExecutor) ReadGit(ctx context.Context, read *pb.GitRead) (*pb.GitReadResult, error) {
	var result *pb.GitReadResult
	run := func(client *worker.Client) error {
		value, err := client.ReadGit(ctx, read)
		result = value
		return err
	}
	if cloneMethod(read.GetMethod()) {
		return result, g.withResident(ctx, run)
	}
	err := g.with(ctx, run)
	return result, err
}

// GitSnapshot asks what the execution host still holds.
//
// It is asked of the resident Worker when there is one, because that is the
// process a clone would be running in: a fresh Worker has never started
// anything and would truthfully answer zero to a question about somebody else.
// With no resident Worker a fresh one is asked, and its zero is the real
// answer — nothing of this Host's is in flight anywhere.
func (g *gitExecutor) GitSnapshot(ctx context.Context) (*pb.GitDomainSnapshot, error) {
	var snapshot *pb.GitDomainSnapshot
	run := func(client *worker.Client) error {
		result, err := client.GitSnapshot(ctx)
		snapshot = result
		return err
	}
	g.mu.Lock()
	resident := g.resident
	g.mu.Unlock()
	if resident != nil {
		if err := g.withResident(ctx, run); err == nil {
			return snapshot, nil
		}
	}
	err := g.with(ctx, run)
	return snapshot, err
}
