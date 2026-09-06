package worker

import (
	"context"
	"slices"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The git frames of the Worker channel (action/result 29;
// Go Host 业务所有权迁移 §2.8, §2.9).
//
// Every method here is the Host asking the execution host to do something it
// cannot do itself, and every answer is that host's own reading rather than an
// echo. That distinction is the reason the frames exist at all: the Host owns
// the decision to run a `git push` and the order it runs in, and the execution
// host owns the only true statement about what happened when it ran.
//
// Nothing here schedules. The queue is in `githost`, and a client that reordered
// requests would put the exclusion the queue establishes back into two places.

// GitCapability is what a Worker must advertise before this client will send it
// a git frame. It is a separate statement from the ownership capability: a
// Worker that can record an epoch is not necessarily one that was given a
// workspace it can run commands in.
const GitCapability = "git.worker.v1"

// SupportsGit reports whether this Worker said it can answer a git frame.
func (c *Client) SupportsGit() bool {
	return c != nil && c.hello != nil && slices.Contains(c.hello.Capabilities, GitCapability)
}

// validGitResult checks that a reply answers the frame that was sent.
//
// It is deliberately shallow. Whether an outcome is believable is the queue's
// question, and it is asked in `githost` against the entry this Host stored;
// what this function refuses is a reply that answers a different question —
// an outcome for another operation, a snapshot in place of a repository — which
// a later comparison would otherwise make against the wrong subject.
func validGitResult(input *pb.GitWorkerRequest, result *pb.GitWorkerResponse) bool {
	if result == nil {
		return false
	}
	switch action := input.GetAction().(type) {
	case *pb.GitWorkerRequest_Run:
		outcome := result.GetOperation().GetOperation()
		return outcome != nil && outcome.GetOperationId() == action.Run.GetOperation().GetOperationId()
	case *pb.GitWorkerRequest_Cancel:
		outcome := result.GetOperation().GetOperation()
		return outcome != nil && outcome.GetOperationId() == action.Cancel.GetOperationId()
	case *pb.GitWorkerRequest_Observe:
		state := result.GetRepository()
		// The observation time is what makes the answer a reading rather than
		// a claim, so a snapshot without one is refused here: a cache that
		// cannot say when it was taken cannot be told from the repository.
		return state != nil && state.GetObservedAtUnixMs() > 0
	case *pb.GitWorkerRequest_Read:
		read := result.GetRead()
		return read != nil && read.GetHttpStatus() >= 100 && read.GetHttpStatus() < 600
	case *pb.GitWorkerRequest_Snapshot:
		// An empty snapshot is the answer a switch proceeds on, so it must be
		// distinguishable from no snapshot at all.
		return result.GetSnapshot() != nil
	default:
		return false
	}
}

func (c *Client) gitExchange(ctx context.Context, action *pb.GitWorkerRequest) (*pb.GitWorkerResponse, error) {
	if c == nil {
		return nil, &Error{Code: CodeUnsupported}
	}
	if !c.SupportsGit() {
		return nil, &Error{Code: CodeUnsupported}
	}
	response, err := c.exchange(ctx, &pb.WorkerRequest{Action: &pb.WorkerRequest_Git{Git: action}}, "git")
	if err != nil {
		return nil, err
	}
	result := response.GetGit()
	if result == nil {
		return nil, &Error{Code: CodeProtocol}
	}
	return result, nil
}

// GitSnapshot reports what the execution host still holds for this domain.
//
// A switch reads it and refuses on a non-zero count. That is why an absent
// snapshot is a protocol failure rather than an empty one: an empty answer
// invented here would let a domain move out from under a running push, and the
// record of that push would then exist nowhere.
func (c *Client) GitSnapshot(ctx context.Context) (*pb.GitDomainSnapshot, error) {
	response, err := c.gitExchange(ctx, &pb.GitWorkerRequest{
		Action: &pb.GitWorkerRequest_Snapshot{Snapshot: &pb.GitDomainSnapshotRequest{}},
	})
	if err != nil {
		return nil, err
	}
	snapshot := response.GetSnapshot()
	if snapshot == nil {
		return nil, &Error{Code: CodeProtocol}
	}
	return snapshot, nil
}

// RunGitOperation runs one queued operation to completion.
//
// The operation travels whole — identity, action bytes, digest and expectations
// — because the execution host re-checks all four before it runs anything. The
// answer is the Worker's reading of the outcome; a reply naming a different
// operation is refused rather than recorded against the one that was sent.
func (c *Client) RunGitOperation(ctx context.Context, operation *pb.GitOperation, workspaceRoot string) (*pb.GitOperation, error) {
	if operation == nil || operation.GetOperationId() == "" || workspaceRoot == "" {
		return nil, &Error{Code: CodeInvalid}
	}
	response, err := c.gitExchange(ctx, &pb.GitWorkerRequest{
		Action: &pb.GitWorkerRequest_Run{Run: &pb.RunGitOperationRequest{
			Operation:     proto.Clone(operation).(*pb.GitOperation),
			WorkspaceRoot: workspaceRoot,
		}},
	})
	if err != nil {
		return nil, err
	}
	outcome := response.GetOperation().GetOperation()
	if outcome == nil || outcome.GetOperationId() != operation.GetOperationId() {
		return nil, &Error{Code: CodeProtocol}
	}
	return outcome, nil
}

// CancelGitOperation asks the execution host to stop. It answers nothing but
// success or failure of the *request*: whether the command had already changed
// the repository is the outcome frame's business, not this one's.
func (c *Client) CancelGitOperation(ctx context.Context, operationID, workspaceRoot, repositoryPath string) error {
	if operationID == "" || workspaceRoot == "" {
		return &Error{Code: CodeInvalid}
	}
	_, err := c.gitExchange(ctx, &pb.GitWorkerRequest{
		Action: &pb.GitWorkerRequest_Cancel{Cancel: &pb.CancelGitOperationWorkerRequest{
			OperationId:    operationID,
			WorkspaceRoot:  workspaceRoot,
			RepositoryPath: repositoryPath,
		}},
	})
	return err
}

// ObserveRepository reads one checkout's current state.
func (c *Client) ObserveRepository(ctx context.Context, scope *pb.RepositoryScope, workspaceRoot string) (*pb.RepositoryState, error) {
	if scope == nil || workspaceRoot == "" {
		return nil, &Error{Code: CodeInvalid}
	}
	response, err := c.gitExchange(ctx, &pb.GitWorkerRequest{
		Action: &pb.GitWorkerRequest_Observe{Observe: &pb.ObserveRepositoryRequest{
			Scope:         proto.Clone(scope).(*pb.RepositoryScope),
			WorkspaceRoot: workspaceRoot,
		}},
	})
	if err != nil {
		return nil, err
	}
	state := response.GetRepository()
	if state == nil {
		return nil, &Error{Code: CodeProtocol}
	}
	return state, nil
}

// ReadGit forwards one repository query and returns the status the Runtime's
// own route would have produced. A failing status is not an error here: a
// not-found repository is an answer the caller renders, and turning it into a
// transport failure would lose which of the two it was.
func (c *Client) ReadGit(ctx context.Context, read *pb.GitRead) (*pb.GitReadResult, error) {
	if read == nil || read.GetWorkspaceRoot() == "" {
		return nil, &Error{Code: CodeInvalid}
	}
	response, err := c.gitExchange(ctx, &pb.GitWorkerRequest{
		Action: &pb.GitWorkerRequest_Read{Read: proto.Clone(read).(*pb.GitRead)},
	})
	if err != nil {
		return nil, err
	}
	result := response.GetRead()
	if result == nil || result.GetHttpStatus() == 0 {
		return nil, &Error{Code: CodeProtocol}
	}
	return result, nil
}
