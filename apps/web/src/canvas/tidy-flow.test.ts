import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardDocument, CanvasNode, Position } from "@armadra/shared";

import { useCanvasStore } from "@/store/canvas-store";
import { canUndo, resetHistory, undo } from "@/store/canvas/history";
import { resetCanvasLock, setCanvasLocked } from "./canvas-lock";
import { makeEdge, makeItem, makeNode } from "./test-support";
import {
  emptyWhiteboard,
  toItemId,
  type Item,
  type Reference,
} from "./whiteboard/model";
import { arrangeCanvas } from "./tidy-flow";

/**
 * 整理排布的画布侧（React Flow 计划 T06 / F09）。
 *
 * 重写自旧引擎的 `tidy-editor.test.ts`（7 项）：那一版从编辑器里捞 shape，
 * 还要处理旋转、隐藏、对象锁与「绕开固定对象」。现在输入只有
 * `document.nodes` 与 `whiteboard.items` 两张表，剩下的断言是：谁参与、
 * 谁跟着容器走、链接怎么上溯、以及整块只留一条历史。
 *
 * 算法本身（连通分量 + 视口宽高比裹行）在 `tidy.test.ts`。
 */

const STAMP = "2026-09-06T00:00:00.000Z";

function board(
  nodes: CanvasNode[],
  edges = [] as ReturnType<typeof makeEdge>[],
) {
  return {
    board: {
      id: "019ff7d1-0d12-7421-833d-2c5e8d64ed00",
      workspaceId: "w1",
      name: "board",
      sortOrder: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: "",
      createdAt: STAMP,
      updatedAt: STAMP,
    },
    nodes,
    edges,
  } as unknown as BoardDocument;
}

function load(
  nodes: CanvasNode[],
  options: {
    edges?: ReturnType<typeof makeEdge>[];
    items?: Item[];
    references?: Reference[];
  } = {},
): void {
  useCanvasStore.setState({
    document: board(nodes, options.edges ?? []),
    whiteboard: {
      ...emptyWhiteboard(),
      items: options.items ?? [],
      references: options.references ?? [],
    },
  });
}

function positionOf(id: string): Position {
  const node = useCanvasStore
    .getState()
    .document?.nodes.find((entry) => entry.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node.position;
}

function itemPositionOf(id: string): Position {
  const item = useCanvasStore
    .getState()
    .whiteboard.items.find((entry) => entry.id === id);
  if (!item) throw new Error(`no item ${id}`);
  return { x: item.x, y: item.y };
}

beforeEach(() => {
  resetHistory();
  resetCanvasLock();
});

afterEach(() => {
  resetCanvasLock();
  resetHistory();
  useCanvasStore.setState({ document: null, whiteboard: emptyWhiteboard() });
});

describe("参与排布的对象", () => {
  it("空画布什么都不做", () => {
    load([]);
    expect(arrangeCanvas()).toEqual({});
  });

  it("顶层节点与顶层白板对象排在同一张表里", () => {
    const one = makeNode("sticky", { position: { x: 900, y: 40 } });
    const two = makeNode("sticky", { position: { x: 40, y: 900 } });
    const item = makeItem("shape", { x: 1500, y: 1500 });
    load([one, two], { items: [item] });

    const applied = arrangeCanvas({ aspect: 1 });
    expect(Object.keys(applied).sort()).toEqual(
      [one.id, two.id, toItemId(item.id)].sort(),
    );
    // 原来散在三个角上；排完之后包围盒收得比 1500 小得多。
    const xs = Object.values(applied).map((point) => point.x);
    const ys = Object.values(applied).map((point) => point.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1000);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1000);
  });

  it("Frame 整体移动一次，组员与组内白板对象都不单独参与", () => {
    const frame = makeNode("group", {
      position: { x: 800, y: 800 },
      size: { width: 400, height: 300 },
    });
    const member = makeNode("terminal", {
      parentId: frame.id,
      position: { x: 20, y: 30 },
    });
    const inside = makeItem("text", { parentId: frame.id, x: 10, y: 10 });
    const loose = makeNode("sticky", { position: { x: 0, y: 0 } });
    load([frame, member, loose], { items: [inside] });

    const applied = arrangeCanvas({ aspect: 1 });
    expect(Object.keys(applied).sort()).toEqual([frame.id, loose.id].sort());
    // 组员的相对坐标一点没动，Frame 内部的布局跟着整块搬走。
    expect(positionOf(member.id)).toEqual({ x: 20, y: 30 });
    expect(itemPositionOf(inside.id)).toEqual({ x: 10, y: 10 });
  });

  it("整块保持内容包围盒的左上角不动", () => {
    const one = makeNode("sticky", { position: { x: 400, y: 250 } });
    const two = makeNode("sticky", { position: { x: 900, y: 700 } });
    load([one, two]);

    const applied = arrangeCanvas({ aspect: 16 / 9 });
    const xs = Object.values(applied).map((point) => point.x);
    const ys = Object.values(applied).map((point) => point.y);
    expect(Math.min(...xs)).toBe(400);
    expect(Math.min(...ys)).toBe(250);
  });
});

describe("链接", () => {
  it("连线让两个节点排到一起，组员之间的连线上溯到各自的 Frame", () => {
    const frame = makeNode("group", {
      position: { x: 0, y: 0 },
      size: { width: 300, height: 200 },
    });
    const member = makeNode("terminal", {
      parentId: frame.id,
      position: { x: 10, y: 10 },
    });
    const far = makeNode("terminal", { position: { x: 4000, y: 4000 } });
    load([frame, member, far], { edges: [makeEdge(member.id, far.id)] });

    const applied = arrangeCanvas({ aspect: 1 });
    // 同一组（连通分量）里的两个矩形挨着排，不会一个在原点一个在 4000。
    const gap = Math.hypot(
      applied[frame.id]!.x - applied[far.id]!.x,
      applied[frame.id]!.y - applied[far.id]!.y,
    );
    expect(gap).toBeLessThan(1000);
  });

  it("内容引用也算链接：被引用的对象排在那个 Agent 旁边", () => {
    const agent = makeNode("terminal", { position: { x: 0, y: 0 } });
    const far = makeNode("terminal", { position: { x: 5000, y: 0 } });
    const item = makeItem("text", { x: 5000, y: 5000 });
    load([agent, far], {
      items: [item],
      references: [{ id: "r1", itemId: item.id, nodeId: agent.id }],
    });

    const applied = arrangeCanvas({ aspect: 1 });
    const near = Math.hypot(
      applied[agent.id]!.x - applied[toItemId(item.id)]!.x,
      applied[agent.id]!.y - applied[toItemId(item.id)]!.y,
    );
    const away = Math.hypot(
      applied[far.id]!.x - applied[toItemId(item.id)]!.x,
      applied[far.id]!.y - applied[toItemId(item.id)]!.y,
    );
    expect(near).toBeLessThan(away);
  });
});

describe("提交", () => {
  it("节点与白板对象一起动，但只留一条历史", () => {
    const one = makeNode("sticky", { position: { x: 900, y: 40 } });
    const two = makeNode("sticky", { position: { x: 40, y: 900 } });
    const item = makeItem("shape", { x: 1500, y: 1500 });
    load([one, two], { items: [item] });
    const before = {
      one: positionOf(one.id),
      item: itemPositionOf(item.id),
    };

    arrangeCanvas({ aspect: 1 });
    expect(itemPositionOf(item.id)).not.toEqual(before.item);
    expect(useCanvasStore.getState().saveState).toBe("dirty");

    // 一条历史：一次 ⌘Z 把节点与白板对象一起还原。
    expect(canUndo()).toBe(true);
    undo();
    expect(canUndo()).toBe(false);
    expect(positionOf(one.id)).toEqual(before.one);
    expect(itemPositionOf(item.id)).toEqual(before.item);
  });

  it("已经整齐时不提交，也不记历史", () => {
    const only = makeNode("sticky", { position: { x: 100, y: 100 } });
    load([only]);
    const applied = arrangeCanvas({ aspect: 1 });
    expect(applied[only.id]).toEqual({ x: 100, y: 100 });
    expect(canUndo()).toBe(false);
  });

  it("锁定视图时什么都不动", () => {
    const one = makeNode("sticky", { position: { x: 900, y: 40 } });
    const two = makeNode("sticky", { position: { x: 40, y: 900 } });
    load([one, two]);
    setCanvasLocked(true);

    expect(arrangeCanvas({ aspect: 1 })).toEqual({});
    expect(positionOf(one.id)).toEqual({ x: 900, y: 40 });
    expect(canUndo()).toBe(false);
  });
});
