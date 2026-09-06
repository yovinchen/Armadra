import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
} from "@bufbuild/protobuf";
import {
  AgentPromptPhase,
  AgentPromptReceiptSchema,
  AgentPromptRequestSchema,
  AgentState,
  AgentStatusSchema,
  AgentTargetRequestSchema,
  AgentTargetState,
  AgentTargetStatusSchema,
  AgentWorkerResponseSchema,
  ApprovalSchema,
  ApprovalState,
  AutomationColdStartPolicy,
  AutomationTargetKind,
  AutomationTargetSchema,
  DeliveryOutcome,
  DeliverySchema,
  EventDomain,
  EventEnvelopeSchema,
  HandoffSchema,
  HandoffState,
  HookEventKind,
  HookEventSchema,
  MailboxMessageSchema,
  WorkerRequestSchema,
} from "../src/index.js";

function fixture(name: string): Uint8Array {
  const hex = readFileSync(
    new URL(`../../../proto/fixtures/${name}.hex`, import.meta.url),
    "utf8",
  ).trim();
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function check<T extends DescMessage>(
  name: string,
  schema: T,
  init: MessageInitShape<T>,
) {
  const expected = create(schema, init);
  const wire = fixture(name);
  expect(fromBinary(schema, wire)).toEqual(expected);
  expect(toBinary(schema, expected)).toEqual(wire);
}

const beyondDouble = 9_007_199_254_740_993n;
const maxUint64 = 18_446_744_073_709_551_615n;
const utf8 = new TextEncoder();

// The agent domain's record half (Go Host 业务所有权迁移 §2.7).
//
// The browser reads these because it is the side that draws them: a node header
// that says BLOCKED, an approval a person is about to answer from a phone, an
// inbox badge, a handoff card. Each of the shapes below is a distinction the
// interface has to keep — and the ones that matter most are the absences.
describe("agent records", () => {
  it("keeps an absent errored flag absent on a blocked node", () => {
    check("agent_status_blocked", AgentStatusSchema, {
      nodeId: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
      workspaceId: "0123456789abcdef0123456789abcdef",
      sessionId: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
      generation: 7n,
      agentId: "claude",
      unread: 3,
      verified: true,
      interrupted: true,
      transcriptRef: utf8.encode("claude/8f2d1c4a"),
      stateSource: "hook",
      state: AgentState.BLOCKED,
      sessionPhase: "turn",
      reasonCode: "agent.blocked.approval",
      lastEventAtUnixMs: 1_788_557_800_000n,
      updatedAtUnixMs: 1_788_557_900_000n,
      revision: beyondDouble,
    });
  });

  // The browser draws the source as a hint next to the badge, so it has to
  // survive a provider it has never heard of and a kind that was appended after
  // the first four adapters. Neither the payload nor its digest is ever read
  // here: it is the Worker's normalized form, carried, not parsed.
  it("carries a turn opening from an unknown provider", () => {
    check("agent_hook_event_turn_start", HookEventSchema, {
      eventId: "f0a1b2c3d4e5f60718293a4b5c6d7e8f",
      nodeId: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
      sessionId: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
      generation: 7n,
      workspaceId: "0123456789abcdef0123456789abcdef",
      provider: "pi",
      payload: utf8.encode(
        '{"kind":"state","state":"working","stateSource":"extension"}',
      ),
      payloadSha256: new Uint8Array(32).fill(0x7e),
      schemaVersion: 1,
      kind: HookEventKind.TURN_START,
      observedAtUnixMs: 1_788_557_700_000n,
    });
  });

  // Appending the two kinds the extension CLIs need must not renumber the six
  // that were already on the wire: a shifted value would turn every stored
  // SESSION_END into an APPROVAL.
  it("keeps the hook event kinds append-only", () => {
    expect([
      HookEventKind.UNSPECIFIED,
      HookEventKind.SESSION_START,
      HookEventKind.USER_PROMPT,
      HookEventKind.TURN_END,
      HookEventKind.NOTIFICATION,
      HookEventKind.APPROVAL,
      HookEventKind.SESSION_END,
      HookEventKind.TURN_START,
      HookEventKind.COMPACTION,
    ]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("carries an approval's request as bytes with its digest", () => {
    check("agent_approval_pending", ApprovalSchema, {
      approvalId: "b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2",
      nodeId: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
      workspaceId: "0123456789abcdef0123456789abcdef",
      sessionId: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
      generation: 7n,
      request: utf8.encode('{"tool":"Bash","command":"rm -rf 构建/"}'),
      requestSha256: new Uint8Array(32).fill(0x5a),
      state: ApprovalState.PENDING,
      createdAtUnixMs: 1_788_557_800_000n,
      revision: 1n,
    });
  });

  it("reads an unread message by its zero acknowledgement stamp", () => {
    check("agent_mailbox_unread", MailboxMessageSchema, {
      messageId: "c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6",
      workspaceId: "0123456789abcdef0123456789abcdef",
      sourceNodeId: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
      targetNodeId: "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
      messageKey: "handoff/迁移",
      body: "接手 agent 域的 e2e，剩下的在 tools/ownership/。",
      sequence: 42n,
      createdAtUnixMs: 1_788_557_800_000n,
      expiresAtUnixMs: 1_788_644_200_000n,
      revision: 1n,
    });
  });

  // UNKNOWN is not a failure. A client draws it as "we cannot tell", and
  // nothing — no button, no timer — resends from it.
  it("reports a delivery nobody can attribute as UNKNOWN", () => {
    check("agent_delivery_unknown", DeliverySchema, {
      traceId: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
      workspaceId: "0123456789abcdef0123456789abcdef",
      sourceNodeId: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
      targetNodeId: "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
      receipt: "armadra-9a8b7c6d:0.0",
      bodyChars: 128,
      outcome: DeliveryOutcome.UNKNOWN,
      reasonCode: "agent.delivery.unattributable",
      createdAtUnixMs: 1_788_557_900_000n,
      revision: 2n,
    });
  });

  it("keeps a handoff's frozen bundle and its attempt count", () => {
    check("agent_handoff_unknown_outcome", HandoffSchema, {
      handoffId: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      workspaceId: "0123456789abcdef0123456789abcdef",
      sourceNodeId: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
      targetNodeId: "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
      source: {
        sessionId: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
        generation: 7n,
      },
      target: {
        sessionId: "1a2b3c4d5e6f708192a3b4c5d6e7f809",
        generation: 2n,
      },
      bundle: utf8.encode(
        '{"summary":"迁移到 Host","files":["docs/design/host-business-migration.md"]}',
      ),
      bundleSha256: new Uint8Array(32).fill(0x3c),
      mailboxId: "c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6",
      traceId: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
      attempts: 2,
      state: HandoffState.UNKNOWN_OUTCOME,
      errorCode: "agent.handoff.unattributable",
      createdAtUnixMs: 1_788_557_000_000n,
      acceptedAtUnixMs: 1_788_557_500_000n,
      updatedAtUnixMs: 1_788_557_900_000n,
      revision: maxUint64,
    });
  });

  it("reads the Worker's own listing of its agent rows", () => {
    check("agent_worker_states", AgentWorkerResponseSchema, {
      result: {
        case: "agents",
        value: {
          workerInstanceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
          agents: [
            {
              nodeId: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
              workspaceId: "0123456789abcdef0123456789abcdef",
              sessionId: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
              generation: 7n,
              agentId: "claude",
              unread: 3,
              verified: true,
              transcriptRef: utf8.encode("claude/8f2d1c4a"),
              state: AgentState.BLOCKED,
              sessionPhase: "turn",
              lastEventAtUnixMs: 1_788_557_800_000n,
              updatedAtUnixMs: 1_788_557_900_000n,
            },
          ],
          approvals: [
            {
              approvalId: "b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2",
              nodeId: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
              workspaceId: "0123456789abcdef0123456789abcdef",
              request: utf8.encode('{"tool":"Bash","command":"rm -rf 构建/"}'),
              requestSha256: new Uint8Array(32).fill(0x5a),
              state: ApprovalState.PENDING,
              createdAtUnixMs: 1_788_557_800_000n,
            },
          ],
        },
      },
    });
  });

  // "The CLI reported no error" and "nobody has reported anything" are a green
  // badge and a grey one. Folding them would make every node that has never run
  // look like one that ran cleanly.
  it("distinguishes a reported false from an absent flag", () => {
    const reported = create(AgentStatusSchema, { nodeId: "n", errored: false });
    const silent = create(AgentStatusSchema, { nodeId: "n" });
    expect(toBinary(AgentStatusSchema, reported)).not.toEqual(
      toBinary(AgentStatusSchema, silent),
    );
    expect(
      fromBinary(AgentStatusSchema, toBinary(AgentStatusSchema, silent))
        .errored,
    ).toBeUndefined();
    expect(
      fromBinary(AgentStatusSchema, toBinary(AgentStatusSchema, reported))
        .errored,
    ).toBe(false);
  });

  // 21 is the released prompt frame and writes into a PTY; 28 carries the
  // records the Host owns. A client that confused them would answer a listing
  // by typing into somebody's terminal.
  it("travels on worker action 28 and envelope members 180-186", () => {
    expect(
      WorkerRequestSchema.fields.find((field) => field.name === "agent_host")
        ?.number,
    ).toBe(28);
    const request = create(WorkerRequestSchema, {
      requestId: "h-agent-1",
      hostId: "0123456789abcdef0123456789abcdef",
      action: {
        case: "agentHost",
        value: { action: { case: "listAgents", value: {} } },
      },
    });
    expect(
      fromBinary(WorkerRequestSchema, toBinary(WorkerRequestSchema, request)),
    ).toEqual(request);

    for (const [name, expected] of [
      ["agent_status", 180],
      ["hook_event", 181],
      ["approval", 182],
      ["mailbox_message", 183],
      ["delivery", 184],
      ["handoff", 185],
      ["context_links", 186],
    ] as const) {
      expect(
        EventEnvelopeSchema.fields.find((field) => field.name === name)?.number,
      ).toBe(expected);
    }

    const envelope = create(EventEnvelopeSchema, {
      sequence: 12n,
      domain: EventDomain.AGENT,
      kind: "approval",
      entityId: "b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2",
      entity: {
        case: "approval",
        value: { approvalId: "b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2" },
      },
    });
    expect(
      fromBinary(EventEnvelopeSchema, toBinary(EventEnvelopeSchema, envelope)),
    ).toEqual(envelope);
  });

  it("keeps prompt delivery evidence separable from proven non-delivery", () => {
    check("agent_target_status", AgentTargetStatusSchema, {
      state: AgentTargetState.ABSENT,
      sessionId: "会话-1",
      generation: maxUint64,
      reasonCode: "SESSION_ABSENT",
    });
    check("agent_target_request", AgentTargetRequestSchema, {
      workspaceId: "workspace-1",
      nodeId: "node-1",
      sessionId: "session-1",
      generation: 9007199254740993n,
      expected: {
        agentId: "claude",
        workingDirectory: "/项目/仓库",
        accountId: "default",
      },
      coldStart: {
        agentId: "claude",
        workingDirectory: "/项目/仓库",
        args: ["--flag", "值📦"],
        permissionMode: "acceptEdits",
        modelId: "sonnet",
        accountId: "default",
      },
    });
    check("agent_prompt_request", AgentPromptRequestSchema, {
      operationId:
        "automation/principal-1/host-0123456789abcdef0123456789abcdef/workspace-1/dispatch/run-1",
      requestSha256: new Uint8Array(32).fill(5),
      workspaceId: "workspace-1",
      nodeId: "node-1",
      sessionId: "session-1",
      generation: 9007199254740993n,
      prompt: new TextEncoder().encode("每晚复盘：读取 diff 后写结论\n"),
      expected: {
        agentId: "claude",
        workingDirectory: "/项目/仓库",
        args: ["--flag", "值📦"],
        permissionMode: "acceptEdits",
        modelId: "sonnet",
        accountId: "default",
      },
    });
    check("agent_prompt_not_written", AgentPromptReceiptSchema, {
      operationId: "operation-1",
      requestSha256: new Uint8Array(32).fill(6),
      phase: AgentPromptPhase.NOT_WRITTEN,
      sequence: 1n,
      observedAtUnixMs: 1788557000000n,
      reasonCode: "TARGET_BUSY",
      sessionId: "session-1",
      generation: 3n,
      noEffectProven: true,
    });
    check("agent_prompt_unknown", AgentPromptReceiptSchema, {
      operationId: "operation-1",
      requestSha256: new Uint8Array(32).fill(6),
      phase: 999 as AgentPromptPhase,
      sequence: maxUint64,
      observedAtUnixMs: 1788557900000n,
      reasonCode: "UNATTRIBUTED",
      sessionId: "session-2",
      generation: maxUint64,
      coldStarted: true,
    });
    check("automation_agent_target", AutomationTargetSchema, {
      executionHostId: "0123456789abcdef0123456789abcdef",
      sessionId: "session-1",
      generation: 7n,
      kind: AutomationTargetKind.AGENT_SESSION_PROMPT,
      nodeId: "node-1",
      coldStartPolicy: AutomationColdStartPolicy.LAUNCH_FROZEN,
      agentLaunch: {
        agentId: "codex",
        workingDirectory: "/项目/仓库",
        accountId: "default",
      },
    });
    // A plan frozen before the field existed stays a command target.
    const legacy = fromBinary(
      AutomationTargetSchema,
      toBinary(
        AutomationTargetSchema,
        create(AutomationTargetSchema, {
          executionHostId: "host-1",
          sessionId: "session-1",
          generation: 1n,
        }),
      ),
    );
    expect(legacy.kind).toBe(AutomationTargetKind.UNSPECIFIED);
    expect(legacy.nodeId).toBe("");
    expect(legacy.agentLaunch).toBeUndefined();
  });
});
