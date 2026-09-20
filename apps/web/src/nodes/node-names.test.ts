import { describe, expect, it } from "vitest";
import type { CanvasNode } from "@armadra/shared";

import {
  holderOf,
  nodeName,
  normalizeName,
  suggestName,
  takenNames,
} from "./node-names";

function node(patch: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: "n1",
    boardId: "b1",
    type: "terminal",
    title: "终端",
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    data: { kind: "terminal" },
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...patch,
  } as CanvasNode;
}

function agent(id: string, agentId: string, handle?: string): CanvasNode {
  return node({
    id,
    data: {
      kind: "terminal",
      agent: { id: agentId },
      ...(handle === undefined ? {} : { handle }),
    },
  } as Partial<CanvasNode>);
}

describe("节点的名字", () => {
  it("折叠大小写，拒绝任何要加引号才能写进命令行的东西", () => {
    expect(normalizeName("Review")).toBe("review");
    expect(normalizeName(" codex-1 ")).toBe("codex-1");
    expect(normalizeName("has space")).toBeUndefined();
    expect(normalizeName("-leading")).toBeUndefined();
    expect(normalizeName("")).toBeUndefined();
    expect(normalizeName("x".repeat(25))).toBeUndefined();
  });

  it("文档里的副本重新校验，不直接信", () => {
    expect(nodeName(agent("a", "codex", "Review"))).toBe("review");
    expect(nodeName(agent("a", "codex", "has space"))).toBeUndefined();
    expect(nodeName(node())).toBeUndefined();
  });

  /** 默认值是「类型 + 序号」，序号是本画布内最小的空位（设计 §2.2）。 */
  it("建议本画布内最小的那个空位，并按 agent 而不是节点类型取词", () => {
    const board = [agent("a", "codex", "codex-1"), agent("b", "codex")];
    expect(suggestName(board, board[1]!)).toBe("codex-2");
    // 自己那一个不算占用：重新起名时建议的仍是它现在这个位置。
    expect(suggestName(board, board[0]!)).toBe("codex-1");
    // 中间的空位优先于接在最后。
    const gapped = [
      agent("a", "codex", "codex-1"),
      agent("b", "codex", "codex-3"),
      agent("c", "codex"),
    ];
    expect(suggestName(gapped, gapped[2]!)).toBe("codex-2");
    // 自定义 Agent 的 `custom:` 前缀不是名字的字符，取后半截。
    expect(suggestName([], agent("d", "custom:my-wrapper"))).toBe(
      "my-wrapper-1",
    );
    // 不是 Agent 的节点按类型取词。
    expect(suggestName([], node({ id: "e", type: "sticky" }))).toBe("sticky-1");
  });

  it("答得出一个名字现在属于谁，好让界面说清楚而不是静默改写", () => {
    const board = [agent("a", "codex", "reviewer"), agent("b", "codex")];
    expect(takenNames(board)).toEqual(new Set(["reviewer"]));
    expect(takenNames(board, "a").size).toBe(0);
    expect(holderOf(board, "reviewer")?.id).toBe("a");
    expect(holderOf(board, "reviewer", "a")).toBeUndefined();
  });
});
