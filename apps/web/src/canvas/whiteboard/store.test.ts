import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, BoardDocument, Workspace } from "@armadra/shared";

/**
 * 白板动作（React Flow 计划 §2.4）。
 *
 * 关键的不是「改了字段」，而是三条约定：改动一定落进 `canvas-store`
 * （置脏 + 进历史）、删对象连带删引用、手势合并成一条历史。
 *
 * `store/defaults.ts` 会把整棵节点渲染树拉进来，所以按 `canvas-store.test`
 * 的做法给 `nodes/registry` 一份最小替身。
 */
vi.mock("@/nodes/registry", () => {
  const meta = {
    labelKey: "node.sticky",
    icon: null,
    defaultSize: { width: 240, height: 200 },
    minSize: { width: 160, height: 120 },
    defaultColor: "#ffd60a",
    hasBridgeHandles: false,
  };
  const table: Record<string, typeof meta> = {
    terminal: meta,
    sticky: meta,
    group: meta,
    editor: meta,
    diff: meta,
    files: meta,
    browser: meta,
  };
  return {
    NODE_META: table,
    nodeMeta: (type: string) => table[type],
    DRAG_HANDLE_CLASS: "drag-handle",
    NODE_DRAG_HANDLE: ".drag-handle",
  };
});

const { useCanvasStore, resetHistory } = await import("@/store/canvas-store");
const { emptyWhiteboard } = await import("./model");
const store = await import("./store");

const timestamp = "2026-09-06T00:00:00.000Z";

const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "One",
  rootPath: "/tmp/one",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const board: Board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: workspace.id,
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: timestamp,
  updatedAt: timestamp,
};

let counter = 0;
const id = () => `item-${++counter}`;

function shape(overrides: Record<string, unknown> = {}) {
  return {
    id: id(),
    kind: "shape" as const,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    z: 0,
    parentId: null,
    style: { color: "black" as const, size: "m" as const },
    geo: "rectangle" as const,
    label: "",
    ...overrides,
  };
}

function load(): void {
  const document: BoardDocument = { board, nodes: [], edges: [] };
  useCanvasStore.getState().setWorkspace(workspace);
  useCanvasStore.getState().setDocument(document);
  resetHistory();
}

const state = () => useCanvasStore.getState();
const items = () => state().whiteboard.items;

beforeEach(() => {
  counter = 0;
  load();
});

describe("addItems", () => {
  it("落进 canvas-store 并置脏", () => {
    store.addItems([shape()]);
    expect(items()).toHaveLength(1);
    expect(state().saveState).toBe("dirty");
  });

  it("`z` 为 0 的新对象自动排到最上面", () => {
    store.addItems([shape({ z: 5 })]);
    store.addItems([shape()]);
    expect(items()[1]!.z).toBe(6);
  });

  it("空数组什么也不做", () => {
    store.addItems([]);
    expect(items()).toHaveLength(0);
    expect(state().saveState).not.toBe("dirty");
  });
});

describe("updateItems / moveItems / resizeItem", () => {
  it("id 两头都收：带 `wb:` 前缀与不带的一样能改", () => {
    store.addItems([shape({ id: "a" })]);
    store.updateItem("wb:a", { label: "hello" } as never);
    expect(items()[0]).toMatchObject({ label: "hello" });
  });

  it("`kind` 与 `id` 不接受覆盖：换类型是删加建，不是改", () => {
    store.addItems([shape({ id: "a" })]);
    store.updateItem("a", { id: "b", kind: "text" } as never);
    expect(items()[0]).toMatchObject({ id: "a", kind: "shape" });
  });

  it("没变化的一次 move 不置脏", () => {
    store.addItems([shape({ id: "a", x: 10, y: 20 })]);
    useCanvasStore.setState({ saveState: "saved" });
    store.moveItems([{ id: "a", position: { x: 10, y: 20 } }]);
    expect(state().saveState).toBe("saved");
  });

  it("resize 一条墨迹会把点集一起缩", () => {
    store.addItems([
      {
        id: "ink",
        kind: "ink",
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        z: 0,
        parentId: null,
        style: { color: "black", size: "m" },
        points: [
          [0, 0, 0.5],
          [100, 100, 0.5],
        ],
      },
    ]);
    store.resizeItem("ink", { x: 0, y: 0, w: 200, h: 50 });
    expect(items()[0]).toMatchObject({
      w: 200,
      h: 50,
      points: [
        [0, 0, 0.5],
        [200, 50, 0.5],
      ],
    });
  });

  it("resize 一条几何形不动点集（它没有点集）", () => {
    store.addItems([shape({ id: "a" })]);
    store.resizeItem("a", { x: 5, y: 6, w: 20, h: 30 });
    expect(items()[0]).toMatchObject({ x: 5, y: 6, w: 20, h: 30 });
  });
});

describe("removeItems", () => {
  it("连带删掉指向它的引用，撤销时不会复活出死链", () => {
    store.addItems([shape({ id: "a" }), shape({ id: "b" })]);
    store.addReference({ id: "r1", itemId: "a", nodeId: "n1" });
    store.addReference({ id: "r2", itemId: "b", nodeId: "n1" });
    store.removeItems(["wb:a"]);
    expect(items().map((item) => item.id)).toEqual(["b"]);
    expect(state().whiteboard.references.map((r) => r.id)).toEqual(["r2"]);
  });

  it("删掉的对象也从选区里摘掉：Delete 不会打在不存在的 id 上", () => {
    store.addItems([shape({ id: "a" })]);
    store.select(["a"]);
    expect(state().selectedItemIds).toEqual(["wb:a"]);
    store.removeItems(["a"]);
    expect(state().selectedItemIds).toEqual([]);
  });
});

describe("reorder", () => {
  it("置顶排到最上面，置底排到最下面", () => {
    store.addItems([
      shape({ id: "a" }),
      shape({ id: "b" }),
      shape({ id: "c" }),
    ]);
    const top = () => Math.max(...items().map((item) => item.z));
    const bottom = () => Math.min(...items().map((item) => item.z));
    store.reorder(["a"], "front");
    expect(items().find((item) => item.id === "a")!.z).toBe(top());
    store.reorder(["a"], "back");
    expect(items().find((item) => item.id === "a")!.z).toBe(bottom());
  });
});

describe("引用", () => {
  it("同一对同一节点只留一条", () => {
    store.addItems([shape({ id: "a" })]);
    store.addReference({ id: "r1", itemId: "a", nodeId: "n1" });
    store.addReference({ id: "r2", itemId: "wb:a", nodeId: "n1" });
    expect(state().whiteboard.references).toHaveLength(1);
  });

  it("按节点数引用（64 上限的判据）", () => {
    store.addItems([shape({ id: "a" }), shape({ id: "b" })]);
    store.addReference({ id: "r1", itemId: "a", nodeId: "n1" });
    store.addReference({ id: "r2", itemId: "b", nodeId: "n1" });
    expect(store.referenceCountForNode("n1")).toBe(2);
    expect(store.referenceCountForNode("n2")).toBe(0);
    store.removeReferences(["r1"]);
    expect(store.referenceCountForNode("n1")).toBe(1);
  });
});

describe("手势合并成一条历史", () => {
  it("一次拖动写十帧，⌘Z 一下回到起点", () => {
    store.addItems([shape({ id: "a", x: 0, y: 0 })]);
    store.beginGesture("whiteboard.move");
    for (let step = 1; step <= 10; step += 1) {
      store.moveItems([{ id: "a", position: { x: step * 10, y: 0 } }]);
    }
    store.endGesture();
    expect(items()[0]).toMatchObject({ x: 100 });
    state().undo();
    expect(state().whiteboard.items[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('`history: "ignore"` 的写入撤不回来（排版结果不是一次编辑）', () => {
    store.addItems([shape({ id: "a" })]);
    resetHistory();
    store.updateItem("a", { h: 40 } as never, { history: "ignore" });
    expect(items()[0]).toMatchObject({ h: 40 });
    state().undo();
    expect(state().whiteboard.items[0]).toMatchObject({ h: 40 });
  });
});

describe("读取辅助", () => {
  it("按 id 取一条、取一批、取选区", () => {
    store.addItems([shape({ id: "a" }), shape({ id: "b" })]);
    expect(store.itemById("wb:a")?.id).toBe("a");
    expect(store.itemById("nope")).toBeNull();
    expect(store.itemsByIds(["wb:a", "b"]).map((item) => item.id)).toEqual([
      "a",
      "b",
    ]);
    store.select(["b"]);
    expect(store.selectedItems().map((item) => item.id)).toEqual(["b"]);
    expect(store.styleOfSelection()).toEqual({ color: "black", size: "m" });
  });

  it("整份文档换掉时空白板仍然合法", () => {
    store.setWhiteboard(emptyWhiteboard());
    expect(state().whiteboard).toEqual(emptyWhiteboard());
  });
});
