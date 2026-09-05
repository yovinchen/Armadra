package automation

import (
	"context"
	"crypto/sha256"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

func agentTarget() *pb.AutomationTarget {
	return &pb.AutomationTarget{
		ExecutionHostId: "execution-host",
		SessionId:       "session",
		Generation:      7,
		Kind:            pb.AutomationTargetKind_AUTOMATION_TARGET_KIND_AGENT_SESSION_PROMPT,
		NodeId:          "node-1",
		ColdStartPolicy: pb.AutomationColdStartPolicy_AUTOMATION_COLD_START_POLICY_LAUNCH_FROZEN,
		AgentLaunch:     &pb.AgentLaunchSpec{AgentId: "claude", WorkingDirectory: "."},
	}
}

func (f *fixture) agentConfig() *pb.AutomationPlanConfig {
	config := f.once()
	config.Target = agentTarget()
	return config
}

// A stored configuration is normalized again to hash it, so normalization has
// to be a fixed point. A drifting one would make an activation impossible to
// confirm — the digest the user approved would never match the stored plan.
func TestTargetNormalizationIsAFixedPoint(t *testing.T) {
	for name, target := range map[string]*pb.AutomationTarget{
		"command": {ExecutionHostId: "host", SessionId: "session", Generation: 1},
		"agent":   agentTarget(),
	} {
		once := proto.Clone(target).(*pb.AutomationTarget)
		if err := normalizeTarget(once); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		twice := proto.Clone(once).(*pb.AutomationTarget)
		if err := normalizeTarget(twice); err != nil {
			t.Fatalf("%s re-normalize: %v", name, err)
		}
		if !proto.Equal(once, twice) {
			t.Fatalf("%s normalization drifted", name)
		}
	}
}

// The two executors are kept apart at the door. A command target that grew a
// node, or an agent target with no frozen definition, is refused rather than
// stored as a plan whose executor nobody could name.
func TestMixedTargetsAreRefused(t *testing.T) {
	cases := map[string]*pb.AutomationTarget{
		"command with a node":        {ExecutionHostId: "host", SessionId: "session", Generation: 1, NodeId: "node-1"},
		"command with a launch spec": {ExecutionHostId: "host", SessionId: "session", Generation: 1, AgentLaunch: &pb.AgentLaunchSpec{AgentId: "claude"}},
		"command asking to launch": {
			ExecutionHostId: "host", SessionId: "session", Generation: 1,
			ColdStartPolicy: pb.AutomationColdStartPolicy_AUTOMATION_COLD_START_POLICY_LAUNCH_FROZEN,
		},
		"agent with no node": {
			ExecutionHostId: "host", SessionId: "session", Generation: 1,
			Kind: pb.AutomationTargetKind_AUTOMATION_TARGET_KIND_AGENT_SESSION_PROMPT, AgentLaunch: &pb.AgentLaunchSpec{AgentId: "claude"},
		},
		"agent with no definition": {
			ExecutionHostId: "host", SessionId: "session", Generation: 1,
			Kind: pb.AutomationTargetKind_AUTOMATION_TARGET_KIND_AGENT_SESSION_PROMPT, NodeId: "node-1",
		},
		"agent on another account": {
			ExecutionHostId: "host", SessionId: "session", Generation: 1,
			Kind: pb.AutomationTargetKind_AUTOMATION_TARGET_KIND_AGENT_SESSION_PROMPT, NodeId: "node-1",
			AgentLaunch: &pb.AgentLaunchSpec{AgentId: "claude", AccountId: "work"},
		},
	}
	for name, target := range cases {
		if err := normalizeTarget(target); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}

// Two plans aimed at the same Agent node share one delivery door, even though
// their frozen sessions differ — a restart or a cold start replaces the session
// underneath, and a gate that followed it would stop serializing anything.
func TestAgentGateIsKeyedByNodeNotSession(t *testing.T) {
	first, second := agentTarget(), agentTarget()
	second.SessionId = "another-session"
	second.Generation = 99
	if targetKey(first) != targetKey(second) {
		t.Fatal("two plans on the same node got separate delivery doors")
	}
	other := agentTarget()
	other.NodeId = "node-2"
	if targetKey(first) == targetKey(other) {
		t.Fatal("two different nodes shared one delivery door")
	}
	// A command target keeps keying by session; a node id it does not have
	// must not silently collapse every command gate onto one key.
	command := &pb.AutomationTarget{ExecutionHostId: "execution-host", SessionId: "session", Generation: 7}
	if targetKey(command) == targetKey(first) {
		t.Fatal("a command gate collided with an agent gate")
	}
}

// The generation an agent plan froze is a record of what it was defined
// against, not a lock on a process: the Runtime owns that session's lifetime.
// A command target keeps the strict check, because a different generation
// there is a different process.
func TestOnlyCommandTargetsPinTheGeneration(t *testing.T) {
	if generationPinned(agentTarget()) {
		t.Fatal("an agent target pinned a generation the Runtime owns")
	}
	if !generationPinned(&pb.AutomationTarget{ExecutionHostId: "host", SessionId: "session", Generation: 1}) {
		t.Fatal("a command target stopped pinning its generation")
	}
}

// The end-to-end consequence of the rule above: a ready agent target whose
// live generation differs from the frozen one still dispatches, and the run
// records what it was actually written to.
func TestAgentPlanDispatchesAcrossAGenerationChange(t *testing.T) {
	f := setup(t)
	f.dispatcher.status = TargetStatus{State: TargetReady, Generation: 41}
	config := f.agentConfig()
	config.Schedule.GetOnce().AtUnixMs = f.clock.Load()
	f.activate(t, "agent", config)
	f.tick(t)
	runs := f.dispatcher.runs()
	if len(runs) != 1 {
		t.Fatalf("a live agent target did not dispatch: %d runs", len(runs))
	}
	if runs[0].FrozenConfig.Target.Generation != 7 {
		t.Fatal("the frozen generation stopped being recorded")
	}
}

// A command plan is unaffected: a live generation other than the frozen one is
// a different process, and writing into it is exactly what must not happen.
func TestCommandPlanStillRefusesAStaleGeneration(t *testing.T) {
	f := setup(t)
	f.dispatcher.status = TargetStatus{State: TargetReady, Generation: 41}
	config := f.once()
	config.Schedule.GetOnce().AtUnixMs = f.clock.Load()
	f.activate(t, "command", config)
	f.tick(t)
	if len(f.dispatcher.runs()) != 0 {
		t.Fatal("a command plan dispatched into a different generation")
	}
	run := f.allRuns(t, "command")
	if len(run) != 1 || run[0].Run.ReasonCode != "STALE_GENERATION" {
		t.Fatalf("stale generation was not recorded: %+v", run)
	}
}

func TestAgentPlanKeepsItsFrozenDefinitionThroughDefine(t *testing.T) {
	f := setup(t)
	sum := sha256.Sum256([]byte("frozen payload"))
	config := f.agentConfig()
	config.PayloadSha256 = sum[:]
	snapshot, err := f.engine.Define(context.Background(), testAuth, "agent", config, 0)
	if err != nil {
		t.Fatal(err)
	}
	stored := snapshot.Plan.Config.Target
	if stored.NodeId != "node-1" || stored.AgentLaunch.GetAgentId() != "claude" {
		t.Fatalf("the frozen definition was lost: %+v", stored)
	}
	if stored.AgentLaunch.AccountId != "default" {
		t.Fatal("the account was not normalized to the only supported one")
	}
}
