// Package githost is the Host's git domain: which write was asked for, in what
// order it runs, what it was decided against, and what happened to it
// (Go Host 业务所有权迁移 §2.8, Git 设计 §2, §10).
//
// It runs no Git. Every command still executes on the execution host, holding
// that host's repository locks and reading that host's credentials, and it
// keeps doing so whichever side owns this record — a Host that ran Git would be
// a second checkout, and two processes running `git commit` against one index
// is the outcome no protocol can make safe.
//
// What moves here is the part the Runtime could not keep. Its queue lived in
// memory, so a restart lost the record that a push had been attempted at all,
// which is exactly the case where "did that reach the remote?" has to be
// answerable. An operation now exists before anything runs, survives the
// process, and is reconciled rather than guessed at.
//
// Four rules are the whole of the domain:
//
//  1. **One entry point.** Every write is an `Enqueue`. Thirty per-action
//     routes would be thirty places to forget the queue, and the queue is the
//     part that cannot be forgotten.
//  2. **One worktree at a time.** Writes to one checkout are serialized;
//     different checkouts run in parallel; anything touching refs or the
//     worktree list of a shared common git dir takes that dir's lock, in a
//     fixed order, so two repositories that share one cannot deadlock.
//  3. **A decision names what it was decided against.** `expected` carries the
//     HEAD, index or ref the caller read, and the Worker re-reads them
//     immediately before running. An external `git commit` in between is a
//     conflict, never an overwrite.
//  4. **An unknown outcome stays unknown.** It is its own state, never
//     collapsed into a failure and never retried on its own.
package githost

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const (
	// The git surface is governed by the grants that already govern the
	// Runtime's git routes, not by a new pair of its own.
	//
	// This is deliberate and it is what makes §6.3's permission table
	// comparable across the switch: the same device with the same grants must
	// get the same allow/deny answer before and after the domain moves. A
	// separate `git:*` spelling of its own would make that table incomparable
	// by construction, and would lock out every device paired before it
	// existed, since a device's grants are frozen at pairing.
	ScopeRead  = "git:read"
	ScopeWrite = "git:write"
	// Running a Git command makes the machine execute something, so it is the
	// execute class in `scopes.go` and needs terminal:write on top of the
	// area's write grant. A device with git:write and no terminal:write can
	// read the panel and cannot make the host run `git push`.
	ScopeExecute = "terminal:write"

	// Stored kinds. They are the domain's name and the entity's, joined the way
	// §3.1 spells it, and they are what this domain's event projector claims.
	OperationKind  = "git.operation"
	RepositoryKind = "git.repository"
	CloneKind      = "git.clone"

	// MaxPage bounds one listing of the queue.
	MaxPage = 200

	// MaxActive is how many operations one workspace may have queued or running
	// at once. It is a backstop against a client that enqueues in a loop, not a
	// number anyone reaches: a person presses one button at a time.
	MaxActive = 64

	// MaxActionBytes bounds one action body. A Git command's parameters are a
	// branch name and a few paths; anything larger is a mistake or an attack
	// rather than a user with a lot to say.
	MaxActionBytes = 256 << 10

	// MaxAffected bounds the paths one outcome reports back.
	MaxAffected = 200

	// MaxPathBytes bounds a repository or target path.
	MaxPathBytes = 4096
)

var (
	ErrInvalid       = errors.New("invalid git request")
	ErrAuthorization = errors.New("git permission denied")
	// ErrOwnershipMoved is the stable refusal a write gets while this process
	// is not the settled owner. There is no dual-write mode: two queues over
	// one repository is the thing this record exists to prevent.
	ErrOwnershipMoved = errors.New("ownership_moved")
	ErrNotFound       = errors.New("that git operation is unknown here")
	// ErrBusy means the workspace already has as many operations in flight as
	// it may have. It is a refusal to queue, never a silent drop.
	ErrBusy = errors.New("too many git operations are already in flight")
	// ErrUnsupported means this Host has no way to reach a Worker, so it cannot
	// honestly accept a write it could never run.
	ErrUnsupported = errors.New("this Host has no execution channel for git")
	// ErrTerminal means the operation has already finished. Cancelling it would
	// be a statement about something that is no longer happening.
	ErrTerminal = errors.New("that git operation has already finished")
	// ErrOutsideRoot means the checkout is not under the root the filesystem
	// domain registered for this workspace (Git 设计 §5.1, §5.3).
	//
	// It is its own error rather than a plain authorization failure because it
	// names the fixable thing. A Frame bound to a worktree somebody moved out
	// of the project is not a device without a grant; it is a binding that
	// drifted, and the panel's repair is to re-point or unbind it. The
	// execution host refuses the same path for the same reason — this is the
	// Host making the same statement about a request it can decide without
	// starting a process.
	ErrOutsideRoot = errors.New("that checkout is outside the workspace root")
)

// Domain is the name this package is registered under in the switch order.
const Domain = storage.OwnershipDomainGit

var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$`)

func validID(value string) bool { return idPattern.MatchString(value) }

// validPath is what this Host will record as a checkout. It is checked rather
// than resolved: the directory is on the execution host and this Host has no
// business resolving it. What is refused is a shape that could not be an
// absolute path anywhere.
func validPath(value string) bool {
	if value == "" || len(value) > MaxPathBytes || strings.ContainsRune(value, 0) {
		return false
	}
	if !strings.HasPrefix(value, "/") && !windowsAbsolute(value) {
		return false
	}
	for _, segment := range strings.Split(strings.ReplaceAll(value, "\\", "/"), "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

// insideRoot reports whether an absolute checkout path lies within the
// workspace root the filesystem domain registered (Git 设计 §5.1).
//
// It is a *textual* containment check on two already-canonical absolute paths,
// and it is deliberately not more than that: the directories are on the
// execution host, so resolving symlinks here would be this Host guessing about
// a filesystem it cannot see. The execution host makes the same check against
// the real directory and is the one that can refuse a symlink that leaves the
// root; this refuses the shapes that never needed a filesystem to be wrong —
// a sibling directory, a parent, an unrelated tree — before a process is
// started for them.
//
// Separators are normalized because a Host on one operating system queues
// operations for execution hosts on another, and the comparison is on segment
// boundaries so `/project-old` is not read as being inside `/project`.
func insideRoot(root, path string) bool {
	if root == "" || path == "" {
		return false
	}
	root, path = normalizeRoot(root), normalizeRoot(path)
	if path == root {
		return true
	}
	return strings.HasPrefix(path, root+"/")
}

// normalizeRoot puts one absolute path into the single spelling this comparison
// uses: forward separators, no trailing slash, and no leading `/private`.
//
// The last of those is not cosmetic. On macOS `/var/folders/…` and
// `/private/var/folders/…` are the same directory reached through a symlinked
// prefix, and both are ordinary: a registration canonicalizes to one while a
// client that read the path from somewhere else holds the other. Comparing the
// strings as given would refuse a checkout inside the very root registered for
// it — the same trap `worker/git.rs` avoids by canonicalizing both sides, which
// this Host cannot do because the directory is on another machine.
func normalizeRoot(value string) string {
	value = strings.ReplaceAll(value, "\\", "/")
	for len(value) > 1 && strings.HasSuffix(value, "/") {
		value = value[:len(value)-1]
	}
	if trimmed, found := strings.CutPrefix(value, "/private/"); found {
		value = "/" + trimmed
	}
	return value
}

// windowsAbsolute recognises `C:\dir` and `\\server\share`. A Host on Linux
// still queues operations for Windows execution hosts, so the shape is accepted
// by spelling rather than by the Host's own operating system.
func windowsAbsolute(value string) bool {
	if strings.HasPrefix(value, `\\`) {
		return true
	}
	return len(value) >= 3 && value[1] == ':' && (value[2] == '\\' || value[2] == '/') &&
		((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z'))
}

// validScope checks the addressing of one request. `repository_path` is the
// identity that matters: `repository_id` is shared by every worktree of one
// repository, so it can never stand in for the checkout being written.
func validScope(scope *pb.RepositoryScope, workspaceID string) error {
	if scope == nil || scope.GetWorkspaceId() != workspaceID || !validPath(scope.GetRepositoryPath()) {
		return ErrInvalid
	}
	if id := scope.GetRepositoryId(); id != "" && (len(id) != 64 || !hexadecimal(id)) {
		return ErrInvalid
	}
	// An execution host identifier is a `settings.ssh.hosts[].id`, which a
	// person names: bounded and screened for control characters rather than
	// held to the key alphabet.
	if host := scope.GetExecutionHostId(); len(host) > 256 || strings.ContainsRune(host, 0) {
		return ErrInvalid
	}
	if id := scope.GetWorktreeId(); len(id) > 256 || strings.ContainsRune(id, 0) {
		return ErrInvalid
	}
	return nil
}

func hexadecimal(value string) bool {
	_, err := hex.DecodeString(value)
	return err == nil
}

// repositoryKey is the entity id of one checkout's cached state. It is the
// digest of the path rather than the path itself, so an entity id stays bounded
// and printable whatever the directory is called.
func repositoryKey(path string) string {
	sum := sha256.Sum256([]byte(path))
	return hex.EncodeToString(sum[:])
}

// terminal reports whether a state is final. Only QUEUED and RUNNING are not:
// AWAITING_RESOLUTION is terminal for the queue because the operation is
// waiting for a person, and the queue must not hold a worktree's lock while it
// does.
func terminal(state pb.GitOperationState) bool {
	switch state {
	case pb.GitOperationState_GIT_OPERATION_STATE_QUEUED, pb.GitOperationState_GIT_OPERATION_STATE_RUNNING:
		return false
	default:
		return true
	}
}

// networkKind reports whether an interrupted operation of this kind could have
// changed something on a remote. Those are the ones whose outcome no local
// reading can settle, which is what `UNKNOWN_OUTCOME` says.
func networkKind(kind pb.GitActionKind) bool {
	switch kind {
	case pb.GitActionKind_GIT_ACTION_KIND_FETCH,
		pb.GitActionKind_GIT_ACTION_KIND_PULL,
		pb.GitActionKind_GIT_ACTION_KIND_PUSH,
		pb.GitActionKind_GIT_ACTION_KIND_SYNC,
		pb.GitActionKind_GIT_ACTION_KIND_PUSH_TAG:
		return true
	default:
		return false
	}
}

// refKind reports whether this kind touches the refs or the worktree list of
// the shared common git dir rather than only one checkout's index and files.
// Those are the ones that also take the repository-wide lock (Git 设计 §2).
func refKind(kind pb.GitActionKind) bool {
	switch kind {
	case pb.GitActionKind_GIT_ACTION_KIND_CREATE_BRANCH,
		pb.GitActionKind_GIT_ACTION_KIND_SWITCH_BRANCH,
		pb.GitActionKind_GIT_ACTION_KIND_DELETE_BRANCH,
		pb.GitActionKind_GIT_ACTION_KIND_RENAME_BRANCH,
		pb.GitActionKind_GIT_ACTION_KIND_CREATE_TAG,
		pb.GitActionKind_GIT_ACTION_KIND_DELETE_TAG,
		pb.GitActionKind_GIT_ACTION_KIND_FETCH,
		pb.GitActionKind_GIT_ACTION_KIND_PULL,
		pb.GitActionKind_GIT_ACTION_KIND_PUSH,
		pb.GitActionKind_GIT_ACTION_KIND_SYNC,
		pb.GitActionKind_GIT_ACTION_KIND_PUSH_TAG,
		pb.GitActionKind_GIT_ACTION_KIND_CREATE_WORKTREE,
		pb.GitActionKind_GIT_ACTION_KIND_REMOVE_WORKTREE:
		return true
	default:
		return false
	}
}

// knownKind is the closed list. A kind this build cannot classify is refused
// rather than queued: the Host decides serialization and lock order from the
// kind, and it cannot order an action it cannot name.
func knownKind(kind pb.GitActionKind) bool {
	if kind == pb.GitActionKind_GIT_ACTION_KIND_UNSPECIFIED || kind == pb.GitActionKind_GIT_ACTION_KIND_UNSUPPORTED {
		return false
	}
	_, ok := pb.GitActionKind_name[int32(kind)]
	return ok
}

func knownReadMethod(method pb.GitReadMethod) bool {
	if method == pb.GitReadMethod_GIT_READ_METHOD_UNSPECIFIED {
		return false
	}
	_, ok := pb.GitReadMethod_name[int32(method)]
	return ok
}

// payload is the entity as it is published on the event stream: the message
// with its revision cleared, marshalled deterministically so an unchanged
// operation produces identical bytes.
func payload(value proto.Message) ([]byte, error) {
	return (proto.MarshalOptions{Deterministic: true}).Marshal(value)
}

func operationPayload(operation *pb.GitOperation) ([]byte, error) {
	clone, _ := proto.Clone(operation).(*pb.GitOperation)
	clone.Revision = 0
	return payload(clone)
}

func repositoryPayload(state *pb.RepositoryState) ([]byte, error) {
	clone, _ := proto.Clone(state).(*pb.RepositoryState)
	clone.Revision = 0
	return payload(clone)
}

func clonePayload(job *pb.GitCloneJob) ([]byte, error) {
	clone, _ := proto.Clone(job).(*pb.GitCloneJob)
	clone.Revision = 0
	return payload(clone)
}

func decodeOperation(entity storage.Entity) (*pb.GitOperation, error) {
	value := new(pb.GitOperation)
	if err := proto.Unmarshal(entity.Payload, value); err != nil {
		return nil, storage.ErrCorrupt
	}
	value.Revision = entity.Revision
	return value, nil
}

func decodeRepository(entity storage.Entity) (*pb.RepositoryState, error) {
	value := new(pb.RepositoryState)
	if err := proto.Unmarshal(entity.Payload, value); err != nil {
		return nil, storage.ErrCorrupt
	}
	value.Revision = entity.Revision
	return value, nil
}

func decodeClone(entity storage.Entity) (*pb.GitCloneJob, error) {
	value := new(pb.GitCloneJob)
	if err := proto.Unmarshal(entity.Payload, value); err != nil {
		return nil, storage.ErrCorrupt
	}
	value.Revision = entity.Revision
	return value, nil
}

// receipt is the operation's outcome in the shared shape. Its `revisions` list
// stays empty on purpose: it exists so a caller can find one object's new
// revision inside a batch, and a git change is always exactly one object, which
// is returned in full next to the receipt.
func receipt(result storage.ApplyResult) *pb.CanvasOperationReceipt {
	return &pb.CanvasOperationReceipt{
		OperationId:   result.OperationID,
		TransactionId: result.TransactionID,
		FirstSequence: result.FirstSequence,
		LastSequence:  result.LastSequence,
		Replayed:      result.Replayed,
	}
}

func digest(value []byte) []byte {
	sum := sha256.Sum256(value)
	return sum[:]
}
