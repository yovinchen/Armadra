package worker

import (
	"context"
	"slices"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The session domain over the private Worker channel
// (Go Host 业务所有权迁移 §2.6, §2.9, action 27).
//
// Two kinds of question travel here, and the difference matters.
//
// One is a *read*: what does this Runtime's own `terminal_sessions` table say?
// It is asked while verifying a switch and again while handing the domain back,
// and it is only worth asking because the answer comes from the rows rather
// than from the request that stored them.
//
// The other is *execution*: start a run, signal one, account for them, capture
// a screen. Those reach the resident Runtime — the process that actually holds
// the PTYs — rather than being answered by whichever Worker took the frame, and
// a Worker with no live Runtime beside it says UNSUPPORTED instead of pretending
// it started something.
//
// Nothing here decides anything. A generation, an exit code and a backend
// reference all come back exactly as the execution host reported them; this
// client only refuses answers that could not be true, so that a comparison
// upstream is comparing something real.

// SessionCapability is what a Worker must advertise before this client will ask
// it about sessions. A Worker that never opened the Runtime's database cannot
// answer the read, and saying so is what stops a rollback from being "verified"
// against an empty list.
const SessionCapability = "session.worker.v1"

// SupportsSessions reports whether this Worker said it can answer about
// sessions.
func (c *Client) SupportsSessions() bool {
	return c != nil && c.hello != nil && slices.Contains(c.hello.Capabilities, SessionCapability)
}

func (c *Client) sessionExchange(ctx context.Context, action *pb.SessionWorkerRequest) (*pb.SessionWorkerResponse, error) {
	if !c.SupportsSessions() {
		return nil, &Error{Code: CodeUnsupported}
	}
	response, err := c.exchange(ctx, &pb.WorkerRequest{Action: &pb.WorkerRequest_Session{Session: action}}, "session")
	if err != nil {
		return nil, err
	}
	result := response.GetSession()
	if result == nil {
		return nil, &Error{Code: CodeProtocol}
	}
	return result, nil
}

// WorkerSessions reads the Worker's own `terminal_sessions` rows.
//
// An empty list from a Worker that has rows is a protocol failure rather than
// "no sessions": the caller compares it against a package it wrote, and a
// silently empty answer would make every comparison trivially pass.
func (c *Client) WorkerSessions(ctx context.Context) (*pb.WorkerSessionStates, error) {
	if c == nil || !c.ownershipMode {
		return nil, &Error{Code: CodeUnsupported}
	}
	result, err := c.sessionExchange(ctx, &pb.SessionWorkerRequest{
		Action: &pb.SessionWorkerRequest_ListSessions{ListSessions: &pb.ListWorkerSessionsRequest{}},
	})
	if err != nil {
		return nil, err
	}
	states := result.GetSessions()
	if states == nil {
		return nil, &Error{Code: CodeProtocol}
	}
	return cloneStates(states)
}

// StartRun asks the execution host for a run and returns what it created.
//
// A reply with no generation is refused: the generation is the whole point of
// the exchange — it is what tells the pane the user is typing into from the one
// that replaced it — and recording a zero would make every later signal
// ambiguous.
func (c *Client) StartRun(ctx context.Context, request *pb.StartSessionRunRequest) (*pb.WorkerSessionState, error) {
	if request.GetSessionId() == "" {
		return nil, &Error{Code: CodeInvalid}
	}
	result, err := c.sessionExchange(ctx, &pb.SessionWorkerRequest{
		Action: &pb.SessionWorkerRequest_StartRun{StartRun: request},
	})
	if err != nil {
		return nil, err
	}
	return runState(result.GetRun(), request.GetSessionId(), true)
}

// SignalRun stops, interrupts or recycles a run. `mode` is the execution host's
// own vocabulary and is passed through unchanged: mapping it here would make
// this Host decide how hard to kill somebody's program.
func (c *Client) SignalRun(ctx context.Context, request *pb.SignalSessionRunRequest) (*pb.WorkerSessionState, error) {
	if request.GetSessionId() == "" || request.GetMode() == "" {
		return nil, &Error{Code: CodeInvalid}
	}
	result, err := c.sessionExchange(ctx, &pb.SessionWorkerRequest{
		Action: &pb.SessionWorkerRequest_SignalRun{SignalRun: request},
	})
	if err != nil {
		return nil, err
	}
	// An interrupt or a termination legitimately answers with no generation
	// left, so only a recycle — which exists to produce one — has to have one.
	return runState(result.GetRun(), request.GetSessionId(), request.GetMode() == "recycle")
}

// ReclaimRuns asks what the execution host actually holds.
//
// The answer is the truth about processes and this Host's records are a
// projection of it, so a malformed entry is refused rather than skipped: a
// session dropped from the listing would be recorded as ended, and ending a
// session nobody watched end is exactly what the reclaim exists to avoid.
func (c *Client) ReclaimRuns(ctx context.Context, sessionIDs []string) (*pb.WorkerSessionStates, error) {
	result, err := c.sessionExchange(ctx, &pb.SessionWorkerRequest{
		Action: &pb.SessionWorkerRequest_ReclaimRuns{ReclaimRuns: &pb.ReclaimSessionRunsRequest{SessionIds: sessionIDs}},
	})
	if err != nil {
		return nil, err
	}
	states := result.GetSessions()
	if states == nil {
		return nil, &Error{Code: CodeProtocol}
	}
	return cloneStates(states)
}

// CaptureRun reads one screenful of a run.
func (c *Client) CaptureRun(ctx context.Context, request *pb.CaptureSessionRunRequest) (*pb.CapturedSessionRun, error) {
	if request.GetSessionId() == "" {
		return nil, &Error{Code: CodeInvalid}
	}
	result, err := c.sessionExchange(ctx, &pb.SessionWorkerRequest{
		Action: &pb.SessionWorkerRequest_CaptureRun{CaptureRun: request},
	})
	if err != nil {
		return nil, err
	}
	capture := result.GetCapture()
	if capture == nil || capture.GetSessionId() != request.GetSessionId() {
		return nil, &Error{Code: CodeProtocol}
	}
	return proto.Clone(capture).(*pb.CapturedSessionRun), nil
}

// SuggestTitle and ContextUsage are reads of things only the execution host
// has: a transcript, a live pane, a usage cache. This Host forwards and records
// nothing.

func (c *Client) SuggestTitle(ctx context.Context, request *pb.SuggestSessionTitleRequest) (*pb.SuggestSessionTitleResponse, error) {
	if request.GetSessionId() == "" {
		return nil, &Error{Code: CodeInvalid}
	}
	result, err := c.sessionExchange(ctx, &pb.SessionWorkerRequest{
		Action: &pb.SessionWorkerRequest_SuggestTitle{SuggestTitle: request},
	})
	if err != nil {
		return nil, err
	}
	title := result.GetTitle()
	if title == nil {
		return nil, &Error{Code: CodeProtocol}
	}
	return proto.Clone(title).(*pb.SuggestSessionTitleResponse), nil
}

func (c *Client) ContextUsage(ctx context.Context, request *pb.GetSessionContextUsageRequest) (*pb.GetSessionContextUsageResponse, error) {
	if request.GetSessionId() == "" {
		return nil, &Error{Code: CodeInvalid}
	}
	result, err := c.sessionExchange(ctx, &pb.SessionWorkerRequest{
		Action: &pb.SessionWorkerRequest_ContextUsage{ContextUsage: request},
	})
	if err != nil {
		return nil, err
	}
	usage := result.GetContextUsage()
	if usage == nil {
		return nil, &Error{Code: CodeProtocol}
	}
	// The snapshot is opaque, so its digest is the only thing that says the
	// bytes arrived whole. One that describes other bytes would pass every
	// later comparison that trusted it.
	if len(usage.GetUsage()) > 0 && len(usage.GetUsageSha256()) != 32 {
		return nil, &Error{Code: CodeProtocol}
	}
	return proto.Clone(usage).(*pb.GetSessionContextUsageResponse), nil
}

// runState screens one reported run. `needGeneration` is false for the signals
// that legitimately leave nothing running.
func runState(state *pb.WorkerSessionState, sessionID string, needGeneration bool) (*pb.WorkerSessionState, error) {
	if state == nil || state.GetSessionId() != sessionID {
		return nil, &Error{Code: CodeProtocol}
	}
	if needGeneration && state.GetGeneration() == 0 {
		return nil, &Error{Code: CodeProtocol}
	}
	return proto.Clone(state).(*pb.WorkerSessionState), nil
}

func cloneStates(states *pb.WorkerSessionStates) (*pb.WorkerSessionStates, error) {
	seen := map[string]bool{}
	for _, state := range states.GetSessions() {
		// A session with no identifier cannot be compared with anything, and a
		// duplicate would let one entry silently overwrite another in the map
		// the caller builds from this list.
		if state.GetSessionId() == "" || seen[state.GetSessionId()] {
			return nil, &Error{Code: CodeProtocol}
		}
		seen[state.GetSessionId()] = true
	}
	return proto.Clone(states).(*pb.WorkerSessionStates), nil
}
