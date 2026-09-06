import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  AgentState,
  AgentStatusSchema,
  AnswerApprovalRequestSchema,
  AnswerApprovalResponseSchema,
  ApprovalSchema,
  ApprovalState,
  DeliveryOutcome,
  DeliverySchema,
  HandoffSchema,
  HandoffState,
  ListAgentStatusResponseSchema,
  ListContextLinksResponseSchema,
  ListDeliveriesResponseSchema,
  MarkAgentReadRequestSchema,
  MarkAgentReadResponseSchema,
  PrepareHandoffRequestSchema,
  PrepareHandoffResponseSchema,
} from "@armadra/protocol";
import { HostAgentClient } from "../src/agent.js";
import { HostCanvasError } from "../src/canvas.js";
import type { HostAuthenticatedTransport } from "../src/automation.js";

const hostId = "1".repeat(32);
const workspaceId = "workspace-1";
/** 2^53 + 1: the first integer a JavaScript number cannot represent. */
const beyondDouble = 9_007_199_254_740_993n;
const utf8 = new TextEncoder();

interface Sent {
  service: string;
  action: string;
  body: Uint8Array;
  mutation: boolean;
}

function client(reply: (call: Sent) => Uint8Array) {
  const calls: Sent[] = [];
  const session: HostAuthenticatedTransport = {
    send: (service, action, body, mutation) => {
      const call = { service, action, body, mutation };
      calls.push(call);
      return Promise.resolve(reply(call));
    },
  };
  return { api: new HostAgentClient({ session, hostId, workspaceId }), calls };
}

function status(overrides: Record<string, unknown> = {}) {
  return create(AgentStatusSchema, {
    nodeId: "node-one",
    workspaceId,
    sessionId: "session-one",
    generation: 3n,
    agentId: "claude",
    unread: 2,
    verified: true,
    state: AgentState.BLOCKED,
    sessionPhase: "turn",
    transcriptRef: utf8.encode("claude/session-one"),
    lastEventAtUnixMs: 1_788_557_800_000n,
    updatedAtUnixMs: 1_788_557_900_000n,
    revision: 1n,
    ...overrides,
  });
}

describe("HostAgentClient", () => {
  it("reads a workspace's agents and keeps an absent flag absent", async () => {
    const { api, calls } = client(() =>
      toBinary(
        ListAgentStatusResponseSchema,
        create(ListAgentStatusResponseSchema, {
          statuses: [
            status(),
            status({
              nodeId: "node-two",
              errored: false,
              revision: beyondDouble,
            }),
          ],
        }),
      ),
    );
    const listed = await api.listStatus();
    expect(calls[0]?.action).toBe("ListStatus");
    expect(calls[0]?.mutation).toBe(false);
    expect(listed).toHaveLength(2);
    expect(listed[0]?.state).toBe("blocked");
    expect(listed[0]?.unread).toBe(2);
    // A node nobody has reported an error for draws differently from one that
    // reported none. The absence has to survive the decode.
    expect(listed[0]?.errored).toBeUndefined();
    expect(listed[1]?.errored).toBe(false);
    // A revision past 2^53 stays exact, because it is what the next write has
    // to name and a rounded one would be refused as stale forever.
    expect(listed[1]?.revision).toBe(beyondDouble);
  });

  it("carries the revision a badge was read at", async () => {
    const { api, calls } = client(() =>
      toBinary(
        MarkAgentReadResponseSchema,
        create(MarkAgentReadResponseSchema, { status: status({ unread: 0 }) }),
      ),
    );
    const cleared = await api.markRead({
      operationId: "agent/node-one/read/1",
      expectedRevision: 1n,
      nodeId: "node-one",
    });
    expect(cleared.unread).toBe(0);
    const request = fromBinary(MarkAgentReadRequestSchema, calls[0]!.body);
    expect(request.expectedRevision).toBe(1n);
    expect(request.nodeId).toBe("node-one");
    expect(calls[0]?.mutation).toBe(true);
  });

  it("passes a CLI's own decision through unchanged", async () => {
    const { api, calls } = client(() =>
      toBinary(
        AnswerApprovalResponseSchema,
        create(AnswerApprovalResponseSchema, {
          approval: create(ApprovalSchema, {
            approvalId: "approval-one",
            nodeId: "node-one",
            workspaceId,
            request: utf8.encode('{"tool":"Bash"}'),
            decision: "allow_always",
            answeredBy: "owner-1",
            state: ApprovalState.ANSWERED,
            createdAtUnixMs: 1_788_557_800_000n,
            answeredAtUnixMs: 1_788_557_900_000n,
            revision: 2n,
          }),
        }),
      ),
    );
    const answered = await api.answerApproval({
      operationId: "agent/approval-one/answer/1",
      expectedRevision: 1n,
      approvalId: "approval-one",
      decision: "allow_always",
    });
    // Mapping it onto an enum would be this client deciding what a provider
    // meant, and a provider it has never heard of would lose its answer.
    expect(answered.decision).toBe("allow_always");
    expect(answered.state).toBe("answered");
    const request = fromBinary(AnswerApprovalRequestSchema, calls[0]!.body);
    expect(request.decision).toBe("allow_always");
    expect(request.expectedRevision).toBe(1n);
  });

  it("refuses an answer with no decision before it reaches the wire", async () => {
    const { api, calls } = client(() => new Uint8Array());
    await expect(
      api.answerApproval({
        operationId: "agent/approval-one/answer/1",
        expectedRevision: 1n,
        approvalId: "approval-one",
        decision: "",
      }),
    ).rejects.toBeInstanceOf(HostCanvasError);
    expect(calls).toHaveLength(0);
  });

  it("freezes a bundle on prepare and sends nothing else", async () => {
    const bundle = utf8.encode('{"summary":"迁移"}');
    const { api, calls } = client(() =>
      toBinary(
        PrepareHandoffResponseSchema,
        create(PrepareHandoffResponseSchema, {
          handoff: create(HandoffSchema, {
            handoffId: "handoff-one",
            workspaceId,
            sourceNodeId: "node-two",
            targetNodeId: "node-one",
            bundle,
            state: HandoffState.PREPARED,
            createdAtUnixMs: 1_788_557_000_000n,
            updatedAtUnixMs: 1_788_557_000_000n,
            revision: 1n,
          }),
        }),
      ),
    );
    const prepared = await api.prepareHandoff({
      operationId: "agent/handoff-one/prepare",
      expectedRevision: 0n,
      handoffId: "handoff-one",
      sourceNodeId: "node-two",
      targetNodeId: "node-one",
      bundle,
    });
    expect(prepared.state).toBe("prepared");
    expect(prepared.bundle).toEqual(bundle);
    const request = fromBinary(PrepareHandoffRequestSchema, calls[0]!.body);
    expect(request.bundle).toEqual(bundle);
    expect(calls[0]?.action).toBe("PrepareHandoff");
  });

  it("refuses a handoff with no bundle", async () => {
    const { api, calls } = client(() => new Uint8Array());
    await expect(
      api.prepareHandoff({
        operationId: "agent/handoff-one/prepare",
        expectedRevision: 0n,
        handoffId: "handoff-one",
        sourceNodeId: "node-two",
        targetNodeId: "node-one",
        bundle: new Uint8Array(),
      }),
    ).rejects.toBeInstanceOf(HostCanvasError);
    expect(calls).toHaveLength(0);
  });

  it("reads an unattributable delivery as unknown rather than failed", async () => {
    const { api } = client(() =>
      toBinary(
        ListDeliveriesResponseSchema,
        create(ListDeliveriesResponseSchema, {
          deliveries: [
            create(DeliverySchema, {
              traceId: "trace-one",
              workspaceId,
              targetNodeId: "node-one",
              outcome: DeliveryOutcome.UNKNOWN,
              reasonCode: "agent.delivery.unattributable",
              createdAtUnixMs: 1_788_557_900_000n,
              revision: 1n,
            }),
          ],
        }),
      ),
    );
    const [delivery] = await api.listDeliveries("node-one");
    expect(delivery?.outcome).toBe("unknown");
    expect(delivery?.reasonCode).toBe("agent.delivery.unattributable");
  });

  it("reads context links in both directions", async () => {
    const { api } = client(() =>
      toBinary(
        ListContextLinksResponseSchema,
        create(ListContextLinksResponseSchema, {
          links: [
            {
              nodeId: "node-one",
              workspaceId,
              links: [
                { targetNodeId: "node-two", direction: 2, kind: "agent" },
                { targetNodeId: "node-three", direction: 1, kind: "sticky" },
              ],
              updatedAtUnixMs: 1_788_557_900_000n,
              revision: 1n,
            },
          ],
        }),
      ),
    );
    const [links] = await api.listContextLinks("node-one");
    // The direction is what decides which of the two may read the other, so a
    // client that folded them would grant a read nobody drew.
    expect(links?.links[0]?.direction).toBe("incoming");
    expect(links?.links[1]?.direction).toBe("outgoing");
  });

  // An enum this build has never heard of is a response failure, not a default.
  // Reading an unknown state as `idle` would draw a node as finished on the
  // strength of a number nobody can explain.
  it("refuses a state it cannot name", async () => {
    const { api } = client(() =>
      toBinary(
        ListAgentStatusResponseSchema,
        create(ListAgentStatusResponseSchema, {
          statuses: [status({ state: 99 })],
        }),
      ),
    );
    await expect(api.listStatus()).rejects.toBeInstanceOf(HostCanvasError);
  });

  it("names the workspace and the host on every request", async () => {
    const { api, calls } = client(() =>
      toBinary(
        ListAgentStatusResponseSchema,
        create(ListAgentStatusResponseSchema, {}),
      ),
    );
    await api.listStatus();
    const request = fromBinary(
      (await import("@armadra/protocol")).ListAgentStatusRequestSchema,
      calls[0]!.body,
    );
    expect(request.meta?.scope?.workspaceId).toBe(workspaceId);
    expect(request.meta?.scope?.hostId).toBe(hostId);
    expect(request.meta?.requestId).toBeTruthy();
  });

  it("refuses to be constructed without a workspace", () => {
    const session: HostAuthenticatedTransport = {
      send: () => Promise.resolve(new Uint8Array()),
    };
    expect(
      () => new HostAgentClient({ session, hostId, workspaceId: "" }),
    ).toThrow(HostCanvasError);
  });
});
