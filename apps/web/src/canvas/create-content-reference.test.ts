import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Board,
  BoardDocument,
  CanvasNode,
  Workspace,
} from "@armadra/shared";

/**
 * 建 / 定位 / 删一条内容引用（React Flow 计划 §2.5 / F29）。
 *
 * 三条规则，右键菜单与拖线两条路共用：只有带 Agent 的终端能当目标、
 * 同一对（对象，节点）只留一条并定位到已有的那条、一个节点最多 64 个
 * 唯一对端（连线的另一头也算）。
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
  const table = new Proxy({} as Record<string, typeof meta>, {
    get: () => meta,
  });
  return {
    NODE_META: table,
    nodeMeta: () => meta,
    DRAG_HANDLE_CLASS: "drag-handle",
    NODE_DRAG_HANDLE: ".drag-handle",
  };
});

const { toast } = await import("sonner");
const { useCanvasStore, resetHistory } = await import("@/store/canvas-store");
const { emptyWhiteboard } = await import("./whiteboard/model");
const { MAX_LINKS } = await import("./content-links");
const {
  createContentReference,
  findReference,
  referenceCountForNode,
  referenceTargets,
  removeContentReference,
} = await import("./create-content-reference");

const stamp = "2026-09-06T00:00:00.000Z";

const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "One",
  rootPath: "/tmp/one",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: stamp,
  createdAt: stamp,
  updatedAt: stamp,
};

const board: Board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: workspace.id,
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: stamp,
  updatedAt: stamp,
};

function node(
  id: string,
  type: CanvasNode["type"],
  data: Record<string, unknown> = {},
): CanvasNode {
  return {
    id,
    boardId: board.id,
    type,
    title: id,
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    labels: [],
    note: "",
    data: { kind: type, ...data },
    createdAt: stamp,
    updatedAt: stamp,
  } as CanvasNode;
}

const agent = () => node("agent", "terminal", { agent: { id: "claude" } });
const bareTerminal = () => node("plain", "terminal");
const sticky = () => node("note", "sticky");

let counter = 0;
function item(id = `item-${++counter}`) {
  return {
    id,
    kind: "shape" as const,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    z: 0,
    parentId: null,
    style: { color: "black" as const, size: "m" as const },
    geo: "rectangle" as const,
  };
}

function load(
  nodes: CanvasNode[],
  items: ReturnType<typeof item>[],
  references: { id: string; itemId: string; nodeId: string }[] = [],
  edges: { id: string; source: string; target: string }[] = [],
): void {
  const document: BoardDocument = {
    board,
    nodes,
    edges: edges.map((edge) => ({
      ...edge,
      boardId: board.id,
      kind: "link",
      createdAt: stamp,
      updatedAt: stamp,
    })) as never,
  };
  useCanvasStore.getState().setWorkspace(workspace);
  useCanvasStore.getState().setDocument(document);
  useCanvasStore
    .getState()
    .setWhiteboard({ ...emptyWhiteboard(), items, references } as never, {
      history: "ignore",
    });
  // 灌初始白板本身会置脏；从「已保存」开始，后面的断言才说明问题。
  useCanvasStore.getState().setSaveState("saved");
  resetHistory();
}

const state = () => useCanvasStore.getState();
const references = () => state().whiteboard.references;

beforeEach(() => {
  counter = 0;
  vi.restoreAllMocks();
  vi.spyOn(toast, "error").mockImplementation(() => "" as never);
  vi.spyOn(toast, "info").mockImplementation(() => "" as never);
});

describe("referenceTargets", () => {
  it("只有带 Agent 的终端能当引用目标", () => {
    load([agent(), bareTerminal(), sticky()], []);
    expect(referenceTargets(state().document).map((n) => n.id)).toEqual([
      "agent",
    ]);
  });

  it("没有文档时是空表", () => {
    expect(referenceTargets(null)).toEqual([]);
  });
});

describe("referenceCountForNode", () => {
  it("连线的另一头与引用的对象一起去重计数", () => {
    const one = item();
    load(
      [agent(), sticky()],
      [one],
      [{ id: "r1", itemId: one.id, nodeId: "agent" }],
      [{ id: "e1", source: "agent", target: "note" }],
    );
    expect(
      referenceCountForNode(state().document, state().whiteboard, "agent"),
    ).toBe(2);
  });

  it("同一个对端连了两次只算一个", () => {
    load(
      [agent(), sticky()],
      [],
      [],
      [
        { id: "e1", source: "agent", target: "note" },
        { id: "e2", source: "note", target: "agent" },
      ],
    );
    expect(
      referenceCountForNode(state().document, state().whiteboard, "agent"),
    ).toBe(1);
  });
});

describe("createContentReference", () => {
  it("建一行引用，id 就是 `ContextLink.id`，并选中那条边", () => {
    const one = item();
    load([agent()], [one]);
    const outcome = createContentReference(`wb:${one.id}`, "agent");
    expect(outcome.kind).toBe("created");
    expect(references()).toEqual([
      { id: (outcome as { id: string }).id, itemId: one.id, nodeId: "agent" },
    ]);
    expect(state().selectedEdgeIds).toEqual([(outcome as { id: string }).id]);
  });

  it("裸 uuid 与 `wb:` 前缀都收", () => {
    const one = item();
    load([agent()], [one]);
    expect(createContentReference(one.id, "agent").kind).toBe("created");
    expect(references()).toHaveLength(1);
  });

  it("改动落进 canvas-store：置脏且可撤销", () => {
    const one = item();
    load([agent()], [one]);
    createContentReference(`wb:${one.id}`, "agent");
    expect(state().saveState).toBe("dirty");
  });

  it("重复引用同一对象只定位已有的那条，不再画一条", () => {
    const one = item();
    load([agent()], [one], [{ id: "r1", itemId: one.id, nodeId: "agent" }]);
    const outcome = createContentReference(`wb:${one.id}`, "agent");
    expect(outcome).toEqual({ kind: "existing", id: "r1" });
    expect(references()).toHaveLength(1);
    expect(state().selectedEdgeIds).toEqual(["r1"]);
    expect(toast.info).toHaveBeenCalledOnce();
  });

  it("`notify: false` 时定位不弹提示（拖线那条路自己提示）", () => {
    const one = item();
    load([agent()], [one], [{ id: "r1", itemId: one.id, nodeId: "agent" }]);
    createContentReference(one.id, "agent", { notify: false });
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("对象不在白板上时拒绝", () => {
    load([agent()], []);
    expect(createContentReference("wb:gone", "agent")).toEqual({
      kind: "rejected",
      reason: "unknown",
    });
    expect(references()).toHaveLength(0);
  });

  it("不带 Agent 的终端与非终端节点都不是合法目标", () => {
    const one = item();
    load([bareTerminal(), sticky()], [one]);
    expect(createContentReference(one.id, "plain")).toEqual({
      kind: "rejected",
      reason: "unknown",
    });
    expect(createContentReference(one.id, "note")).toEqual({
      kind: "rejected",
      reason: "unknown",
    });
  });

  it("第 65 个对端被上限挡住并提示一次", () => {
    const one = item("target");
    const filler = Array.from({ length: MAX_LINKS }, (_, index) =>
      item(`filler-${index}`),
    );
    load(
      [agent()],
      [one, ...filler],
      filler.map((row, index) => ({
        id: `r${index}`,
        itemId: row.id,
        nodeId: "agent",
      })),
    );
    expect(
      referenceCountForNode(state().document, state().whiteboard, "agent"),
    ).toBe(MAX_LINKS);
    expect(createContentReference(one.id, "agent")).toEqual({
      kind: "rejected",
      reason: "limit",
    });
    expect(references()).toHaveLength(MAX_LINKS);
    expect(toast.error).toHaveBeenCalledOnce();
  });

  it("已经引用过的对象不受上限影响（定位仍然可用）", () => {
    const filler = Array.from({ length: MAX_LINKS }, (_, index) =>
      item(`filler-${index}`),
    );
    load(
      [agent()],
      filler,
      filler.map((row, index) => ({
        id: `r${index}`,
        itemId: row.id,
        nodeId: "agent",
      })),
    );
    expect(createContentReference(filler[0]!.id, "agent")).toEqual({
      kind: "existing",
      id: "r0",
    });
  });
});

describe("findReference", () => {
  it("找到同一对（对象，节点）的那一行", () => {
    const one = item();
    load([agent()], [one], [{ id: "r1", itemId: one.id, nodeId: "agent" }]);
    expect(findReference(state().whiteboard, `wb:${one.id}`, "agent")).toBe(
      "r1",
    );
    expect(findReference(state().whiteboard, one.id, "other")).toBeNull();
  });
});

describe("removeContentReference", () => {
  it("删引用行，白板对象留着", () => {
    const one = item();
    load([agent()], [one], [{ id: "r1", itemId: one.id, nodeId: "agent" }]);
    expect(removeContentReference("r1")).toBe(true);
    expect(references()).toEqual([]);
    expect(state().whiteboard.items).toHaveLength(1);
  });

  it("顺带把它从选区里摘掉", () => {
    const one = item();
    load([agent()], [one], [{ id: "r1", itemId: one.id, nodeId: "agent" }]);
    state().setSelection({ edges: ["r1"] });
    removeContentReference("r1");
    expect(state().selectedEdgeIds).toEqual([]);
  });

  it("不存在的 id 返回 false 且不置脏", () => {
    load([agent()], []);
    expect(removeContentReference("nope")).toBe(false);
    expect(state().saveState).not.toBe("dirty");
  });

  it("可撤销：删掉之后 ⌘Z 把引用放回来", () => {
    const one = item();
    load([agent()], [one], [{ id: "r1", itemId: one.id, nodeId: "agent" }]);
    removeContentReference("r1");
    expect(references()).toEqual([]);
    state().undo();
    expect(references()).toEqual([
      { id: "r1", itemId: one.id, nodeId: "agent" },
    ]);
  });
});
