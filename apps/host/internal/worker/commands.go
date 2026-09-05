package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"path/filepath"
	"regexp"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

var commandIDPattern = regexp.MustCompile(`^[A-Za-z0-9_./-]{1,256}$`)

func (c *Client) command(ctx context.Context, input *pb.CommandRequest) (*pb.CommandResponse, error) {
	if !c.commandMode || c.hello == nil || c.hello.Commands == nil {
		return nil, &Error{Code: CodeUnsupported}
	}
	response, err := c.exchange(ctx, &pb.WorkerRequest{Action: &pb.WorkerRequest_Command{Command: input}}, "command")
	if err != nil {
		return nil, err
	}
	return proto.Clone(response.GetCommand()).(*pb.CommandResponse), nil
}
func (c *Client) BindCommandRoot(ctx context.Context, input *pb.BindCommandRootRequest) (*pb.CommandRoot, error) {
	if input == nil || !commandIDPattern.MatchString(input.RootId) || !commandIDPattern.MatchString(input.WorkspaceId) || !absolutePath(input.Path) {
		return nil, &Error{Code: CodeInvalid}
	}
	response, err := c.command(ctx, &pb.CommandRequest{Action: &pb.CommandRequest_BindRoot{BindRoot: proto.Clone(input).(*pb.BindCommandRootRequest)}})
	if err != nil {
		return nil, err
	}
	return response.GetRoot(), nil
}
func (c *Client) CreateCommandSession(ctx context.Context, input *pb.CreateCommandSessionRequest) (*pb.CommandSession, error) {
	if input != nil && input.Launch != nil && input.Launch.AccountId != "" && input.Launch.AccountId != "default" {
		return nil, &Error{Code: CodeUnsupported}
	}
	if input == nil || !commandIDPattern.MatchString(input.SessionId) || !commandIDPattern.MatchString(input.RootId) || !commandIDPattern.MatchString(input.WorkspaceId) || input.Kind != pb.CommandSessionKind_COMMAND_SESSION_KIND_NON_INTERACTIVE_COMMAND || input.Launch == nil || input.Launch.AccountId != "default" || !absolutePath(input.Launch.Executable) || !relativePath(input.Launch.WorkingDirectory, true) || input.Launch.TimeoutMs == 0 || input.Launch.TimeoutMs > 86400000 {
		return nil, &Error{Code: CodeInvalid}
	}
	response, err := c.command(ctx, &pb.CommandRequest{Action: &pb.CommandRequest_CreateSession{CreateSession: proto.Clone(input).(*pb.CreateCommandSessionRequest)}})
	if err != nil {
		return nil, err
	}
	return response.GetSession(), nil
}
func (c *Client) GetCommandSession(ctx context.Context, id string) (*pb.CommandSession, error) {
	if !commandIDPattern.MatchString(id) {
		return nil, &Error{Code: CodeInvalid}
	}
	response, err := c.command(ctx, &pb.CommandRequest{Action: &pb.CommandRequest_GetSession{GetSession: &pb.GetCommandSessionRequest{SessionId: id}}})
	if err != nil {
		return nil, err
	}
	return response.GetSession(), nil
}
func (c *Client) RunCommand(ctx context.Context, input *pb.RunCommandRequest) (*pb.CommandReceipt, error) {
	if input == nil || !commandIDPattern.MatchString(input.OperationId) || !commandIDPattern.MatchString(input.SessionId) || input.ExpectedGeneration == 0 || len(input.RequestSha256) != 32 || len(input.Stdin) > 256<<10 {
		return nil, &Error{Code: CodeInvalid}
	}
	response, err := c.command(ctx, &pb.CommandRequest{Action: &pb.CommandRequest_Run{Run: proto.Clone(input).(*pb.RunCommandRequest)}})
	if err != nil {
		return nil, err
	}
	return response.GetReceipt(), nil
}
func (c *Client) LookupCommand(ctx context.Context, id string) (*pb.CommandReceipt, error) {
	if !commandIDPattern.MatchString(id) {
		return nil, &Error{Code: CodeInvalid}
	}
	response, err := c.command(ctx, &pb.CommandRequest{Action: &pb.CommandRequest_Lookup{Lookup: &pb.LookupCommandRequest{OperationId: id}}})
	if err != nil {
		return nil, err
	}
	return response.GetReceipt(), nil
}
func (c *Client) CancelCommand(ctx context.Context, input *pb.CancelCommandRequest) (*pb.CommandReceipt, error) {
	if input == nil || !commandIDPattern.MatchString(input.OperationId) || !commandIDPattern.MatchString(input.SessionId) || input.ExpectedGeneration == 0 {
		return nil, &Error{Code: CodeInvalid}
	}
	response, err := c.command(ctx, &pb.CommandRequest{Action: &pb.CommandRequest_Cancel{Cancel: proto.Clone(input).(*pb.CancelCommandRequest)}})
	if err != nil {
		return nil, err
	}
	return response.GetReceipt(), nil
}
func (c *Client) validCommand(input *pb.CommandRequest, response *pb.CommandResponse) bool {
	if response == nil {
		return false
	}
	if request := input.GetBindRoot(); request != nil {
		root := response.GetRoot()
		return root != nil && root.RootId == request.RootId && root.WorkspaceId == request.WorkspaceId && absolutePath(root.CanonicalPath)
	}
	if input.GetGetSession() != nil || input.GetCreateSession() != nil {
		s := response.GetSession()
		if s == nil || s.Generation == 0 || s.CreatedAtUnixMs <= 0 || s.Kind != pb.CommandSessionKind_COMMAND_SESSION_KIND_NON_INTERACTIVE_COMMAND || !commandIDPattern.MatchString(s.RootId) || !commandIDPattern.MatchString(s.WorkspaceId) || !absolutePath(s.CanonicalRoot) || !absolutePath(s.CanonicalWorkingDirectory) || !commandWithinRoot(s.CanonicalRoot, s.CanonicalWorkingDirectory) || s.FrozenLaunch == nil || s.FrozenLaunch.AccountId != "default" || !absolutePath(s.FrozenLaunch.Executable) || s.FrozenLaunch.TimeoutMs == 0 || s.FrozenLaunch.TimeoutMs > 86400000 || len(s.LaunchSha256) != 32 {
			return false
		}
		digest := sha256.Sum256(mustMarshal(s.FrozenLaunch))
		if !bytes.Equal(digest[:], s.LaunchSha256) {
			return false
		}
		if r := input.GetCreateSession(); r != nil {
			return s.SessionId == r.SessionId && s.RootId == r.RootId && s.WorkspaceId == r.WorkspaceId && s.Kind == r.Kind && s.FrozenLaunch.AccountId == r.Launch.AccountId && s.FrozenLaunch.TimeoutMs == r.Launch.TimeoutMs && s.FrozenLaunch.WorkingDirectory == r.Launch.WorkingDirectory && equalStrings(s.FrozenLaunch.Args, r.Launch.Args)
		}
		return s.SessionId == input.GetGetSession().SessionId
	}
	if input.GetShutdown() != nil {
		s := response.GetShutdown()
		return s != nil && s.CleanupConfirmed == (s.UnresolvedOperations == 0)
	}
	r := response.GetReceipt()
	if !validReceipt(r) {
		return false
	}
	if q := input.GetRun(); q != nil {
		return r.OperationId == q.OperationId && r.SessionId == q.SessionId && r.Generation == q.ExpectedGeneration && (q.ExpectedNotDispatchedSequence == 0 || r.Sequence > q.ExpectedNotDispatchedSequence) && bytes.Equal(r.RequestSha256, q.RequestSha256)
	}
	if q := input.GetLookup(); q != nil {
		return r.OperationId == q.OperationId
	}
	if q := input.GetCancel(); q != nil {
		return r.OperationId == q.OperationId && r.SessionId == q.SessionId && r.Generation == q.ExpectedGeneration
	}
	return false
}
func validReceipt(r *pb.CommandReceipt) bool {
	if r == nil || !commandIDPattern.MatchString(r.OperationId) || !commandIDPattern.MatchString(r.SessionId) || !commandIDPattern.MatchString(r.WorkspaceId) || r.Generation == 0 || r.Sequence == 0 || r.UpdatedAtUnixMs <= 0 || len(r.RequestSha256) != 32 || len(r.ExecutionSha256) != 32 || r.Phase < 1 || r.Phase > 9 || len(r.ReasonCode) > 128 || len(r.Stdout) > 256<<10 || len(r.Stderr) > 256<<10 || r.StdoutTotalBytes < uint64(len(r.Stdout)) || r.StderrTotalBytes < uint64(len(r.Stderr)) || r.StdoutTruncated != (r.StdoutTotalBytes > uint64(len(r.Stdout))) || r.StderrTruncated != (r.StderrTotalBytes > uint64(len(r.Stderr))) {
		return false
	}
	switch r.Phase {
	case pb.CommandPhase_COMMAND_PHASE_SUCCEEDED:
		return r.CleanupConfirmed && r.ExitCode != nil && *r.ExitCode == 0 && !r.NoEffectProven
	case pb.CommandPhase_COMMAND_PHASE_FAILED, pb.CommandPhase_COMMAND_PHASE_CANCELLED:
		return r.CleanupConfirmed
	case pb.CommandPhase_COMMAND_PHASE_NOT_DISPATCHED:
		return r.CleanupConfirmed && r.NoEffectProven
	case pb.CommandPhase_COMMAND_PHASE_UNKNOWN:
		return !r.CleanupConfirmed
	default:
		return !r.CleanupConfirmed && !r.NoEffectProven
	}
}
func mustMarshal(m proto.Message) []byte {
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(m)
	return b
}
func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func commandWithinRoot(root, cwd string) bool {
	relative, err := filepath.Rel(root, cwd)
	return err == nil && !filepath.IsAbs(relative) && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
