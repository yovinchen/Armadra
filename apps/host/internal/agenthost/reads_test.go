package agenthost

import (
	"errors"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
)

// The transcript and the pane are forwarded, never stored, and the client only
// gets to name the node: the session and the transcript reference come from
// this Host's own record, so a caller cannot aim the execution host at a file
// of its choosing.
func TestATranscriptIsForwardedWithTheHostsOwnReference(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_DONE)

	excerpt, err := f.service.ReadTranscript(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.ReadTranscriptRequest{
		NodeId: nodeOne,
		// A path a client made up. It must not travel.
		SessionId: "session-somebody-elses",
	})
	if err != nil {
		t.Fatalf("the transcript was not read: %v", err)
	}
	if string(excerpt.GetContent()) != "[用户] 修一下构建\n[助手] 好的" {
		t.Fatalf("the excerpt did not come back intact: %q", excerpt.GetContent())
	}
	if len(f.machine.transcripts) != 1 {
		t.Fatalf("the machine was asked %d times", len(f.machine.transcripts))
	}
	asked := f.machine.transcripts[0]
	if asked.GetSessionId() != "session-"+nodeOne {
		t.Fatalf("the client's session id reached the machine: %q", asked.GetSessionId())
	}
	if asked.GetMaxBytes() != MaxTranscriptBytes {
		t.Fatalf("an unbounded read was forwarded: %d", asked.GetMaxBytes())
	}
	// Nothing about this read is recorded: the domain stores what agents are,
	// not what they said, so the node's own row is untouched by having been
	// read from.
	before := f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_DONE)
	if _, err := f.service.ReadTranscript(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.ReadTranscriptRequest{NodeId: nodeOne}); err != nil {
		t.Fatal(err)
	}
	after, err := f.store.GetAgentStatus(fixtureContext, nodeOne)
	if err != nil || after.Revision != before.Revision {
		t.Fatalf("reading a transcript moved the record: %d -> %d %v", before.Revision, after.Revision, err)
	}
}

// A provider that keeps nothing readable is a refusal with a reason, which is
// the whole point: an empty excerpt would be indistinguishable from a session
// that has said nothing yet.
func TestAProviderWithoutATranscriptRefusesRatherThanAnsweringEmpty(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_DONE)
	f.machine.noTranscript = true

	_, err := f.service.ReadTranscript(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.ReadTranscriptRequest{NodeId: nodeOne})
	if err == nil {
		t.Fatal("a provider with no transcript answered")
	}
	if got := err.Error(); got == "" {
		t.Fatal("the refusal carried no reason")
	}
}

// A device granted one workspace cannot read a pane in another, and a node id
// that names nothing is not found rather than answered blank.
func TestAReadIsScopedToTheCallersOwnWorkspace(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedStatus(nodeTwo, otherID, pb.AgentState_AGENT_STATE_WORKING)

	if _, err := f.service.ReadTranscript(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.ReadTranscriptRequest{NodeId: nodeTwo}); !errors.Is(err, ErrAuthorization) {
		t.Fatalf("another workspace's transcript was readable: %v", err)
	}
	if _, err := f.service.CaptureScreen(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.CaptureAgentScreenRequest{NodeId: nodeTwo}); !errors.Is(err, ErrAuthorization) {
		t.Fatalf("another workspace's pane was readable: %v", err)
	}
	if len(f.machine.transcripts) != 0 || len(f.machine.screens) != 0 {
		t.Fatal("a refused read still reached the machine")
	}
}

// The pane comes back with the node's own session filled in, and a node with no
// session is not found rather than an empty screen.
func TestAScreenNeedsASessionToBeShowing(t *testing.T) {
	f := newFixture(t)
	f.own()
	status := f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_WORKING)

	screen, err := f.service.CaptureScreen(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.CaptureAgentScreenRequest{NodeId: nodeOne})
	if err != nil {
		t.Fatalf("the pane was not captured: %v", err)
	}
	if screen.GetData() != "$ cargo test\nok" {
		t.Fatalf("the pane did not come back intact: %q", screen.GetData())
	}
	if len(f.machine.screens) != 1 || f.machine.screens[0].GetSessionId() != status.SessionID {
		t.Fatalf("the record's session did not travel: %+v", f.machine.screens)
	}
	if f.machine.screens[0].GetLines() != DefaultScreenLines {
		t.Fatalf("an unbounded capture was forwarded: %d", f.machine.screens[0].GetLines())
	}

	f.seedNode(nodeTwo, "agent")
	if _, err := f.service.CaptureScreen(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.CaptureAgentScreenRequest{NodeId: nodeTwo}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a node with no session reported a screen: %v", err)
	}
}

// Without a reachable execution host there is no answer to give, and saying so
// is a state a client can draw.
func TestAnUnreachableMachineIsNamedRatherThanAnsweredFor(t *testing.T) {
	f := newFixture(t)
	f.own()
	f.seedStatus(nodeOne, workspaceID, pb.AgentState_AGENT_STATE_WORKING)
	f.unreachable = true

	if _, err := f.service.ReadTranscript(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.ReadTranscriptRequest{NodeId: nodeOne}); !errors.Is(err, ErrNoWorker) {
		t.Fatalf("an unreachable machine was not reported: %v", err)
	}
	if _, err := f.service.CaptureScreen(fixtureContext, f.caller(ScopeRead, workspaceID), &pb.CaptureAgentScreenRequest{NodeId: nodeOne}); !errors.Is(err, ErrNoWorker) {
		t.Fatalf("an unreachable machine was not reported: %v", err)
	}
}
