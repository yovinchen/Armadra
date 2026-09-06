import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, BoardDocument, CanvasNode } from "@armadra/shared";

/**
 * 两个窗口同开一块板（React Flow 计划 §6.3 A04）。
 *
 * 这里跑的是**两份真的 store**：`vi.resetModules()` 之后各自 `import()` 一次
 * `store/canvas-store`，拿到的是两个独立的 zustand 实例，就像两个窗口各自的
 * 那一份内存真相。中间那台「Runtime」是一个几十行的假货，但把真的那两条
 * 规则照抄了：整份文档替换 + `expectedUpdatedAt` 乐观锁，以及保存成功之后
 * 广播一条带新 `updatedAt` 的 `board.changed`。
 *
 * 断言四件事：改动传得过去、撤销栈不被污染、视口各是各的、两边同时改不同
 * 节点时谁的都不丢。
 */

/**
 * 每个窗口都要 `vi.resetModules()` 之后重新装一遍整棵 store 依赖图，一次
 * 一两秒；并发跑整套测试时默认的 5 秒不够。
 */
vi.setConfig({ testTimeout: 60_000 });

vi.mock("../../nodes/registry", () => {
  const meta = {
    labelKey: "node.terminal",
    icon: null,
    defaultSize: { width: 200, height: 100 },
    minSize: { width: 160, height: 120 },
    defaultColor: "#0a84ff",
    hasBridgeHandles: false,
  };
  const table = new Proxy({} as Record<string, typeof meta>, {
    get: () => meta,
    has: () => true,
  });
  return { NODE_META: table, nodeMeta: () => meta };
});

const STAMP = "2026-09-06T00:00:00.000Z";

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

function node(id: string, x: number): CanvasNode {
  return {
    id,
    boardId: board.id,
    type: "terminal",
    title: id,
    color: "#0a84ff",
    position: { x, y: 0 },
    size: { width: 200, height: 100 },
    labels: [],
    note: "",
    data: { kind: "terminal" },
    createdAt: STAMP,
    updatedAt: STAMP,
  } as CanvasNode;
}

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/* --------------------------- 假 Runtime（CAS） ---------------------------- */

class Conflict extends Error {}

function makeServer(initial: BoardDocument) {
  let current = initial;
  let clock = 0;
  const listeners = new Set<(updatedAt: string) => void>();
  return {
    load: () => wire(current),
    revision: () => current.board.updatedAt,
    onChanged(listener: (updatedAt: string) => void) {
      listeners.add(listener);
    },
    /** `PUT …/document`：整份替换 + `expectedUpdatedAt` 乐观锁。 */
    save(document: BoardDocument): BoardDocument {
      if (document.board.updatedAt !== current.board.updatedAt) {
        throw new Conflict("board changed since it was loaded");
      }
      clock += 1;
      current = wire({
        board: {
          ...current.board,
          viewport: document.board.viewport,
          whiteboard: document.board.whiteboard,
          updatedAt: `2026-09-06T00:00:0${clock}.000Z`,
        },
        nodes: document.nodes,
        edges: document.edges,
      });
      for (const listener of listeners) listener(current.board.updatedAt);
      return wire(current);
    },
  };
}

type Server = ReturnType<typeof makeServer>;

/* ------------------------------- 一个窗口 --------------------------------- */

async function openWindow(server: Server) {
  vi.resetModules();
  const { useCanvasStore } = await import("../../store/canvas-store");
  const { replayLocalEdits } = await import("../../save/canvas-save-queue");
  const { clearLocalEdits, localEdits } = await import(
    "../../store/canvas/pending"
  );
  const store = useCanvasStore;
  store.getState().selectBoard(board.id);
  store.getState().setDocument(server.load());

  /**
   * 事件订阅：`board.changed` 带的 `updatedAt` 与手里这份一样就是自己刚存的
   * 那一次，什么都不做——`app/use-board-sync.ts` 里就是这一句。
   */
  server.onChanged((updatedAt) => {
    if (store.getState().document?.board.updatedAt === updatedAt) return;
    store.getState().mergeRemoteDocument(server.load());
  });

  return {
    store,
    doc: () => store.getState().document!,
    positionOf: (id: string) =>
      store.getState().document!.nodes.find((row) => row.id === id)!.position,
    /**
     * `save/autosave.ts` 那一步的最小复刻：写出去，成功就收下新的 CAS 戳并
     * 结清「本地动过哪些」；409 就按同一份账变基一次再写。
     */
    save() {
      const attempt = (document: BoardDocument) => server.save(document);
      const settle = (saved: BoardDocument) => {
        clearLocalEdits();
        store.setState({ document: saved, saveState: "saved" });
      };
      try {
        settle(attempt(store.getState().document!));
      } catch (cause) {
        if (!(cause instanceof Conflict)) throw cause;
        const rebased = replayLocalEdits(
          server.load(),
          store.getState().document!,
          localEdits(),
        );
        store.setState({ document: rebased, saveState: "dirty" });
        settle(attempt(rebased));
      }
    },
  };
}

/* --------------------------------- 用例 ----------------------------------- */

const ONE = "019ff7d1-1111-7000-8000-000000000001";
const TWO = "019ff7d1-1111-7000-8000-000000000002";

describe("两个窗口同开一块板", () => {
  beforeEach(() => {
    counter = 0;
  });

  it("A 拖一个节点，B 立刻看到新位置", async () => {
    const server = makeServer({ board, nodes: [node(ONE, 0)], edges: [] });
    const a = await openWindow(server);
    const b = await openWindow(server);

    a.store.getState().moveNodes([{ id: ONE, position: { x: 515, y: 565 } }]);
    a.save();

    expect(b.positionOf(ONE)).toEqual({ x: 515, y: 565 });
  });

  it("A 新建、A 删除，B 都跟得上", async () => {
    const server = makeServer({ board, nodes: [node(ONE, 0)], edges: [] });
    const a = await openWindow(server);
    const b = await openWindow(server);

    const fresh = a.store.getState().addNode("sticky");
    a.save();
    expect(b.doc().nodes.map((row) => row.id)).toContain(fresh);

    a.store.getState().removeNodes([fresh]);
    a.save();
    expect(b.doc().nodes.map((row) => row.id)).not.toContain(fresh);
  });

  it("远端改动不进 B 的撤销栈，也不清掉 B 已有的历史", async () => {
    const server = makeServer({
      board,
      nodes: [node(ONE, 0), node(TWO, 400)],
      edges: [],
    });
    const a = await openWindow(server);
    const b = await openWindow(server);

    // B 自己先改一笔，攒一条历史。
    b.store.getState().moveNodes([{ id: TWO, position: { x: 400, y: 90 } }]);
    b.save();

    a.store.getState().moveNodes([{ id: ONE, position: { x: 700, y: 0 } }]);
    a.save();
    expect(b.positionOf(ONE)).toEqual({ x: 700, y: 0 });

    // ⌘Z 撤的是 B 自己那一笔，A 挪的那个节点原地不动。
    b.store.getState().undo();
    expect(b.positionOf(TWO)).toEqual({ x: 400, y: 0 });
    expect(b.positionOf(ONE)).toEqual({ x: 700, y: 0 });
  });

  it("远端新建的节点撤不掉（⌘Z 只回到 B 自己的上一步）", async () => {
    const server = makeServer({ board, nodes: [node(ONE, 0)], edges: [] });
    const a = await openWindow(server);
    const b = await openWindow(server);

    b.store.getState().moveNodes([{ id: ONE, position: { x: 5, y: 5 } }]);
    b.save();
    const fresh = a.store.getState().addNode("sticky");
    a.save();

    b.store.getState().undo();
    expect(b.doc().nodes.map((row) => row.id)).toContain(fresh);
  });

  it("视口各是各的：A 平移不会拽走 B 的相机", async () => {
    const server = makeServer({ board, nodes: [node(ONE, 0)], edges: [] });
    const a = await openWindow(server);
    const b = await openWindow(server);

    b.store.getState().setViewport({ x: -120, y: 30, zoom: 0.5 });
    a.store.getState().setViewport({ x: 900, y: 900, zoom: 2 });
    a.save();

    expect(b.doc().board.viewport).toEqual({ x: -120, y: 30, zoom: 0.5 });
  });

  it("两边同时改不同的节点，谁的都不丢", async () => {
    const server = makeServer({
      board,
      nodes: [node(ONE, 0), node(TWO, 400)],
      edges: [],
    });
    const a = await openWindow(server);
    const b = await openWindow(server);

    a.store.getState().moveNodes([{ id: ONE, position: { x: 11, y: 11 } }]);
    b.store.getState().moveNodes([{ id: TWO, position: { x: 22, y: 22 } }]);

    // A 先存；B 的 CAS 于是过期，走 409 变基那条路再存一次。
    a.save();
    b.save();

    for (const window of [a, b]) {
      expect(window.positionOf(ONE)).toEqual({ x: 11, y: 11 });
      expect(window.positionOf(TWO)).toEqual({ x: 22, y: 22 });
    }
    expect(server.load().nodes.find((row) => row.id === ONE)!.position).toEqual(
      { x: 11, y: 11 },
    );
    expect(server.load().nodes.find((row) => row.id === TWO)!.position).toEqual(
      { x: 22, y: 22 },
    );
  });
});
