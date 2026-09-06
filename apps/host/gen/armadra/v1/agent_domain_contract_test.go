package v1_test

import (
	"bytes"
	"math"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The agent domain's record half (Go Host 业务所有权迁移 §2.7).
//
// `agent_contract_test.go` pins the prompt-delivery surface, which writes into
// a PTY. This file pins the shapes the Host owns once the domain has switched,
// and each of the seven is a statement the other two runtimes have to read the
// same way:
//
//   - a status that is BLOCKED with an *absent* `errored`, because "no error
//     was reported" and "an error was reported as false" are different things
//     to draw and only one of them is a red badge, and whose `state_source`
//     says which channel that verdict came through;
//   - a normalized Hook event of a kind no CLI had when the enum was written,
//     carrying a payload this Host never parses and its digest;
//   - an approval still pending, whose body is a provider's own JSON carried as
//     bytes with its digest;
//   - a mailbox message nobody has acknowledged, whose zero acknowledgement
//     stamp is what an inbox counts;
//   - a delivery whose outcome is UNKNOWN, which is the one outcome nothing may
//     retry from automatically;
//   - a handoff in UNKNOWN_OUTCOME with a frozen bundle digest;
//   - the Worker's own reading of its agent rows, which carries no revision
//     anywhere because the Worker stores no CAS token for a domain it does not
//     own.
func TestAgentDomainWire(t *testing.T) {
	interrupted := true
	for name, message := range map[string]proto.Message{
		// A node whose CLI is waiting on a permission answer. `errored` is
		// absent and `interrupted` is present-and-true: the two optional bools
		// exist precisely so "nobody said" is distinguishable from "no".
		"agent_status_blocked": &pb.AgentStatus{
			NodeId:            "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
			WorkspaceId:       "0123456789abcdef0123456789abcdef",
			SessionId:         "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
			Generation:        7,
			AgentId:           "claude",
			Unread:            3,
			Verified:          true,
			Interrupted:       &interrupted,
			TranscriptRef:     []byte("claude/8f2d1c4a"),
			StateSource:       "hook",
			State:             pb.AgentState_AGENT_STATE_BLOCKED,
			SessionPhase:      "turn",
			ReasonCode:        "agent.blocked.approval",
			LastEventAtUnixMs: 1788557800000,
			UpdatedAtUnixMs:   1788557900000,
			Revision:          9007199254740993,
		},
		// A turn opening reported by a provider this Host has never heard of.
		// Both halves are the point: `provider` is routed on and not
		// interpreted, and TURN_START is a kind the enum gained after the first
		// four adapters, so a Host that folded an unknown kind into a default
		// would silently change what a node's state was reduced from.
		"agent_hook_event_turn_start": &pb.HookEvent{
			EventId:          "f0a1b2c3d4e5f60718293a4b5c6d7e8f",
			NodeId:           "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
			SessionId:        "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
			Generation:       7,
			WorkspaceId:      "0123456789abcdef0123456789abcdef",
			Provider:         "pi",
			Payload:          []byte(`{"kind":"state","state":"working","stateSource":"extension"}`),
			PayloadSha256:    bytes.Repeat([]byte{0x7e}, 32),
			SchemaVersion:    1,
			Kind:             pb.HookEventKind_HOOK_EVENT_KIND_TURN_START,
			ObservedAtUnixMs: 1788557700000,
		},
		// The question itself. The body is the provider's own JSON and is never
		// expanded into fields; the digest is what makes carrying it safe.
		"agent_approval_pending": &pb.Approval{
			ApprovalId:      "b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2",
			NodeId:          "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
			WorkspaceId:     "0123456789abcdef0123456789abcdef",
			SessionId:       "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
			Generation:      7,
			Request:         []byte(`{"tool":"Bash","command":"rm -rf 构建/"}`),
			RequestSha256:   bytes.Repeat([]byte{0x5a}, 32),
			State:           pb.ApprovalState_APPROVAL_STATE_PENDING,
			CreatedAtUnixMs: 1788557800000,
			Revision:        1,
		},
		// An unread message. The zero acknowledgement stamp is the statement,
		// which is why it is a timestamp rather than a flag: an inbox can say
		// how long something sat unread only if the moment is recorded.
		"agent_mailbox_unread": &pb.MailboxMessage{
			MessageId:       "c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6",
			WorkspaceId:     "0123456789abcdef0123456789abcdef",
			SourceNodeId:    "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
			TargetNodeId:    "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
			MessageKey:      "handoff/迁移",
			Body:            "接手 agent 域的 e2e，剩下的在 tools/ownership/。",
			Sequence:        42,
			CreatedAtUnixMs: 1788557800000,
			ExpiresAtUnixMs: 1788644200000,
			Revision:        1,
		},
		// A delivery nobody can attribute. It is never retried automatically,
		// and the outcome travels rather than being inferred from the absence
		// of an error.
		"agent_delivery_unknown": &pb.Delivery{
			TraceId:         "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
			WorkspaceId:     "0123456789abcdef0123456789abcdef",
			SourceNodeId:    "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
			TargetNodeId:    "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
			Receipt:         "armadra-9a8b7c6d:0.0",
			BodyChars:       128,
			Outcome:         pb.DeliveryOutcome_DELIVERY_OUTCOME_UNKNOWN,
			ReasonCode:      "agent.delivery.unattributable",
			CreatedAtUnixMs: 1788557900000,
			Revision:        2,
		},
		// A handoff whose write may or may not have landed. The bundle digest
		// is the frozen definition: the target read what the source sent, or
		// the record says so.
		"agent_handoff_unknown_outcome": &pb.Handoff{
			HandoffId:        "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
			WorkspaceId:      "0123456789abcdef0123456789abcdef",
			SourceNodeId:     "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
			TargetNodeId:     "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
			Source:           &pb.SessionAddress{SessionId: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8", Generation: 7},
			Target:           &pb.SessionAddress{SessionId: "1a2b3c4d5e6f708192a3b4c5d6e7f809", Generation: 2},
			Bundle:           []byte(`{"summary":"迁移到 Host","files":["docs/design/host-business-migration.md"]}`),
			BundleSha256:     bytes.Repeat([]byte{0x3c}, 32),
			MailboxId:        "c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6",
			TraceId:          "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
			Attempts:         2,
			State:            pb.HandoffState_HANDOFF_STATE_UNKNOWN_OUTCOME,
			ErrorCode:        "agent.handoff.unattributable",
			CreatedAtUnixMs:  1788557000000,
			AcceptedAtUnixMs: 1788557500000,
			UpdatedAtUnixMs:  1788557900000,
			Revision:         math.MaxUint64,
		},
		// The Worker's own reading, which a switch and a handback are verified
		// against. No revision travels: a value there would be one the Host
		// could mistake for agreement.
		"agent_worker_states": &pb.AgentWorkerResponse{
			Result: &pb.AgentWorkerResponse_Agents{Agents: &pb.WorkerAgentStates{
				WorkerInstanceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
				Agents: []*pb.WorkerAgentState{{
					NodeId:            "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
					WorkspaceId:       "0123456789abcdef0123456789abcdef",
					SessionId:         "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
					Generation:        7,
					AgentId:           "claude",
					Unread:            3,
					Verified:          true,
					TranscriptRef:     []byte("claude/8f2d1c4a"),
					State:             pb.AgentState_AGENT_STATE_BLOCKED,
					SessionPhase:      "turn",
					LastEventAtUnixMs: 1788557800000,
					UpdatedAtUnixMs:   1788557900000,
				}},
				Approvals: []*pb.Approval{{
					ApprovalId:      "b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2",
					NodeId:          "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
					WorkspaceId:     "0123456789abcdef0123456789abcdef",
					Request:         []byte(`{"tool":"Bash","command":"rm -rf 构建/"}`),
					RequestSha256:   bytes.Repeat([]byte{0x5a}, 32),
					State:           pb.ApprovalState_APPROVAL_STATE_PENDING,
					CreatedAtUnixMs: 1788557800000,
				}},
			}},
		},
	} {
		data, err := proto.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		wire := fixture(t, name, data)
		decoded := message.ProtoReflect().New().Interface()
		if err = proto.Unmarshal(wire, decoded); err != nil || !proto.Equal(decoded, message) {
			t.Fatalf("%s changed", name)
		}
	}
}

// A status that reported no error is not a status nobody asked about. The first
// draws as healthy, the second draws as unknown, and folding the two would make
// every node that has never run look like one that ran cleanly.
func TestAgentStatusOptionalBoolsStayDistinct(t *testing.T) {
	no := false
	reported := &pb.AgentStatus{NodeId: "n", Errored: &no}
	silent := &pb.AgentStatus{NodeId: "n"}
	reportedWire, err := proto.Marshal(reported)
	if err != nil {
		t.Fatal(err)
	}
	silentWire, err := proto.Marshal(silent)
	if err != nil {
		t.Fatal(err)
	}
	if len(reportedWire) == len(silentWire) {
		t.Fatal("a reported false must occupy the wire; an absent one must not")
	}
	decoded := new(pb.AgentStatus)
	if err = proto.Unmarshal(silentWire, decoded); err != nil || decoded.Errored != nil {
		t.Fatal("an absent errored flag decoded as a value")
	}
}

// The Hook event kinds are a closed list, and each number is what one runtime
// wrote and another reads back. Appending TURN_START and COMPACTION for the
// extension CLIs must not renumber the six that were already on the wire: a
// shifted value would turn every stored SESSION_END into an APPROVAL.
func TestHookEventKindNumbersAreAppendOnly(t *testing.T) {
	for kind, number := range map[pb.HookEventKind]int32{
		pb.HookEventKind_HOOK_EVENT_KIND_UNSPECIFIED:   0,
		pb.HookEventKind_HOOK_EVENT_KIND_SESSION_START: 1,
		pb.HookEventKind_HOOK_EVENT_KIND_USER_PROMPT:   2,
		pb.HookEventKind_HOOK_EVENT_KIND_TURN_END:      3,
		pb.HookEventKind_HOOK_EVENT_KIND_NOTIFICATION:  4,
		pb.HookEventKind_HOOK_EVENT_KIND_APPROVAL:      5,
		pb.HookEventKind_HOOK_EVENT_KIND_SESSION_END:   6,
		pb.HookEventKind_HOOK_EVENT_KIND_TURN_START:    7,
		pb.HookEventKind_HOOK_EVENT_KIND_COMPACTION:    8,
	} {
		if int32(kind) != number {
			t.Fatalf("%s moved to %d", kind, kind)
		}
	}
}

// The agent domain's frames sit on their own numbers in both directions. 21 is
// the released prompt frame and means something else entirely; a Worker that
// confused the two would answer a record request by writing into a terminal.
func TestAgentDomainFrameNumbers(t *testing.T) {
	request := &pb.WorkerRequest{RequestId: "h-1", Action: &pb.WorkerRequest_AgentHost{
		AgentHost: &pb.AgentWorkerRequest{Action: &pb.AgentWorkerRequest_ListAgents{ListAgents: &pb.ListWorkerAgentsRequest{}}},
	}}
	data, err := proto.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	decoded := new(pb.WorkerRequest)
	if err = proto.Unmarshal(data, decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.GetAgentHost() == nil || decoded.GetAgent() != nil {
		t.Fatal("the agent record frame decoded as the prompt frame")
	}
	response := &pb.WorkerResponse{RequestId: "h-1", Result: &pb.WorkerResponse_AgentHost{
		AgentHost: &pb.AgentWorkerResponse{Result: &pb.AgentWorkerResponse_Agents{Agents: &pb.WorkerAgentStates{}}},
	}}
	if data, err = proto.Marshal(response); err != nil {
		t.Fatal(err)
	}
	answer := new(pb.WorkerResponse)
	if err = proto.Unmarshal(data, answer); err != nil || answer.GetAgentHost() == nil || answer.GetAgent() != nil {
		t.Fatal("the agent record answer decoded as the prompt answer")
	}
}

// Every agent record is its own member of the reverse export. A package that
// carried statuses without their approvals would roll back a node that says it
// is blocked with nothing to unblock it.
func TestAgentReverseExportCarriesEveryRecord(t *testing.T) {
	for _, record := range []*pb.ReverseExportRecord{
		{Entity: &pb.ReverseExportRecord_AgentStatus{AgentStatus: &pb.AgentStatus{NodeId: "n", Revision: 1}}},
		{Entity: &pb.ReverseExportRecord_Approval{Approval: &pb.Approval{ApprovalId: "a"}}},
		{Entity: &pb.ReverseExportRecord_MailboxMessage{MailboxMessage: &pb.MailboxMessage{MessageId: "m"}}},
		{Entity: &pb.ReverseExportRecord_Delivery{Delivery: &pb.Delivery{TraceId: "t"}}},
		{Entity: &pb.ReverseExportRecord_Handoff{Handoff: &pb.Handoff{HandoffId: "h"}}},
		{Entity: &pb.ReverseExportRecord_ContextLinks{ContextLinks: &pb.ContextLinks{NodeId: "n"}}},
	} {
		data, err := proto.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		decoded := new(pb.ReverseExportRecord)
		if err = proto.Unmarshal(data, decoded); err != nil || !proto.Equal(decoded, record) {
			t.Fatal("a reverse export record changed")
		}
	}
}

// The seven agent members of the event envelope keep their own numbers. A
// client subscribing to approvals must never decode a status into one.
func TestAgentEventEnvelopeMembers(t *testing.T) {
	for _, envelope := range []*pb.EventEnvelope{
		{Domain: pb.EventDomain_EVENT_DOMAIN_AGENT, Kind: "status", Entity: &pb.EventEnvelope_AgentStatus{AgentStatus: &pb.AgentStatus{NodeId: "n"}}},
		{Domain: pb.EventDomain_EVENT_DOMAIN_AGENT, Kind: "hookEvent", Entity: &pb.EventEnvelope_HookEvent{HookEvent: &pb.HookEvent{EventId: "e"}}},
		{Domain: pb.EventDomain_EVENT_DOMAIN_AGENT, Kind: "approval", Entity: &pb.EventEnvelope_Approval{Approval: &pb.Approval{ApprovalId: "a"}}},
		{Domain: pb.EventDomain_EVENT_DOMAIN_AGENT, Kind: "mailbox", Entity: &pb.EventEnvelope_MailboxMessage{MailboxMessage: &pb.MailboxMessage{MessageId: "m"}}},
		{Domain: pb.EventDomain_EVENT_DOMAIN_AGENT, Kind: "delivery", Entity: &pb.EventEnvelope_Delivery{Delivery: &pb.Delivery{TraceId: "t"}}},
		{Domain: pb.EventDomain_EVENT_DOMAIN_AGENT, Kind: "handoff", Entity: &pb.EventEnvelope_Handoff{Handoff: &pb.Handoff{HandoffId: "h"}}},
		{Domain: pb.EventDomain_EVENT_DOMAIN_AGENT, Kind: "contextLinks", Entity: &pb.EventEnvelope_ContextLinks{ContextLinks: &pb.ContextLinks{NodeId: "n"}}},
	} {
		data, err := proto.Marshal(envelope)
		if err != nil {
			t.Fatal(err)
		}
		decoded := new(pb.EventEnvelope)
		if err = proto.Unmarshal(data, decoded); err != nil || !proto.Equal(decoded, envelope) {
			t.Fatalf("the %s envelope changed", envelope.GetKind())
		}
	}
}
