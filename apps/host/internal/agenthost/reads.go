package agenthost

import (
	"context"

	pb "armadra.local/host/gen/armadra/v1"
)

// Reading one node's own material: its conversation and its pane
// (Go Host 业务所有权迁移 §2.7, Host→Worker `ReadTranscript` / `CaptureScreen`).
//
// Neither is stored. This Host records what agents *are*, not what they said —
// §2.7 makes `transcript_ref` an opaque reference precisely so a transcript
// never lands here — so both methods resolve who is asking, prove the node is
// theirs, and forward. What comes back is passed through and forgotten.
//
// Two properties are worth stating.
//
// **A refusal is an answer.** The Worker refuses with a reason when a provider
// keeps nothing readable — OpenCode's history lives in a store only its own CLI
// exports, Pi and Oh My Pi report a live window rather than a file, Copilot's
// `events.jsonl` is an event log and not a conversation. Turning that into an
// empty excerpt would make "this CLI has no transcript" and "this session has
// said nothing yet" the same screen.
//
// **The gate is the node, not the workspace.** `requireNode` is the same check
// `MarkRead` makes: a device granted one workspace cannot read a pane in
// another, and a node id that names nothing is not found rather than answered
// blank.

// MaxTranscriptBytes bounds one excerpt. It is the Worker's own rendered
// ceiling; asking for more would be asking for something it will not send, and
// a client that streamed a whole conversation through a single response would
// be using the wrong surface for it.
const MaxTranscriptBytes = 200 * 1024

// MaxScreenLines bounds a capture. The default is a screenful rather than a
// scrollback: this answers "what is it showing", and the transcript answers
// "what has it said".
const (
	DefaultScreenLines = 200
	MaxScreenLines     = 10_000
)

// ReadTranscript returns the tail of the node's conversation as the execution
// host renders it.
func (s *Service) ReadTranscript(ctx context.Context, caller Caller, request *pb.ReadTranscriptRequest) (*pb.TranscriptExcerpt, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	status, err := s.requireNode(ctx, caller, request.GetNodeId())
	if err != nil {
		return nil, err
	}
	executor, done, err := s.open(ctx, "")
	if err != nil {
		return nil, err
	}
	defer done()
	limit := request.GetMaxBytes()
	if limit == 0 || limit > MaxTranscriptBytes {
		limit = MaxTranscriptBytes
	}
	// The stored reference wins over anything a client sent: it is what this
	// Host's own record was written from, and a client-supplied path would let
	// a caller point the execution host at a file of its choosing.
	sessionID := status.SessionID
	if sessionID == "" {
		sessionID = request.GetSessionId()
	}
	return executor.ReadTranscript(ctx, &pb.ReadTranscriptRequest{
		NodeId:        status.NodeID,
		SessionId:     sessionID,
		TranscriptRef: status.TranscriptRef,
		MaxBytes:      limit,
	})
}

// CaptureScreen returns what the node's pane is showing.
func (s *Service) CaptureScreen(ctx context.Context, caller Caller, request *pb.CaptureAgentScreenRequest) (*pb.CapturedAgentScreen, error) {
	if err := s.authorize(caller, ScopeRead); err != nil {
		return nil, err
	}
	status, err := s.requireNode(ctx, caller, request.GetNodeId())
	if err != nil {
		return nil, err
	}
	sessionID := status.SessionID
	if sessionID == "" {
		sessionID = request.GetSessionId()
	}
	if sessionID == "" {
		// No session, no pane. This is not an empty screen: nothing is running
		// under that node, and a client drawing a blank would say otherwise.
		return nil, ErrNotFound
	}
	executor, done, err := s.open(ctx, "")
	if err != nil {
		return nil, err
	}
	defer done()
	lines := request.GetLines()
	if lines == 0 {
		lines = DefaultScreenLines
	}
	if lines > MaxScreenLines {
		lines = MaxScreenLines
	}
	return executor.CaptureScreen(ctx, &pb.CaptureAgentScreenRequest{
		NodeId:    status.NodeID,
		SessionId: sessionID,
		Lines:     lines,
	})
}
