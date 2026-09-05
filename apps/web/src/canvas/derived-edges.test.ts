import { describe, expect, it } from "vitest";
import type { CanvasNode, TerminalAgent } from "@armadra/shared";

import type { SubagentCardModel } from "@/agent/subagent-store";
import {
  ROPE_WAITING_LABEL,
  deriveEdges,
  ropeColor,
  ropeLabel,
  type DerivedEdge,
} from "./derived-edges";

const BOARD = "019ff7d1-0d12-7421-833d-2c5e8d64ed00";
const A = "019ff7d1-0d12-7421-833d-2c5e8d64ed01";
const B = "019ff7d1-0d12-7421-833d-2c5e8d64ed02";
const C = "019ff7d1-0d12-7421-833d-2c5e8d64ed03";

function terminal(id: string, agent?: TerminalAgent): CanvasNode {
  const now = "2026-09-04T10:00:00.000Z";
  return {
    id,
    boardId: BOARD,
    type: "terminal",
    title: id.slice(0, 4),
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    data: { kind: "terminal", ...(agent ? { agent } : {}) },
    createdAt: now,
    updatedAt: now,
  } as CanvasNode;
}

function card(
  id: string,
  parentId: string,
  state: "working" | "done",
): SubagentCardModel {
  return { id, parentId, taskLabel: id, startedAt: 0, state };
}

/** 派生边只关心这三项；id / 两端在别的断言里单独看。 */
const dataOf = (edge: DerivedEdge) => ({
  variant: edge.variant,
  waiting: edge.waiting,
  color: edge.color,
});

describe("derived edges", () => {
  it("draws a waiting rope from every dependency to the pending node", () => {
    const edges = deriveEdges({
      nodes: [
        terminal(A, { id: "claude" }),
        terminal(B, { id: "codex" }),
        terminal(C, {
          id: "gemini",
          pendingLaunch: { command: "gemini", after: [A, B] },
        }),
      ],
      launchedAfter: {},
      cards: {},
    });

    expect(edges.map((edge) => edge.id)).toEqual([
      `rope:${A}->${C}`,
      `rope:${B}->${C}`,
    ]);
    expect(dataOf(edges[0]!)).toEqual({
      variant: "rope",
      waiting: true,
      // 颜色取的是**上游**节点的品牌色，不是等待方的。
      color: "var(--agent-claude)",
    });
    expect(dataOf(edges[1]!).color).toBe("var(--agent-codex)");
    // 派生边不进文档，所以它根本不是 shape：只有 `variant` 这一个类型标记。
    expect(edges[0]!.variant).toBe("rope");
  });

  it("keeps the rope solid after the node launched", () => {
    const edges = deriveEdges({
      nodes: [terminal(A, { id: "claude" }), terminal(C, { id: "gemini" })],
      launchedAfter: { [C]: [A] },
      cards: {},
    });
    expect(edges).toHaveLength(1);
    expect(dataOf(edges[0]!).waiting).toBe(false);
  });

  it("drops a rope whose dependency left the board", () => {
    const edges = deriveEdges({
      nodes: [
        terminal(C, {
          id: "gemini",
          pendingLaunch: { command: "gemini", after: [A, B] },
        }),
        terminal(B, { id: "codex" }),
      ],
      launchedAfter: {},
      cards: {},
    });
    expect(edges.map((edge) => edge.id)).toEqual([`rope:${B}->${C}`]);
  });

  it("never links a node to itself", () => {
    const edges = deriveEdges({
      nodes: [
        terminal(A, {
          id: "claude",
          pendingLaunch: { command: "claude", after: [A] },
        }),
      ],
      launchedAfter: {},
      cards: {},
    });
    expect(edges).toEqual([]);
  });

  it("links a parent to each of its subagent cards", () => {
    const edges = deriveEdges({
      nodes: [terminal(A, { id: "claude" })],
      launchedAfter: {},
      cards: { [A]: [card("tool-1", A, "working"), card("tool-2", A, "done")] },
    });
    expect(edges.map((edge) => edge.target)).toEqual([
      "subagent-card:tool-1",
      "subagent-card:tool-2",
    ]);
    expect(dataOf(edges[0]!)).toEqual({
      variant: "subagent",
      waiting: true,
      color: "var(--agent-working)",
    });
    // 结束的卡片不再流动。
    expect(dataOf(edges[1]!).waiting).toBe(false);
  });

  it("falls back to the accent colour for non-agent dependencies", () => {
    expect(ropeColor(undefined)).toBe("var(--brand)");
    expect(ropeColor(terminal(A))).toBe("var(--brand)");
    expect(ropeColor(terminal(A, { id: "opencode" }))).toBe(
      "var(--agent-opencode)",
    );
  });

  it("hangs the waiting label on ropes only while they are waiting", () => {
    const [waiting, launched, subagent] = [
      { variant: "rope", waiting: true },
      { variant: "rope", waiting: false },
      { variant: "subagent", waiting: true },
    ] as const;
    // 等待中的 rope：虚线 + 沙漏（覆盖层里是同一个 `waiting` 开关）。
    expect(ropeLabel(waiting)).toBe(ROPE_WAITING_LABEL);
    expect(ROPE_WAITING_LABEL).toBe("\u23f3");
    // 启动之后实线、无标签。
    expect(ropeLabel(launched)).toBeNull();
    // 子代理卡片自己有胶囊与计时，绳子上不重复挂沙漏。
    expect(ropeLabel(subagent)).toBeNull();
  });

  it("labels the pending rope produced by --after", () => {
    const edges = deriveEdges({
      nodes: [
        terminal(A, { id: "claude" }),
        terminal(B, {
          id: "codex",
          pendingLaunch: { command: "codex", after: [A] },
        }),
      ],
      launchedAfter: {},
      cards: {},
    });
    expect(edges.map(ropeLabel)).toEqual([ROPE_WAITING_LABEL]);
  });
});
