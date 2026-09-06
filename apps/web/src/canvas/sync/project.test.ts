import { beforeEach, describe, expect, it } from "vitest";
import type { BoardDocument, CanvasEdge, CanvasNode } from "@armadra/shared";

import type { DraftMap } from "../flow/drafts";
import { emptyWhiteboard, type WhiteboardDoc } from "../whiteboard/model";
import {
  EMPTY_SELECTION,
  edgeArrowheads,
  edgeLabelKey,
  isDocumentNodeId,
  isItemId,
  fromItemId,
  projectEdges,
  projectNodes,
  resetProjectionCache,
  toItemId,
} from "./project";

/**
 * 文档 → React Flow 的投影（React Flow 计划 T01）。
 *
 * 三件事：身份缓存真的复用了对象、草稿盖得住文档、组员的相对坐标原样传给
 * React Flow 的子流。
 */

const STAMP = "2026-09-06T00:00:00.000Z";
const NODE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const GROUP = "33333333-3333-4333-8333-333333333333";
const EDGE = "44444444-4444-4444-8444-444444444444";

function node(id: string, patch: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    boardId: "board",
    type: "sticky",
    title: "note",
    color: "#ffd60a",
    position: { x: 10, y: 20 },
    size: { width: 240, height: 200 },
    labels: [],
    note: "",
    data: { kind: "sticky", content: "" },
    createdAt: STAMP,
    updatedAt: STAMP,
    ...patch,
  } as CanvasNode;
}

function edge(source: string, target: string): CanvasEdge {
  return {
    id: EDGE,
    boardId: "board",
    source,
    target,
    kind: "link",
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function board(nodes: CanvasNode[], edges: CanvasEdge[] = []): BoardDocument {
  return { board: {} as BoardDocument["board"], nodes, edges };
}

const NO_DRAFTS: DraftMap = new Map();
const EMPTY: WhiteboardDoc = emptyWhiteboard();

beforeEach(resetProjectionCache);

describe("projectNodes", () => {
  it("没变的节点返回同一个对象：一次相机移动不该让终端全部重渲", () => {
    const document = board([node(NODE)]);
    const first = projectNodes(document, EMPTY, NO_DRAFTS)[0];
    const second = projectNodes(document, EMPTY, NO_DRAFTS)[0];
    expect(second).toBe(first);
  });

  it("节点对象换了就重建", () => {
    const first = projectNodes(board([node(NODE)]), EMPTY, NO_DRAFTS)[0];
    const moved = node(NODE, { position: { x: 99, y: 99 } });
    const second = projectNodes(board([moved]), EMPTY, NO_DRAFTS)[0];
    expect(second).not.toBe(first);
    expect(second!.position).toEqual({ x: 99, y: 99 });
  });

  it("草稿盖住文档里的位置与尺寸，手势结束前一个字都不写文档", () => {
    const document = board([node(NODE)]);
    const drafts: DraftMap = new Map([
      [NODE, { position: { x: 300, y: 400 }, size: { width: 50, height: 60 } }],
    ]);
    const projected = projectNodes(document, EMPTY, drafts)[0]!;
    expect(projected.position).toEqual({ x: 300, y: 400 });
    expect(projected.width).toBe(50);
    expect(projected.height).toBe(60);
    // 文档一个字都没动。
    expect(document.nodes[0]!.position).toEqual({ x: 10, y: 20 });
  });

  it("折叠时高度钉死在 40px，宽度仍然听文档的", () => {
    const projected = projectNodes(
      board([node(NODE, { collapsed: true })]),
      EMPTY,
      NO_DRAFTS,
    )[0]!;
    expect(projected.height).toBe(40);
    expect(projected.width).toBe(240);
  });

  /**
   * 回归（B1 真实浏览器里抓到的）：`measured` 一旦缺席，React Flow 在
   * `adoptUserNodes` 重建节点时就会把上一份 `handleBounds` 丢掉
   * （`parseHandles` 只在 `userNode.measured` 存在时才带过去）。DOM 尺寸没变、
   * `ResizeObserver` 不再响，于是**换一次父就所有连线永久消失**。
   */
  it("`measured` 与 `width/height` 同值：React Flow 靠它保住把手尺寸", () => {
    const projected = projectNodes(
      board([node(NODE, { collapsed: true })]),
      EMPTY,
      NO_DRAFTS,
    )[0]!;
    expect(projected.measured).toEqual({ width: 240, height: 40 });

    const whiteboard: WhiteboardDoc = {
      ...emptyWhiteboard(),
      items: [
        {
          id: "abc",
          kind: "shape",
          x: 0,
          y: 0,
          w: 160,
          h: 120,
          z: 0,
          style: { color: "black", size: "m" },
          geo: "rectangle",
        },
      ],
    };
    const item = projectNodes(board([]), whiteboard, NO_DRAFTS)[0]!;
    expect(item.measured).toEqual({ width: 160, height: 120 });
  });

  it("组员带 `parentId`，坐标保持相对；分组排在组员前面", () => {
    const group = node(GROUP, { type: "group", data: { kind: "group" } });
    const child = node(NODE, {
      parentId: GROUP,
      position: { x: 12, y: 34 },
    });
    const projected = projectNodes(board([child, group]), EMPTY, NO_DRAFTS);
    // React Flow 要求父节点排在子节点前面，否则子流的坐标算不出来。
    expect(projected.map((item) => item.id)).toEqual([GROUP, NODE]);
    expect(projected[1]!.parentId).toBe(GROUP);
    expect(projected[1]!.position).toEqual({ x: 12, y: 34 });
  });

  it("分组走 `group` 类型、整块可拖；其余走 `armadra`、只从头部拖", () => {
    const projected = projectNodes(
      board([
        node(GROUP, { type: "group", data: { kind: "group" } }),
        node(NODE),
      ]),
      EMPTY,
      NO_DRAFTS,
    );
    expect(projected[0]!.type).toBe("group");
    expect(projected[0]!.dragHandle).toBeUndefined();
    expect(projected[1]!.type).toBe("armadra");
    expect(projected[1]!.dragHandle).toBe(".drag-handle");
  });

  it("选中态来自 store，不来自 React Flow", () => {
    const selection = { ...EMPTY_SELECTION, nodes: new Set([NODE]) };
    const projected = projectNodes(
      board([node(NODE), node(OTHER)]),
      EMPTY,
      NO_DRAFTS,
      selection,
    );
    expect(projected[0]!.selected).toBe(true);
    expect(projected[1]!.selected).toBe(false);
  });

  it("白板对象投成 `wb.<kind>` 节点，id 带 `wb:` 前缀", () => {
    const whiteboard: WhiteboardDoc = {
      ...emptyWhiteboard(),
      items: [
        {
          id: "abc",
          kind: "text",
          x: 5,
          y: 6,
          w: 100,
          h: 40,
          z: 3,
          style: { color: "black", size: "m" },
          text: "hi",
        },
      ],
    };
    const projected = projectNodes(board([]), whiteboard, NO_DRAFTS);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.id).toBe("wb:abc");
    expect(projected[0]!.type).toBe("wb.text");
    expect(projected[0]!.zIndex).toBe(3);
  });

  it("空文档投出空数组", () => {
    expect(projectNodes(null, EMPTY, NO_DRAFTS)).toEqual([]);
  });
});

describe("projectEdges", () => {
  it("一条 `edges` 行投成一条 `link` 边", () => {
    const edges = projectEdges(
      board([node(NODE), node(OTHER)], [edge(NODE, OTHER)]),
      EMPTY,
    );
    expect(edges).toEqual([
      { id: EDGE, type: "link", source: NODE, target: OTHER, selected: false },
    ]);
  });

  it("两端有一个不在画布上就投不出来（远端刚删掉那个节点）", () => {
    const edges = projectEdges(board([node(NODE)], [edge(NODE, OTHER)]), EMPTY);
    expect(edges).toEqual([]);
  });

  it("引用投成 `reference` 边，一端是白板对象", () => {
    const whiteboard: WhiteboardDoc = {
      ...emptyWhiteboard(),
      items: [
        {
          id: "abc",
          kind: "shape",
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          z: 0,
          style: { color: "black", size: "m" },
          geo: "rectangle",
        },
      ],
      references: [{ id: "ref-1", itemId: "abc", nodeId: NODE }],
    };
    const edges = projectEdges(board([node(NODE)]), whiteboard);
    expect(edges).toEqual([
      {
        id: "ref-1",
        type: "reference",
        source: "wb:abc",
        target: NODE,
        selected: false,
      },
    ]);
  });
});

describe("id 判定", () => {
  it("`wb:` 前缀区分白板对象与 `nodes` 行", () => {
    expect(isItemId("wb:abc")).toBe(true);
    expect(isItemId(NODE)).toBe(false);
    expect(isDocumentNodeId(NODE)).toBe(true);
    expect(isDocumentNodeId("wb:abc")).toBe(false);
    expect(isDocumentNodeId("not-a-uuid")).toBe(false);
  });

  it("加前缀与去前缀是一对逆运算，重复调用幂等", () => {
    expect(toItemId("abc")).toBe("wb:abc");
    expect(toItemId("wb:abc")).toBe("wb:abc");
    expect(fromItemId("wb:abc")).toBe("abc");
    expect(fromItemId("abc")).toBe("abc");
  });
});

/* ------------------------- 边的箭头与标签（原样保留） ---------------------- */

describe("edgeArrowheads", () => {
  it("箭头指向读的那一端，与用户从哪头拖出来无关", () => {
    expect(edgeArrowheads("terminal", "terminal")).toEqual({
      start: "arrow",
      end: "arrow",
    });
    expect(edgeArrowheads("sticky", "terminal")).toEqual({
      start: "none",
      end: "arrow",
    });
    expect(edgeArrowheads("terminal", "sticky")).toEqual({
      start: "arrow",
      end: "none",
    });
    expect(edgeArrowheads("sticky", "editor")).toEqual({
      start: "none",
      end: "none",
    });
  });
});

describe("edgeLabelKey", () => {
  it("按内容那一端的类型取键，两端都是终端时是「上下文」", () => {
    expect(edgeLabelKey("terminal", "terminal")).toBe("edge.context");
    expect(edgeLabelKey("sticky", "terminal")).toBe("edge.sticky");
    expect(edgeLabelKey("terminal", "editor")).toBe("edge.file");
    expect(edgeLabelKey("terminal", "files")).toBe("edge.dir");
    expect(edgeLabelKey("terminal", "browser")).toBe("edge.web");
    expect(edgeLabelKey("terminal", "diff")).toBe("edge.diff");
    expect(edgeLabelKey("terminal", "automation")).toBe("edge.context");
  });
});
