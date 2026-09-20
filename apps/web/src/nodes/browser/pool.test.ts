import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardDocument, CanvasNode } from "@armadra/shared";

import { usePreferencesStore } from "@/app/preferences-store";
import type { ArmadraFlowNode, CanvasFlowNode } from "@/canvas/sync/project";
import { useCanvasStore } from "@/store/canvas-store";

import {
  BACKGROUND_WEBVIEW_MAX,
  applyWebviewPool,
  resetWebviewPool,
  webviewPoolOrder,
} from "./pool";

/**
 * pool region 的不变量（W3.2）。
 *
 * 探针实测的判据：让
 * React 对一个已挂载的 `<webview>` 宿主元素做 `insertBefore` 移动，guest 当场
 * 被杀。插入与删除实测安全，**只有移动不是**——所以这里断言的不是「数组没
 * 变」，而是「webview 节点之间的相对顺序是上一帧的延续」。
 */

beforeEach(() => {
  (window as unknown as Record<string, unknown>).armadra = {};
  usePreferencesStore.setState({
    browser: { discard: true, discardMinutes: 5, backgroundMax: 8 },
  });
  resetWebviewPool();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).armadra;
  resetWebviewPool();
});

function node(
  id: string,
  type: CanvasNode["type"],
  extra: Partial<ArmadraFlowNode> = {},
): CanvasFlowNode {
  return {
    id,
    type: "armadra",
    position: { x: 0, y: 0 },
    data: { id, type, title: id } as unknown as CanvasNode,
    ...extra,
  } as ArmadraFlowNode;
}

const browser = (id: string, extra?: Partial<ArmadraFlowNode>) =>
  node(id, "browser", extra);
const terminal = (id: string) => node(id, "terminal");

/** 上一帧的顺序是这一帧的子序列 = 没有任何一个存活条目被移动过。 */
function isSubsequence(before: string[], after: string[]): boolean {
  let cursor = 0;
  for (const id of after) {
    if (id === before[cursor]) cursor += 1;
  }
  return cursor === before.length;
}

function ids(nodes: CanvasFlowNode[]): string[] {
  return nodes.map((each) => each.id);
}

function webviewIds(nodes: CanvasFlowNode[]): string[] {
  return nodes
    .filter(
      (each) =>
        each.type === "armadra" && (each.data as CanvasNode).type === "browser",
    )
    .map((each) => each.id);
}

describe("applyWebviewPool", () => {
  it("非 Electron 壳原样返回——那里根本没有 guest", () => {
    delete (window as unknown as Record<string, unknown>).armadra;
    const input = [terminal("t1"), browser("b1"), terminal("t2")];
    expect(applyWebviewPool(input)).toBe(input);
  });

  it("浏览器节点一律摆在数组尾部，其余节点保持原序", () => {
    const out = applyWebviewPool([
      browser("b1"),
      terminal("t1"),
      browser("b2"),
      terminal("t2"),
    ]);
    expect(ids(out)).toEqual(["t1", "t2", "b1", "b2"]);
  });

  it("上游把两个 webview 节点对调时，pool 里的顺序纹丝不动", () => {
    const first = applyWebviewPool([browser("b1"), browser("b2")]);
    expect(webviewIds(first)).toEqual(["b1", "b2"]);

    // 这正是探针里唯一杀掉 guest 的那一次更新。投影侧对调之后，pool 必须把
    // 它吸收掉——否则 React 会对 b1 调 `insertBefore`，页面整个重载。
    const second = applyWebviewPool([browser("b2"), browser("b1")]);
    expect(webviewIds(second)).toEqual(["b1", "b2"]);
    expect(isSubsequence(webviewIds(first), webviewIds(second))).toBe(true);
  });

  it("插入、删除、换父、乱序，顺序始终是上一帧的延续", () => {
    const frames: CanvasFlowNode[][] = [
      [browser("b1"), browser("b2"), terminal("t1")],
      // 在最前面插入一个新节点（探针实测安全，但顺序仍要可证）。
      [terminal("t0"), browser("b1"), browser("b2")],
      // 新的浏览器节点：只能追加在尾部。
      [browser("b3"), browser("b2"), browser("b1")],
      // 删掉中间一个兄弟。
      [browser("b3"), browser("b1")],
      // 全部乱序。
      [browser("b1"), browser("b3")],
    ];
    let previous: string[] = [];
    for (const frame of frames) {
      const order = webviewIds(applyWebviewPool(frame));
      expect(isSubsequence(previous, order)).toBe(true);
      previous = order;
    }
    // b2 在第四帧退休，但它**留在 pool 里**（ghost），所以顺序里还有它。
    expect(webviewPoolOrder()).toEqual(["b1", "b2", "b3"]);
  });

  it("从投影里消失的节点变成 ghost：还在数组里，但 display:none、无父、不可交互", () => {
    applyWebviewPool([browser("b1", { parentId: "g1" })]);
    const out = applyWebviewPool([terminal("t1")]);
    const ghost = out.find((each) => each.id === "b1") as ArmadraFlowNode;

    expect(ghost).toBeDefined();
    expect(ghost.style?.display).toBe("none");
    // 分组可能属于另一个工作空间；留着 parentId 会让 React Flow 算不出子流坐标。
    expect(ghost.parentId).toBeUndefined();
    expect(ghost.position).toEqual({ x: 0, y: 0 });
    expect(ghost.selected).toBe(false);
    expect(ghost.draggable).toBe(false);
    expect(ghost.selectable).toBe(false);
    expect(ghost.connectable).toBe(false);
  });

  it("切回来时 ghost 复活成活条目，且没有换过位置", () => {
    applyWebviewPool([browser("b1"), browser("b2")]);
    applyWebviewPool([]);
    const back = applyWebviewPool([browser("b2"), browser("b1")]);
    const revived = back.filter((each) => each.id === "b1")[0]!;

    expect(webviewIds(back)).toEqual(["b1", "b2"]);
    expect((revived as ArmadraFlowNode).style?.display).toBeUndefined();
  });

  it(`ghost 超过 ${BACKGROUND_WEBVIEW_MAX} 个时逐出最久退休的那个`, () => {
    const all = Array.from({ length: BACKGROUND_WEBVIEW_MAX + 2 }, (_, i) =>
      browser(`b${i}`),
    );
    applyWebviewPool(all, 1_000);
    expect(webviewPoolOrder()).toHaveLength(BACKGROUND_WEBVIEW_MAX + 2);

    // b0 最先退休，b1 第二个，其余仍然活着。
    applyWebviewPool(all.slice(1), 2_000);
    applyWebviewPool(all.slice(2), 3_000);
    expect(webviewPoolOrder()).toContain("b0");

    // 再把剩下的全部退休：ghost 数量超过上限，最久的 b0 先走。
    applyWebviewPool([], 4_000);
    const order = webviewPoolOrder();
    expect(order).toHaveLength(BACKGROUND_WEBVIEW_MAX);
    expect(order).not.toContain("b0");
    expect(order).not.toContain("b1");
    // 活着的永远不被逐出，逐出只发生在 ghost 上。
    expect(order[0]).toBe("b2");
  });

  it("上限跟着设置走，调小之后下一帧就把多出来的逐掉", () => {
    usePreferencesStore.getState().setBrowserPreference("backgroundMax", 3);
    const all = Array.from({ length: 6 }, (_, i) => browser(`b${i}`));
    applyWebviewPool(all, 1_000);
    applyWebviewPool([], 2_000);
    expect(webviewPoolOrder()).toHaveLength(3);

    usePreferencesStore.getState().setBrowserPreference("backgroundMax", 2);
    applyWebviewPool([], 3_000);
    expect(webviewPoolOrder()).toHaveLength(2);
  });

  it("没有浏览器节点时什么都不做", () => {
    const input = [terminal("t1")];
    expect(applyWebviewPool(input)).toBe(input);
  });
});

/**
 * 删除与「只是没投影出来」是两件事。
 *
 * 前者必须立刻把条目摘出 pool——留着就是一个看不见、关不掉、还在跑的
 * Chromium 渲染进程，而它本来要等到攒够 `backgroundMax` 个 ghost 才被逐出。
 * 后者（切板、切工作空间、折叠分组）必须照旧变 ghost，guest 毫发无损。
 */
describe("applyWebviewPool 的删除判定", () => {
  function openBoard(boardId: string, nodeIds: string[]): void {
    useCanvasStore.setState({
      boardId,
      document: {
        board: { id: boardId } as BoardDocument["board"],
        nodes: nodeIds.map((id) => ({ id }) as BoardDocument["nodes"][number]),
        edges: [],
      },
    });
  }

  afterEach(() => {
    useCanvasStore.setState({ boardId: null, document: null });
  });

  it("同一块画布上节点从文档里消失了：条目立刻离开 pool，guest 跟着走", () => {
    openBoard("board-1", ["b1", "b2"]);
    applyWebviewPool([browser("b1"), browser("b2")], 1_000);
    expect(webviewPoolOrder()).toEqual(["b1", "b2"]);

    openBoard("board-1", ["b1"]);
    const out = applyWebviewPool([browser("b1")], 2_000);
    expect(webviewPoolOrder()).toEqual(["b1"]);
    expect(webviewIds(out)).toEqual(["b1"]);
  });

  it("最后一个浏览器节点被删掉时 pool 也要空掉", () => {
    openBoard("board-1", ["b1"]);
    applyWebviewPool([browser("b1")], 1_000);
    openBoard("board-1", []);
    expect(webviewIds(applyWebviewPool([], 2_000))).toEqual([]);
    expect(webviewPoolOrder()).toEqual([]);
  });

  it("换一块画布时节点不在新文档里，照旧变 ghost 而不是被删", () => {
    openBoard("board-1", ["b1"]);
    applyWebviewPool([browser("b1")], 1_000);

    openBoard("board-2", ["x1"]);
    applyWebviewPool([], 2_000);
    expect(webviewPoolOrder()).toEqual(["b1"]);

    // 切回去还是同一个条目，guest 从未被卸载。
    openBoard("board-1", ["b1"]);
    expect(webviewIds(applyWebviewPool([browser("b1")], 3_000))).toEqual([
      "b1",
    ]);
  });

  it("节点还在文档里、只是这一帧没投影出来（折叠分组）时变 ghost", () => {
    openBoard("board-1", ["b1"]);
    applyWebviewPool([browser("b1")], 1_000);
    applyWebviewPool([], 2_000);
    expect(webviewPoolOrder()).toEqual(["b1"]);
  });

  it("文档还没加载时一律按 ghost 处理，不拿空文档去删条目", () => {
    useCanvasStore.setState({ boardId: "board-1", document: null });
    applyWebviewPool([browser("b1")], 1_000);
    applyWebviewPool([], 2_000);
    expect(webviewPoolOrder()).toEqual(["b1"]);
  });
});
