import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@armadra/shared";

import { usePreferencesStore } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { autoNameNode } from "./annotations";
import {
  canAutoTitle,
  forgetAutoTitle,
  isAutoTitled,
  rememberAutoTitle,
  resetAttempts,
  titleSource,
} from "./auto-title";

const suggestTitle = vi.hoisted(() => vi.fn());
vi.mock("./conversations", () => ({ suggestTitle }));

const NODE_ID = "11111111-2222-4333-8444-555555555555";

function node(title: string, agent = "claude"): CanvasNode {
  return {
    id: NODE_ID,
    type: "terminal",
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    title,
    data: { kind: "terminal", agent: { id: agent } },
  } as unknown as CanvasNode;
}

/** 只放一个节点进 store；`autoNameNode` 从这里读“当前的名字”。 */
function seed(current: CanvasNode) {
  useCanvasStore.setState({
    document: { nodes: [current], edges: [] },
  } as never);
}

beforeEach(() => {
  resetAttempts();
  forgetAutoTitle(NODE_ID);
  suggestTitle.mockReset();
  usePreferencesStore.setState({ autoTitle: true, locale: "zh-CN" });
});

describe("title source", () => {
  it("treats a default name as a placeholder in either language", () => {
    expect(titleSource(node("Claude Code"))).toBe("placeholder");
    expect(titleSource(node("终端"))).toBe("placeholder");
    expect(titleSource(node("Terminal"))).toBe("placeholder");
    expect(titleSource(node(""))).toBe("placeholder");
    // Anything else was put there by a person.
    expect(titleSource(node("重构导出流程"))).toBe("manual");
  });

  it("recognises a title it wrote itself and forgets it on request", () => {
    rememberAutoTitle(NODE_ID, "重构导出流程");
    expect(titleSource(node("重构导出流程"))).toBe("auto");
    expect(canAutoTitle(node("重构导出流程"))).toBe(true);
    expect(isAutoTitled(NODE_ID, "重构导出流程")).toBe(true);
    expect(isAutoTitled(NODE_ID, "别的名字")).toBe(false);
    forgetAutoTitle(NODE_ID);
    expect(titleSource(node("重构导出流程"))).toBe("manual");
  });

  it("survives a reload, because a lost ledger would read as a manual rename", () => {
    // 这个测试环境没有 localStorage（和 `compat.test.ts` 同一个坑）：源码里是
    // `?.` 可选调用，所以补一个最小实现来验证它确实写出去了。
    const previous = (globalThis as { localStorage?: unknown }).localStorage;
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    try {
      rememberAutoTitle(NODE_ID, "重构导出流程");
      expect(store.get("armadra.autoTitles")).toContain("重构导出流程");
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = previous;
    }
  });
});

describe("automatic naming", () => {
  const binding = { sessionId: "session-1", generation: 1 };

  it("names a placeholder once per generation and not again", async () => {
    seed(node("Claude Code"));
    suggestTitle.mockResolvedValue("重构导出流程");
    await autoNameNode(NODE_ID, binding);
    expect(useCanvasStore.getState().document?.nodes[0]?.title).toBe(
      "重构导出流程",
    );
    expect(suggestTitle).toHaveBeenCalledTimes(1);
    // Same generation: no second request, even though the ledger now says the
    // title is ours and would otherwise be replaceable.
    await autoNameNode(NODE_ID, binding);
    expect(suggestTitle).toHaveBeenCalledTimes(1);
  });

  it("never touches a node the user renamed", async () => {
    seed(node("我自己起的名字"));
    suggestTitle.mockResolvedValue("模型建议的名字");
    await autoNameNode(NODE_ID, binding);
    expect(useCanvasStore.getState().document?.nodes[0]?.title).toBe(
      "我自己起的名字",
    );
    expect(suggestTitle).not.toHaveBeenCalled();
  });

  it("discards a suggestion that arrives after a rename", async () => {
    seed(node("Claude Code"));
    // The user renames while the request is in flight.
    suggestTitle.mockImplementation(async () => {
      seed(node("我自己起的名字"));
      return "模型建议的名字";
    });
    await autoNameNode(NODE_ID, binding);
    expect(useCanvasStore.getState().document?.nodes[0]?.title).toBe(
      "我自己起的名字",
    );
  });

  it("does nothing at all when the setting is off", async () => {
    usePreferencesStore.setState({ autoTitle: false });
    seed(node("Claude Code"));
    suggestTitle.mockResolvedValue("重构导出流程");
    await autoNameNode(NODE_ID, binding);
    expect(suggestTitle).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().document?.nodes[0]?.title).toBe(
      "Claude Code",
    );
  });

  it("returns the attempt after a failure so the next turn can retry", async () => {
    seed(node("Claude Code"));
    suggestTitle.mockRejectedValueOnce(new Error("offline"));
    await autoNameNode(NODE_ID, binding);
    expect(useCanvasStore.getState().document?.nodes[0]?.title).toBe(
      "Claude Code",
    );
    suggestTitle.mockResolvedValueOnce("重构导出流程");
    await autoNameNode(NODE_ID, binding);
    expect(useCanvasStore.getState().document?.nodes[0]?.title).toBe(
      "重构导出流程",
    );
  });

  it("skips a plain terminal, which has no transcript to name from", async () => {
    const plain = {
      ...node("终端"),
      data: { kind: "terminal" },
    } as unknown as CanvasNode;
    seed(plain);
    await autoNameNode(NODE_ID, binding);
    expect(suggestTitle).not.toHaveBeenCalled();
  });
});
