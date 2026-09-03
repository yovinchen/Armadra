import { describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@ai-coding-canvas/shared";

import { canSuggestTitle, openNodeAnnotation } from "./annotations";
// 副作用：注册终端的右键项（含「标签…」）。
import "../nodes/terminal-menu";
import { nodeMenuExtras } from "../canvas/menus/node-menu";

function node(patch: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: "019ff7d1-0d12-7421-833d-2c5e8d64ed40",
    boardId: "019ff7d1-0d12-7421-833d-2c5e8d64ed30",
    type: "terminal",
    title: "终端",
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    labels: [],
    note: "",
    data: { kind: "terminal" },
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...patch,
  } as CanvasNode;
}

describe("节点标注入口", () => {
  it("终端右键菜单里有「标签…」，点它只发事件、不动节点", () => {
    const target = node();
    const items = nodeMenuExtras({ node: target, targetIds: [target.id] });
    const labels = items.find((item) => item.id === "node.labels");
    expect(labels).toBeDefined();
    expect(labels!.label).toBe("标签…");

    const seen = vi.fn();
    window.addEventListener("aicc:node-annotation", seen);
    labels!.run();
    window.removeEventListener("aicc:node-annotation", seen);
    expect(seen).toHaveBeenCalled();
  });

  it("便签没有这一项（它的标签画在正文里）", () => {
    const sticky = node({
      type: "sticky",
      data: { kind: "sticky", content: "" },
    } as Partial<CanvasNode>);
    const items = nodeMenuExtras({ node: sticky, targetIds: [sticky.id] });
    expect(items.some((item) => item.id === "node.labels")).toBe(false);
  });

  it("只有带 agent 的终端能 AI 命名", () => {
    expect(canSuggestTitle(node())).toBe(false);
    expect(
      canSuggestTitle(
        node({
          data: { kind: "terminal", agent: { id: "claude" } },
        } as Partial<CanvasNode>),
      ),
    ).toBe(true);
    expect(
      canSuggestTitle(
        node({
          type: "sticky",
          data: { kind: "sticky", content: "" },
        } as Partial<CanvasNode>),
      ),
    ).toBe(false);
  });

  it("事件带上节点 id 与类型", () => {
    const detail = vi.fn();
    const listener = (event: Event) => detail((event as CustomEvent).detail);
    window.addEventListener("aicc:node-annotation", listener);
    openNodeAnnotation("n1", "note");
    window.removeEventListener("aicc:node-annotation", listener);
    expect(detail).toHaveBeenCalledWith({ nodeId: "n1", kind: "note" });
  });
});
