import { beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, AgentStatus, WorkspaceEvent } from "@armadra/shared";

import {
  MAX_CARDS_PER_PARENT,
  cardKey,
  subagentNodeId,
  useSubagentStore,
} from "./subagent-store";

const PARENT = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed22";
const BASE = Date.parse("2026-09-04T10:00:00.000Z");

const store = () => useSubagentStore.getState();

function event(
  partial: Partial<AgentEvent> & { kind: AgentEvent["kind"] },
): WorkspaceEvent {
  return {
    type: "agent.subagent",
    event: {
      nodeId: PARENT,
      agentId: "claude",
      ...partial,
    } as AgentEvent,
  };
}

function statusFrame(state: AgentStatus["state"]): WorkspaceEvent {
  return {
    type: "agent.status",
    status: {
      nodeId: PARENT,
      workspaceId: WORKSPACE,
      agentId: "claude",
      state,
      unread: false,
      verified: true,
      restored: false,
      updatedAt: new Date(BASE).toISOString(),
    },
  };
}

beforeEach(() => store().reset());

describe("subagent cards", () => {
  it("opens a card on start and fills the totals on end", () => {
    store().handleEvent(
      event({
        kind: "subagent-start",
        toolUseId: "tool-1",
        subagentType: "Explore",
        taskLabel: "找到派生边的实现",
      }),
      BASE,
    );
    expect(store().cards[PARENT]).toHaveLength(1);
    const opened = store().cards[PARENT]![0]!;
    expect(opened).toMatchObject({
      id: "tool-1",
      parentId: PARENT,
      type: "Explore",
      taskLabel: "找到派生边的实现",
      state: "working",
      startedAt: BASE,
    });

    store().handleEvent(
      event({
        kind: "subagent-end",
        toolUseId: "tool-1",
        durationMs: 4_200,
        tokens: 1_234,
        toolUses: 7,
        result: "在 canvas/derived-edges.ts",
      }),
      BASE + 5_000,
    );
    expect(store().cards[PARENT]![0]).toMatchObject({
      id: "tool-1",
      state: "done",
      durationMs: 4_200,
      tokens: 1_234,
      toolUses: 7,
      result: "在 canvas/derived-edges.ts",
      // 开始时刻不会被结束事件改写。
      startedAt: BASE,
      taskLabel: "找到派生边的实现",
    });
  });

  it("keys codex subagents by their agent id and falls back per type", () => {
    expect(
      cardKey({
        nodeId: PARENT,
        agentId: "codex",
        kind: "subagent-start",
        toolUseId: "agent-9",
      } as AgentEvent),
    ).toBe("agent-9");
    expect(
      cardKey({
        nodeId: PARENT,
        agentId: "codex",
        kind: "subagent-start",
        subagentType: "review",
      } as AgentEvent),
    ).toBe(`${PARENT}:review`);
    expect(subagentNodeId("tool-1")).toBe("subagent-card:tool-1");
  });

  it("does not duplicate a card when a start is replayed", () => {
    store().handleEvent(
      event({ kind: "subagent-start", toolUseId: "tool-1" }),
      BASE,
    );
    store().handleEvent(
      event({ kind: "subagent-start", toolUseId: "tool-1" }),
      BASE + 10,
    );
    expect(store().cards[PARENT]).toHaveLength(1);
  });

  it("still shows the totals when only the end event arrives", () => {
    store().handleEvent(
      event({ kind: "subagent-end", toolUseId: "tool-9", tokens: 10 }),
      BASE,
    );
    expect(store().cards[PARENT]![0]).toMatchObject({
      id: "tool-9",
      state: "done",
      tokens: 10,
    });
  });

  it("keeps at most 8 cards per parent, dropping the oldest", () => {
    for (let index = 0; index < MAX_CARDS_PER_PARENT + 3; index += 1) {
      store().handleEvent(
        event({ kind: "subagent-start", toolUseId: `tool-${index}` }),
        BASE + index,
      );
    }
    const cards = store().cards[PARENT]!;
    expect(cards).toHaveLength(MAX_CARDS_PER_PARENT);
    expect(cards[0]!.id).toBe("tool-3");
    expect(cards.at(-1)!.id).toBe("tool-10");
  });

  it("clears only finished cards when the parent opens a new turn", () => {
    store().handleEvent(
      event({ kind: "subagent-start", toolUseId: "done-1" }),
      BASE,
    );
    store().handleEvent(
      event({ kind: "subagent-end", toolUseId: "done-1" }),
      BASE + 1,
    );
    store().handleEvent(
      event({ kind: "subagent-start", toolUseId: "live-1" }),
      BASE + 2,
    );
    store().handleEvent(statusFrame("done"));
    expect(store().cards[PARENT]).toHaveLength(2);

    // 非 working → working 就是新回合的边。
    store().handleEvent(statusFrame("working"));
    expect(store().cards[PARENT]!.map((card) => card.id)).toEqual(["live-1"]);

    // 同一状态再来一次不该清掉任何东西。
    store().handleEvent(
      event({ kind: "subagent-end", toolUseId: "live-1" }),
      BASE + 3,
    );
    store().handleEvent(statusFrame("working"));
    expect(store().cards[PARENT]).toHaveLength(1);
  });

  it("drops every card when the terminal exits", () => {
    store().handleEvent(
      event({ kind: "subagent-start", toolUseId: "tool-1" }),
      BASE,
    );
    store().handleEvent({
      type: "terminal.exit",
      sessionId: "s-1",
      nodeId: PARENT,
    });
    expect(store().cards[PARENT]).toBeUndefined();
  });

  it("ignores non-subagent kinds", () => {
    store().handleEvent(event({ kind: "state", state: "working" }), BASE);
    expect(store().cards[PARENT]).toBeUndefined();
  });
});
