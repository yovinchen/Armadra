import { describe, expect, it } from "vitest";
import type {
  Board,
  BoardDocument,
  CanvasEdge,
  CanvasNode,
} from "@armadra/shared";

import { emptyWhiteboard, type WhiteboardDoc } from "../whiteboard/model";
import { serializeWhiteboard } from "../whiteboard/serialize";
import { adoptList, mergeRemoteBoard, mergeWhiteboard } from "./merge";

/**
 * 远端合并（React Flow 计划 §6.3 A04）。
 *
 * 四条要守住的规矩：远端的改动进得来、本地没落盘的改动出不去、视口永远是
 * 本地的、没变就一个字节都不写。
 */

const STAMP = "2026-09-06T00:00:00.000Z";
const LATER = "2026-09-06T00:00:05.000Z";

const board: Board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: STAMP,
  updatedAt: STAMP,
};

let counter = 0;
const uuid = () =>
  `019ff7d1-0000-7000-8000-${String((counter += 1)).padStart(12, "0")}`;

function node(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: uuid(),
    boardId: board.id,
    type: "terminal",
    title: "term",
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    labels: [],
    note: "",
    data: { kind: "terminal" },
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  } as CanvasNode;
}

function edge(source: string, target: string): CanvasEdge {
  return {
    id: uuid(),
    boardId: board.id,
    source,
    target,
    kind: "link",
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function doc(
  nodes: CanvasNode[],
  edges: CanvasEdge[] = [],
  overrides: Partial<Board> = {},
): BoardDocument {
  return { board: { ...board, ...overrides }, nodes, edges };
}

/** 深拷贝：远端那一份永远是新解出来的 JSON，对象身份与本地不共享。 */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const clean = emptyWhiteboard;

describe("adoptList", () => {
  it("内容没变就连数组一起复用（投影缓存不失效）", () => {
    const one = node();
    const list = [one];
    expect(adoptList(list, wire(list))).toBe(list);
  });

  it("只有一条变了时，没变的那条仍是原来那个对象", () => {
    const one = node();
    const two = node();
    const next = wire([one, two]);
    next[1]!.position = { x: 40, y: 40 };
    const merged = adoptList([one, two], next);
    expect(merged).not.toBe(undefined);
    expect(merged[0]).toBe(one);
    expect(merged[1]).not.toBe(two);
    expect(merged[1]!.position).toEqual({ x: 40, y: 40 });
  });

  it("远端新增与删除都照单收下", () => {
    const one = node();
    const two = node();
    expect(adoptList([one], wire([one, two]))).toHaveLength(2);
    expect(adoptList([one, two], wire([two]))).toEqual([two]);
  });
});

describe("mergeRemoteBoard", () => {
  it("本地干净时远端为准：别的窗口挪的节点进得来", () => {
    counter = 0;
    const one = node();
    const local = doc([one]);
    const remote = wire(
      doc([{ ...one, position: { x: 515, y: 565 } }], [], {
        updatedAt: LATER,
      }),
    );
    const merged = mergeRemoteBoard({
      local,
      localWhiteboard: clean(),
      remote,
      dirty: false,
    });
    expect(merged.changed).toBe(true);
    expect(merged.document.nodes[0]!.position).toEqual({ x: 515, y: 565 });
    expect(merged.document.board.updatedAt).toBe(LATER);
  });

  it("视口永远是本地的：别的窗口平移不会拽走这个窗口的相机", () => {
    const one = node();
    const local = doc([one], [], { viewport: { x: -300, y: 20, zoom: 0.8 } });
    const remote = wire(
      doc([one], [], { viewport: { x: 0, y: 0, zoom: 2 }, updatedAt: LATER }),
    );
    const merged = mergeRemoteBoard({
      local,
      localWhiteboard: clean(),
      remote,
      dirty: false,
    });
    expect(merged.document.board.viewport).toEqual({
      x: -300,
      y: 20,
      zoom: 0.8,
    });
  });

  it("完全一样的一份回来时 `changed` 是 false，一次 set 都不做", () => {
    const one = node();
    const local = doc([one]);
    const merged = mergeRemoteBoard({
      local,
      localWhiteboard: clean(),
      remote: wire(local),
      dirty: false,
    });
    expect(merged.changed).toBe(false);
    expect(merged.document).toBe(local);
  });

  it("本地脏时不被盖掉：本地改的位置留着，远端新增的节点也留着", () => {
    const one = node();
    const mine = { ...one, position: { x: 9, y: 9 }, updatedAt: LATER };
    const theirs = node({ createdAt: LATER, updatedAt: LATER });
    const local = doc([mine]);
    const remote = wire(
      doc([{ ...one, position: { x: 100, y: 100 } }, theirs], [], {
        updatedAt: LATER,
      }),
    );
    const merged = mergeRemoteBoard({
      local,
      localWhiteboard: clean(),
      remote,
      dirty: true,
    });
    const ids = merged.document.nodes.map((row) => row.id);
    expect(ids).toContain(theirs.id);
    expect(
      merged.document.nodes.find((row) => row.id === one.id)!.position,
    ).toEqual({ x: 9, y: 9 });
    // CAS 戳采纳远端的，否则下一次 PUT 一定再撞一次 409。
    expect(merged.document.board.updatedAt).toBe(LATER);
  });

  it("脏，但这一条本地没动过：照收远端的（两边各改各的不互相吃）", () => {
    const one = node();
    const two = node();
    const local = doc([
      one,
      { ...two, position: { x: 22, y: 22 }, updatedAt: LATER },
    ]);
    const remote = wire(
      doc([{ ...one, position: { x: 11, y: 11 } }, two], [], {
        updatedAt: LATER,
      }),
    );
    const merged = mergeRemoteBoard({
      local,
      localWhiteboard: clean(),
      remote,
      dirty: true,
      // 这个窗口只动过 `two`。
      localEdits: new Set([two.id]),
    });
    const at = (id: string) =>
      merged.document.nodes.find((row) => row.id === id)!.position;
    expect(at(one.id)).toEqual({ x: 11, y: 11 });
    expect(at(two.id)).toEqual({ x: 22, y: 22 });
  });

  it("远端删掉的连线不复活（两端都没了的边一起走）", () => {
    const one = node();
    const two = node();
    const link = edge(one.id, two.id);
    const local = doc([one, two], [link]);
    const remote = wire(doc([one], [], { updatedAt: LATER }));
    const merged = mergeRemoteBoard({
      local,
      localWhiteboard: clean(),
      remote,
      dirty: false,
    });
    expect(merged.document.nodes).toHaveLength(1);
    expect(merged.document.edges).toEqual([]);
  });

  it("板不对时原样退回本地那份（切板途中回来的响应）", () => {
    const local = doc([node()]);
    const remote = wire(doc([], [], { id: "another-board" }));
    const merged = mergeRemoteBoard({
      local,
      localWhiteboard: clean(),
      remote,
      dirty: false,
    });
    expect(merged.changed).toBe(false);
    expect(merged.document).toBe(local);
  });
});

describe("mergeWhiteboard", () => {
  const item = {
    id: "aa000000-0000-4000-8000-000000000001",
    kind: "text" as const,
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    z: 1,
    style: { color: "black" as const, size: "m" as const },
    text: "hello",
  };
  const withItem: WhiteboardDoc = { ...emptyWhiteboard(), items: [item] };

  it("同一份快照解回来时返回本地那份（对象身份留住）", () => {
    expect(mergeWhiteboard(withItem, serializeWhiteboard(withItem))).toBe(
      withItem,
    );
  });

  it("远端新增的白板对象进得来，没变的那条还是原来那个对象", () => {
    const second = { ...item, id: "aa000000-0000-4000-8000-000000000002" };
    const remote: WhiteboardDoc = {
      ...emptyWhiteboard(),
      items: [item, second],
    };
    const merged = mergeWhiteboard(withItem, serializeWhiteboard(remote));
    expect(merged.items).toHaveLength(2);
    expect(merged.items[0]).toBe(item);
  });

  it("本地脏时白板整块以本地为准（与 409 变基同一条局限）", () => {
    const remote = wire(doc([], [], { whiteboard: "" }));
    const merged = mergeRemoteBoard({
      local: doc([]),
      localWhiteboard: withItem,
      remote,
      dirty: true,
    });
    expect(merged.whiteboard).toBe(withItem);
  });

  it("认不出的快照按空白板处理", () => {
    expect(mergeWhiteboard(withItem, '{"engine":"nope"}').items).toEqual([]);
  });
});
