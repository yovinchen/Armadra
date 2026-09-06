package githost

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

// Clone jobs (Go Host 业务所有权迁移 §2.8, §3.1 "URL 只存摘要与展示用去凭据形式").
//
// A clone is not an operation on a repository, because the repository does not
// exist yet: there is nothing to lock, nothing to state a precondition against,
// and no worktree to serialize with. So it is its own record with its own
// lifecycle, and it never enters the queue.
//
// The URL is the reason this file exists at all. A clone URL can carry a
// credential — `https://user:token@host/repo.git` is a shape people paste — and
// a row that kept one would turn a database read into a credential leak, on a
// machine whose whole point is that other devices reach it. So the URL is
// forwarded to the execution host, which needs it, and what is *stored* is the
// digest, which is enough to recognise the same clone twice, plus the redacted
// display form produced by the side that held the original.

// MaxURLBytes bounds a clone URL. A repository address is a URL, not a payload.
const MaxURLBytes = 2048

// cloneRequest is the version-locked body the Worker's own clone route takes.
// It is assembled here rather than accepted from the caller so the URL this
// Host forwards is the one it validated.
type cloneRequest struct {
	URL        string `json:"url"`
	TargetPath string `json:"targetPath,omitempty"`
}

// cloneOutcome is the Worker's answer: the job it started, the redacted URL it
// produced from the original, and how far it has got.
type cloneOutcome struct {
	JobID      string `json:"jobId"`
	DisplayURL string `json:"displayUrl"`
	TargetPath string `json:"targetPath"`
	Progress   uint32 `json:"progress"`
	State      string `json:"state"`
	Message    string `json:"messageCode"`
}

func (s *Service) cloneKey(workspaceID, jobID string) storage.Key {
	return storage.Key{Kind: CloneKind, ID: jobID, WorkspaceID: workspaceID}
}

func (s *Service) cloneJob(ctx context.Context, workspaceID, jobID string) (*pb.GitCloneJob, error) {
	if !validID(jobID) {
		return nil, ErrInvalid
	}
	entity, err := s.store.Read(ctx, s.cloneKey(workspaceID, jobID))
	if errors.Is(err, storage.ErrNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if entity.Deleted {
		return nil, ErrNotFound
	}
	return decodeClone(entity)
}

func (s *Service) putClone(ctx context.Context, operationID, workspaceID string, job *pb.GitCloneJob, expected uint64) (*pb.GitCloneJob, storage.ApplyResult, error) {
	encoded, err := clonePayload(job)
	if err != nil {
		return nil, storage.ApplyResult{}, err
	}
	result, err := s.store.Apply(ctx, operationID, []storage.Change{{
		Key:              s.cloneKey(workspaceID, job.GetJobId()),
		ExpectedRevision: expected,
		Payload:          encoded,
	}})
	if err != nil {
		return nil, storage.ApplyResult{}, err
	}
	stored, err := s.cloneJob(ctx, workspaceID, job.GetJobId())
	if err != nil {
		return nil, storage.ApplyResult{}, err
	}
	return stored, result, nil
}

// validCloneURL is the shape check this Host makes before forwarding. It is
// deliberately not an allowlist of hosts: which remotes a person may clone is
// the execution host's own configuration, and duplicating it here would put two
// policies in disagreement. What is refused is a URL that is not one.
func validCloneURL(value string) bool {
	if value == "" || len(value) > MaxURLBytes || strings.ContainsAny(value, "\x00\n\r") {
		return false
	}
	for _, prefix := range []string{"https://", "http://", "ssh://", "git://", "file://", "git@"} {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	// A bare local path is a legitimate clone source and is how a bare mirror
	// on the same machine is addressed.
	return validPath(value)
}

func cloneState(value string) pb.GitCloneState {
	switch value {
	case "running":
		return pb.GitCloneState_GIT_CLONE_STATE_RUNNING
	case "succeeded":
		return pb.GitCloneState_GIT_CLONE_STATE_SUCCEEDED
	case "cancelled":
		return pb.GitCloneState_GIT_CLONE_STATE_CANCELLED
	case "failed":
		return pb.GitCloneState_GIT_CLONE_STATE_FAILED
	default:
		return pb.GitCloneState_GIT_CLONE_STATE_UNSPECIFIED
	}
}

// forwardClone sends one clone request to the execution host and decodes its
// answer. The `GitRead` frame carries it because a clone is a forwarded
// operation with no queue behind it, exactly like a repository query.
func (s *Service) forwardClone(ctx context.Context, method pb.GitReadMethod, workspaceID, root string, body any) (cloneOutcome, error) {
	var outcome cloneOutcome
	encoded, err := json.Marshal(body)
	if err != nil {
		return outcome, err
	}
	result, err := s.executor.ReadGit(ctx, &pb.GitRead{
		Scope:         &pb.RepositoryScope{WorkspaceId: workspaceID},
		RequestJson:   encoded,
		WorkspaceRoot: root,
		Method:        method,
	})
	if err != nil {
		return outcome, err
	}
	if result == nil || result.GetHttpStatus() < 200 || result.GetHttpStatus() >= 300 {
		return outcome, ErrInvalid
	}
	if err = json.Unmarshal(result.GetResponseJson(), &outcome); err != nil {
		return outcome, ErrInvalid
	}
	if outcome.JobID == "" || !validID(outcome.JobID) {
		return outcome, ErrInvalid
	}
	return outcome, nil
}

// replayClone answers a repeated clone with the job the first one started.
func (s *Service) replayClone(ctx context.Context, workspaceID, operationID string) (*pb.StartGitCloneResponse, bool, error) {
	if !textOperationID(operationID) {
		return nil, false, ErrInvalid
	}
	result, found, err := s.store.Receipt(ctx, operationID)
	if err != nil || !found {
		return nil, false, err
	}
	for _, revision := range result.Revisions {
		if revision.Kind != CloneKind || revision.WorkspaceID != workspaceID {
			continue
		}
		job, err := s.cloneJob(ctx, workspaceID, revision.ID)
		if err != nil {
			return nil, false, err
		}
		result.Replayed = true
		return &pb.StartGitCloneResponse{Job: job, Receipt: receipt(result)}, true, nil
	}
	return nil, false, nil
}

// Clone starts one clone on the execution host and records it.
func (s *Service) Clone(ctx context.Context, caller Caller, request *pb.StartGitCloneRequest) (*pb.StartGitCloneResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	url := request.GetUrl()
	if !validCloneURL(url) {
		return nil, ErrInvalid
	}
	if target := request.GetTargetPath(); target != "" && len(target) > MaxPathBytes {
		return nil, ErrInvalid
	}
	root, err := s.workspaceRoot(ctx, caller.WorkspaceID)
	if err != nil {
		return nil, err
	}
	// A retry is answered before anything is started. The job identifier comes
	// from the execution host, so forwarding a repeated request would start a
	// second clone into the same directory and only then discover that the
	// idempotency key had already been used.
	if replay, found, err := s.replayClone(ctx, caller.WorkspaceID, request.GetOperationId()); err != nil {
		return nil, err
	} else if found {
		return replay, nil
	}
	outcome, err := s.forwardClone(ctx, pb.GitReadMethod_GIT_READ_METHOD_CLONE_START, caller.WorkspaceID, root, cloneRequest{URL: url, TargetPath: request.GetTargetPath()})
	if err != nil {
		return nil, err
	}
	now := s.now()
	job := &pb.GitCloneJob{
		JobId:       outcome.JobID,
		WorkspaceId: caller.WorkspaceID,
		// The URL itself is never stored. Only its digest, which recognises the
		// same clone twice, and the redacted form the Worker produced.
		UrlSha256:       digest([]byte(url)),
		DisplayUrl:      outcome.DisplayURL,
		TargetPath:      outcome.TargetPath,
		Progress:        outcome.Progress,
		State:           pb.GitCloneState_GIT_CLONE_STATE_RUNNING,
		CreatedAtUnixMs: now,
		UpdatedAtUnixMs: now,
	}
	stored, result, err := s.putClone(ctx, request.GetOperationId(), caller.WorkspaceID, job, 0)
	if err != nil {
		return nil, err
	}
	return &pb.StartGitCloneResponse{Job: stored, Receipt: receipt(result)}, nil
}

// GetClone answers with the Host's record, refreshed from the execution host
// while the job is still running.
//
// A finished job is answered from the record alone. The execution host forgets
// a clone when its process ends; the Host does not, which is the point of
// keeping the row at all.
func (s *Service) GetClone(ctx context.Context, caller Caller, request *pb.GetGitCloneRequest) (*pb.GetGitCloneResponse, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	job, err := s.cloneJob(ctx, caller.WorkspaceID, request.GetJobId())
	if err != nil {
		return nil, err
	}
	if job.GetState() != pb.GitCloneState_GIT_CLONE_STATE_RUNNING || s.executor == nil {
		return &pb.GetGitCloneResponse{Job: job}, nil
	}
	root, err := s.workspaceRoot(ctx, caller.WorkspaceID)
	if err != nil {
		return &pb.GetGitCloneResponse{Job: job}, nil
	}
	outcome, err := s.forwardClone(ctx, pb.GitReadMethod_GIT_READ_METHOD_CLONE_STATUS, caller.WorkspaceID, root, map[string]string{"jobId": job.GetJobId()})
	if err != nil {
		// An unreachable execution host does not change what the Host knows.
		// The row keeps saying "running", which is the last thing anybody
		// actually observed.
		return &pb.GetGitCloneResponse{Job: job}, nil
	}
	next := proto.Clone(job).(*pb.GitCloneJob)
	next.Progress = outcome.Progress
	next.State = cloneState(outcome.State)
	next.MessageCode = outcome.Message
	next.UpdatedAtUnixMs = s.now()
	if next.GetState() == pb.GitCloneState_GIT_CLONE_STATE_UNSPECIFIED {
		next.State = job.GetState()
	}
	if next.GetState() == job.GetState() && next.GetProgress() == job.GetProgress() {
		return &pb.GetGitCloneResponse{Job: job}, nil
	}
	stored, _, err := s.putClone(ctx, "githost/"+caller.WorkspaceID+"/clone/"+job.GetJobId()+"/"+outcome.State, caller.WorkspaceID, next, job.GetRevision())
	if err != nil {
		return &pb.GetGitCloneResponse{Job: job}, nil
	}
	return &pb.GetGitCloneResponse{Job: stored}, nil
}

// CancelClone stops a running clone. Unlike a push there is no unknown outcome
// to worry about: a clone writes into a directory this side named, and
// cancelling it cleans up only what this clone created (Git 设计 §3).
func (s *Service) CancelClone(ctx context.Context, caller Caller, request *pb.CancelGitCloneRequest) (*pb.CancelGitCloneResponse, error) {
	if err := s.authorizeWrite(ctx, caller); err != nil {
		return nil, err
	}
	job, err := s.cloneJob(ctx, caller.WorkspaceID, request.GetJobId())
	if err != nil {
		return nil, err
	}
	if job.GetState() != pb.GitCloneState_GIT_CLONE_STATE_RUNNING {
		return nil, ErrTerminal
	}
	root, err := s.workspaceRoot(ctx, caller.WorkspaceID)
	if err != nil {
		return nil, err
	}
	if _, err = s.forwardClone(ctx, pb.GitReadMethod_GIT_READ_METHOD_CLONE_CANCEL, caller.WorkspaceID, root, map[string]string{"jobId": job.GetJobId()}); err != nil {
		return nil, err
	}
	next := proto.Clone(job).(*pb.GitCloneJob)
	next.State = pb.GitCloneState_GIT_CLONE_STATE_CANCELLED
	next.MessageCode = "git.clone.cancelled"
	next.UpdatedAtUnixMs = s.now()
	stored, result, err := s.putClone(ctx, request.GetOperationId(), caller.WorkspaceID, next, job.GetRevision())
	if err != nil {
		return nil, err
	}
	return &pb.CancelGitCloneResponse{Job: stored, Receipt: receipt(result)}, nil
}

// activeClones counts the clones this Host still believes are running. A switch
// reads it: moving the domain while a clone is in flight would leave the only
// record of a half-written directory in a process that is about to stop being
// the writer.
func (s *Service) activeClones(ctx context.Context, workspaceID string) (int, error) {
	count := 0
	after := ""
	for {
		page, err := s.store.List(ctx, storage.ListOptions{WorkspaceID: workspaceID, Kind: CloneKind, AfterID: after, Limit: MaxPage})
		if err != nil {
			return 0, err
		}
		for _, entity := range page.Entities {
			job, err := decodeClone(entity)
			if err != nil {
				return 0, err
			}
			if job.GetState() == pb.GitCloneState_GIT_CLONE_STATE_RUNNING {
				count++
			}
		}
		if !page.HasMore {
			return count, nil
		}
		after = page.NextID
	}
}
