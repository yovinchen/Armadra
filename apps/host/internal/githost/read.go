package githost

import (
	"context"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// Forwarded reads (Go Host 业务所有权迁移 §2.8, "Host 直接转 Worker，结果不入库").
//
// Nothing here is stored, and that is the point. A commit graph the Host cached
// would be a second, staler answer to a question the repository can always
// answer for itself, and the moment two answers exist somebody has to decide
// which one is right — which is the situation the whole domain is arranged to
// avoid. `RepositoryState` is the single exception, and it carries the time it
// was observed precisely so it can never be mistaken for the repository.
//
// What the Host does add is the two things a Worker cannot decide for itself:
//
//   - **whether this device may ask at all**, checked against the session's own
//     grants for this workspace, and
//   - **which directory the answer is about**, resolved from the filesystem
//     domain's registration rather than from the request. A workspace root
//     that arrived inside a git request would be the caller choosing what it is
//     allowed to read.
//
// The body and the answer are the Runtime's own camelCase JSON under the same
// version lock `WorkerServiceRequest` states, and the HTTP status the Runtime's
// own route would have produced comes back unchanged: a not-found stays a
// not-found instead of becoming a 500 on the way through.

// MaxReadBytes bounds one forwarded request body. Reads are queries — a path, a
// reference, a page cursor — not payloads.
const MaxReadBytes = 64 << 10

// Read forwards one repository query to the execution host.
func (s *Service) Read(ctx context.Context, caller Caller, request *pb.ReadGitRequest) (*pb.ReadGitResponse, error) {
	read := request.GetRead()
	if read == nil || !knownReadMethod(read.GetMethod()) || len(read.GetRequestJson()) > MaxReadBytes {
		return nil, ErrInvalid
	}
	// A workspace-wide query names no checkout: `Repositories` is the scan that
	// finds them, so it cannot be asked to name one first.
	if read.GetMethod() == pb.GitReadMethod_GIT_READ_METHOD_REPOSITORIES {
		if scope := read.GetScope(); scope != nil && scope.GetWorkspaceId() != caller.WorkspaceID {
			return nil, ErrAuthorization
		}
	} else if err := validScope(read.GetScope(), caller.WorkspaceID); err != nil {
		return nil, err
	}
	// The AI draft and the hunk previews are the reads that start a program on
	// the machine, so they are the execute class exactly as they are in
	// `scopes.go`. Everything else is a plain read.
	permissions := []string{ScopeRead}
	if executeRead(read.GetMethod()) {
		permissions = []string{ScopeWrite, ScopeExecute}
	}
	if err := s.authorize(caller, permissions...); err != nil {
		return nil, err
	}
	if s.executor == nil {
		return nil, ErrUnsupported
	}
	root, err := s.workspaceRoot(ctx, caller.WorkspaceID)
	if err != nil {
		return nil, err
	}
	forwarded, _ := proto.Clone(read).(*pb.GitRead)
	if forwarded.GetScope() == nil {
		forwarded.Scope = &pb.RepositoryScope{WorkspaceId: caller.WorkspaceID}
	}
	// The root is set here, never taken from the request.
	forwarded.WorkspaceRoot = root
	result, err := s.executor.ReadGit(ctx, forwarded)
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, ErrUnsupported
	}
	return &pb.ReadGitResponse{Result: result}, nil
}

// executeRead names the reads that make the machine run something beyond `git`
// itself. Asking a CLI to draft a commit message starts a program with the
// user's own model account, which is execution however read-only its effect on
// the repository is.
func executeRead(method pb.GitReadMethod) bool {
	switch method {
	case pb.GitReadMethod_GIT_READ_METHOD_MESSAGE_PROVIDERS,
		pb.GitReadMethod_GIT_READ_METHOD_MESSAGE_SOURCE:
		return true
	default:
		return false
	}
}

// GenerateMessage asks the execution host for an AI commit-message draft
// (Git 设计 §6).
//
// It is not an `Enqueue`. Drafting stages nothing, commits nothing and takes no
// repository lock: the answer is text a person then edits, and putting it in
// the write queue would make a suggestion wait behind a push. What it does do
// is run a CLI with the user's own account, so it needs the execute grant.
func (s *Service) GenerateMessage(ctx context.Context, caller Caller, request *pb.GenerateGitMessageRequest) (*pb.GenerateGitMessageResponse, error) {
	if err := s.authorize(caller, ScopeWrite, ScopeExecute); err != nil {
		return nil, err
	}
	if err := validScope(request.GetScope(), caller.WorkspaceID); err != nil {
		return nil, err
	}
	if len(request.GetRequestJson()) > MaxReadBytes {
		return nil, ErrInvalid
	}
	if s.executor == nil {
		return nil, ErrUnsupported
	}
	root, err := s.workspaceRoot(ctx, caller.WorkspaceID)
	if err != nil {
		return nil, err
	}
	result, err := s.executor.ReadGit(ctx, &pb.GitRead{
		Scope:         proto.Clone(request.GetScope()).(*pb.RepositoryScope),
		RequestJson:   append([]byte(nil), request.GetRequestJson()...),
		WorkspaceRoot: root,
		Method:        pb.GitReadMethod_GIT_READ_METHOD_MESSAGE_GENERATE,
	})
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, ErrUnsupported
	}
	return &pb.GenerateGitMessageResponse{Result: result}, nil
}
