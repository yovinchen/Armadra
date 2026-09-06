import { describe, expect, it } from "vitest";
import type { BoardDocument, CanvasEdge, CanvasNode } from "@armadra/shared";

import { makeEdge, makeItem, makeNode } from "@/canvas/test-support";
import { MAX_LINKS } from "@/canvas/content-links";
import {
  emptyWhiteboard,
  toItemId,
  type Item,
  type Reference,
  type WhiteboardDoc,
} from "@/canvas/whiteboard/model";
import {
  classifyConnection,
  connectionRejection,
  isValidCanvasConnection,
} from "./connect";

/**
 * 连线判定表（React Flow 计划 T05 / §2.3）。
 *
 * 替代旧引擎的 `shapes/LinkArrow.test.ts`：那 18 项里有一大半在测「箭头
 * 工具的中间态怎么不误判」与「把手起笔的一次性标记」，两件事都被 React Flow
 * 的原生把手手势拿走了。剩下的判定本身在这里逐行覆盖。
 */

const A = "019ff7d1-0d12-7421-833d-2c5e8d64ed01";
const B = "019ff7d1-0d12-7421-833d-2c5e8d64ed02";
const C = "019ff7d1-0d12-7421-833d-2c5e8d64ed03";

function board(nodes: CanvasNode[], edges: CanvasEdge[] = []): BoardDocument {
  return {
    board: {
      id: "019ff7d1-0d12-7421-833d-2c5e8d64ed00",
      workspaceId: "w1",
      name: "board",
      sortOrder: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: "",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    },
    nodes,
    edges,
  } as unknown as BoardDocument;
}

function terminal(id: string, agent = true): CanvasNode {
  return makeNode("terminal", {
    id,
    data: {
      kind: "terminal",
      ...(agent ? { agent: { id: "claude" } } : {}),
    },
  } as Partial<CanvasNode>);
}

function whiteboard(
  items: Item[] = [],
  references: Reference[] = [],
): WhiteboardDoc {
  return { ...emptyWhiteboard(), items, references };
}

describe("§2.3 判定表", () => {
  it("节点 → 节点：连成一条 link", () => {
    const context = {
      document: board([terminal(A), terminal(B)]),
      whiteboard: whiteboard(),
    };
    expect(classifyConnection({ source: A, target: B }, context)).toEqual({
      kind: "link",
      source: A,
      target: B,
    });
    expect(isValidCanvasConnection({ source: A, target: B }, context)).toBe(
      true,
    );
  });

  it("节点 → 自己：拒绝，提示「不能连到自己」", () => {
    const context = {
      document: board([terminal(A)]),
      whiteboard: whiteboard(),
    };
    const verdict = classifyConnection({ source: A, target: A }, context);
    expect(verdict).toEqual({ kind: "reject", reason: "self" });
    expect(connectionRejection(verdict)).toBe("edge.selfLink");
    expect(isValidCanvasConnection({ source: A, target: A }, context)).toBe(
      false,
    );
  });

  it("已经连过的两个节点：无论方向都拒绝并提示", () => {
    const context = {
      document: board([terminal(A), terminal(B)], [makeEdge(A, B)]),
      whiteboard: whiteboard(),
    };
    for (const ends of [
      { source: A, target: B },
      { source: B, target: A },
    ]) {
      const verdict = classifyConnection(ends, context);
      expect(verdict).toEqual({ kind: "reject", reason: "duplicate" });
      expect(connectionRejection(verdict)).toBe("edge.duplicate");
    }
  });

  it("任一端是分组：仍然是一条合法的 link", () => {
    const group = makeNode("group", { id: C });
    const context = {
      document: board([terminal(A), group]),
      whiteboard: whiteboard(),
    };
    expect(classifyConnection({ source: A, target: C }, context).kind).toBe(
      "link",
    );
    expect(classifyConnection({ source: C, target: A }, context).kind).toBe(
      "link",
    );
  });

  it("节点 ↔ 白板对象：是内容引用，两个方向认同一对 id", () => {
    const item = makeItem("text");
    const itemId = toItemId(item.id);
    const context = {
      document: board([terminal(A)]),
      whiteboard: whiteboard([item]),
    };
    const expected = { kind: "reference", itemId, nodeId: A };
    expect(classifyConnection({ source: itemId, target: A }, context)).toEqual(
      expected,
    );
    expect(classifyConnection({ source: A, target: itemId }, context)).toEqual(
      expected,
    );
  });

  it("白板对象 → 白板对象：拒绝（那是直线 / 箭头工具的活）", () => {
    const one = makeItem("shape");
    const two = makeItem("shape");
    const verdict = classifyConnection(
      { source: toItemId(one.id), target: toItemId(two.id) },
      { document: board([]), whiteboard: whiteboard([one, two]) },
    );
    expect(verdict).toEqual({ kind: "reject", reason: "itemToItem" });
    // 拒绝但不提示：用户拿错工具，不是做错了事。
    expect(connectionRejection(verdict)).toBeNull();
  });
});

describe("引用上限", () => {
  it("节点已经有 64 个对端时拒绝，并给出上限提示", () => {
    const item = makeItem("text");
    const peers = Array.from({ length: MAX_LINKS }, (_unused, index) =>
      terminal(
        `019ff7d1-0d12-7421-833d-2c5e8d64${(index + 16).toString(16).padStart(4, "0")}`,
      ),
    );
    const document = board(
      [terminal(A), ...peers],
      peers.map((peer) => makeEdge(A, peer.id)),
    );
    const verdict = classifyConnection(
      { source: toItemId(item.id), target: A },
      { document, whiteboard: whiteboard([item]) },
    );
    expect(verdict).toEqual({ kind: "reject", reason: "referenceLimit" });
    expect(connectionRejection(verdict)).toBe("shape.referenceLimit");
  });

  it("重复引用同一个对象不算超限：那一条由 B5 去重定位", () => {
    const item = makeItem("text");
    const peers = Array.from({ length: MAX_LINKS }, (_unused, index) =>
      terminal(
        `019ff7d1-0d12-7421-833d-2c5e8d64${(index + 16).toString(16).padStart(4, "0")}`,
      ),
    );
    const document = board(
      [terminal(A), ...peers],
      peers.map((peer) => makeEdge(A, peer.id)),
    );
    const reference: Reference = { id: "r1", itemId: item.id, nodeId: A };
    const verdict = classifyConnection(
      { source: toItemId(item.id), target: A },
      { document, whiteboard: whiteboard([item], [reference]) },
    );
    expect(verdict.kind).toBe("reference");
  });
});

describe("取消与未知端", () => {
  it("拖到空白处松手是取消，不是错误", () => {
    const context = {
      document: board([terminal(A)]),
      whiteboard: whiteboard(),
    };
    const verdict = classifyConnection({ source: A, target: null }, context);
    expect(verdict).toEqual({ kind: "reject", reason: "none" });
    expect(connectionRejection(verdict)).toBeNull();
  });

  it("两端有一个不在画布上就拒绝（远端刚删掉那个节点）", () => {
    const context = {
      document: board([terminal(A)]),
      whiteboard: whiteboard(),
    };
    expect(classifyConnection({ source: A, target: B }, context)).toEqual({
      kind: "reject",
      reason: "unknown",
    });
    expect(
      classifyConnection({ source: "wb:missing", target: A }, context),
    ).toEqual({ kind: "reject", reason: "unknown" });
  });

  /**
   * 回归（B1 真实浏览器里抓到的）：React Flow 先调 `onConnect` 建边、再调
   * `onConnectEnd`。松手那一刻文档里已经有这条边了，所以「刚连上就说重复」
   * 是可以复现的——`onConnectEnd` 必须先看 `connectionState.isValid`，
   * 判定表只负责回答「为什么不行」。
   */
  it("连成之后再问一遍会得到「重复」——所以提示要按 `isValid` 闸住", () => {
    const context = {
      document: board([terminal(A), terminal(B)], [makeEdge(A, B)]),
      whiteboard: whiteboard(),
    };
    expect(classifyConnection({ source: A, target: B }, context)).toEqual({
      kind: "reject",
      reason: "duplicate",
    });
  });

  it("`isValidConnection` 在 B1 只放行 link，引用留给 B5", () => {
    const item = makeItem("text");
    const context = {
      document: board([terminal(A)]),
      whiteboard: whiteboard([item]),
    };
    expect(
      isValidCanvasConnection(
        { source: toItemId(item.id), target: A },
        context,
      ),
    ).toBe(false);
  });
});
