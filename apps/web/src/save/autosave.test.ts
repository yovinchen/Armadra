import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_WHITEBOARD_BYTES,
  type Board,
  type BoardDocument,
  type Workspace,
} from "@armadra/shared";

/** store → defaults → nodes/registry 会把整棵渲染树拉进来，这里只要尺寸表。 */
const nodeMetaStub = {
  labelKey: "node.sticky",
  defaultSize: { width: 240, height: 200 },
  minSize: { width: 160, height: 120 },
  defaultColor: "#0a84ff",
  hasBridgeHandles: false,
};
vi.mock("../nodes/registry", () => ({
  NODE_META: new Proxy({}, { get: () => nodeMetaStub }),
  nodeMeta: () => nodeMetaStub,
}));

const saveBoard = vi.fn();
const loadBoard = vi.fn();
vi.mock("../api/client", () => ({
  runtimeApi: {
    saveBoard: (...args: unknown[]) => saveBoard(...args),
    loadBoard: (...args: unknown[]) => loadBoard(...args),
  },
  isConflict: (error: unknown) =>
    (error as { status?: number } | null)?.status === 409,
}));

/**
 * `syncWhiteboard()` 只在画布挂着的时候才序列化快照。默认给它 `null`
 * （= 画布没挂），单个用例再把假 editor 塞进来测 8 MiB 那条分支。
 */
const editorRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../canvas/editor-context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEditor: () => editorRef.current,
}));

const { useCanvasStore } = await import("../store/canvas-store");
const {
  EDIT_DEBOUNCE_MS,
  VIEWPORT_THROTTLE_MS,
  resetAutosaveQueue,
  startAutosave,
} = await import("./autosave");

const timestamp = "2026-08-13T00:00:00.000Z";
const workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "One",
  rootPath: "/tmp/one",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
} as Workspace;

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

const document: BoardDocument = { board, nodes: [], edges: [] };

let stop = () => undefined as void;

beforeEach(() => {
  vi.useFakeTimers();
  saveBoard.mockReset();
  saveBoard.mockImplementation(
    async (_ws: string, _board: string, source: BoardDocument) => ({
      ...source,
      board: { ...source.board, updatedAt: "2026-08-13T00:00:01.000Z" },
    }),
  );
  loadBoard.mockReset();
  resetAutosaveQueue();
  editorRef.current = null;
  useCanvasStore.getState().setWorkspace(workspace);
  useCanvasStore.getState().setDocument(document);
  stop = startAutosave();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("autosave", () => {
  it("编辑防抖：连续改动只发一次 PUT", async () => {
    useCanvasStore.getState().addNode("sticky");
    useCanvasStore.getState().addNode("sticky");
    expect(saveBoard).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);
    expect(saveBoard).toHaveBeenCalledTimes(1);
    expect(useCanvasStore.getState().saveState).toBe("saved");
    // CAS 时间戳换成 Runtime 返回的那个
    expect(useCanvasStore.getState().document?.board.updatedAt).toBe(
      "2026-08-13T00:00:01.000Z",
    );
  });

  it("平移单独节流 2 秒，且不动保存指示灯", async () => {
    useCanvasStore.getState().setViewport({ x: 10, y: 10, zoom: 1 });
    useCanvasStore.getState().setViewport({ x: 20, y: 20, zoom: 1 });
    expect(useCanvasStore.getState().saveState).toBe("saved");

    await vi.advanceTimersByTimeAsync(VIEWPORT_THROTTLE_MS - 1);
    expect(saveBoard).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(saveBoard).toHaveBeenCalledTimes(1);
    expect(saveBoard.mock.calls[0]?.[2]).toMatchObject({
      board: { viewport: { x: 20, y: 20, zoom: 1 } },
    });
    expect(useCanvasStore.getState().saveState).toBe("saved");
  });

  it("有编辑在排队时不再单独存视口", async () => {
    useCanvasStore.getState().addNode("sticky");
    useCanvasStore.getState().setViewport({ x: 5, y: 5, zoom: 1.5 });

    await vi.advanceTimersByTimeAsync(VIEWPORT_THROTTLE_MS + EDIT_DEBOUNCE_MS);
    expect(saveBoard).toHaveBeenCalledTimes(1);
    // 那一次编辑保存本来就带着最新视口
    expect(saveBoard.mock.calls[0]?.[2]).toMatchObject({
      board: { viewport: { x: 5, y: 5, zoom: 1.5 } },
    });
  });

  it("保存失败时记下错误并停在 error", async () => {
    saveBoard.mockRejectedValueOnce(new Error("看板已被其他窗口修改"));
    useCanvasStore.getState().addNode("sticky");

    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);
    expect(useCanvasStore.getState().saveState).toBe("error");
    expect(useCanvasStore.getState().saveError).toBe("看板已被其他窗口修改");
  });

  it("白板快照超过 8 MiB：不发 PUT，停在 error 并给出提示", async () => {
    // 一个 text shape 就撑爆上限：`stripDocumentRecords` 会原样留下它。
    const huge = {
      store: {
        "shape:ink": {
          id: "shape:ink",
          typeName: "shape",
          type: "text",
          parentId: "page:page",
          props: { text: "x".repeat(MAX_WHITEBOARD_BYTES) },
          meta: {},
        },
      },
      schema: { schemaVersion: 2, sequences: {} },
    };
    editorRef.current = { getSnapshot: () => ({ document: huge }) };
    // 直接置脏而不是 `addNode`：`canvas-store` 的动作也会去问 `getEditor()`，
    // 那和这条用例要测的东西无关。
    useCanvasStore.setState({ saveState: "dirty" });

    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);
    expect(saveBoard).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().saveState).toBe("error");
    expect(useCanvasStore.getState().saveError).toBe(
      "白板内容超出上限，未保存",
    );
    // 超限的那份快照绝不写进文档：下一轮保存不该把它带上。
    expect(useCanvasStore.getState().document?.board.whiteboard).toBe("");
  });

  it("白板快照不超限时随编辑一起 PUT 出去", async () => {
    const small = {
      store: {
        "shape:ink": {
          id: "shape:ink",
          typeName: "shape",
          type: "text",
          parentId: "page:page",
          props: { text: "hi" },
          meta: {},
        },
      },
      schema: { schemaVersion: 2, sequences: {} },
    };
    editorRef.current = { getSnapshot: () => ({ document: small }) };
    useCanvasStore.setState({ saveState: "dirty" });

    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);
    expect(saveBoard).toHaveBeenCalledTimes(1);
    const sent = saveBoard.mock.calls[0]?.[2] as BoardDocument;
    expect(JSON.parse(sent.board.whiteboard).store["shape:ink"]).toBeTruthy();
    expect(useCanvasStore.getState().saveState).toBe("saved");
  });

  /* ------------------------ 保存冲突（409）自动变基 ---------------------- */

  /** Runtime 的 409：`isConflict` 只看 `status`。 */
  const conflict = () =>
    Object.assign(new Error("Board changed since it was loaded"), {
      status: 409,
    });

  const remoteNode = {
    id: "019ff7d1-9999-7000-8000-000000000001",
    boardId: board.id,
    type: "sticky",
    title: "别的窗口开的",
    color: "#0a84ff",
    position: { x: 900, y: 900 },
    labels: [],
    note: "",
    data: { kind: "sticky", content: "" },
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  it("409 时拉最新文档、重放本地改动、重新保存，不亮红灯", async () => {
    saveBoard.mockRejectedValueOnce(conflict());
    loadBoard.mockResolvedValue({
      board: { ...board, updatedAt: "2026-08-13T00:00:02.000Z" },
      nodes: [remoteNode],
      edges: [],
    });

    useCanvasStore.getState().addNode("sticky");
    const localId = useCanvasStore.getState().document?.nodes[0]?.id;

    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);
    expect(loadBoard).toHaveBeenCalledTimes(1);
    // 变基之后重新排一轮防抖
    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);

    expect(saveBoard).toHaveBeenCalledTimes(2);
    const sent = saveBoard.mock.calls[1]?.[2] as BoardDocument;
    // 远端新增的节点保留，本地这一下也没丢
    expect(sent.nodes.map((node) => node.id).sort()).toEqual(
      [remoteNode.id, localId].sort(),
    );
    // CAS 戳换成远端最新的那个，否则下一次还得撞
    expect(sent.board.updatedAt).toBe("2026-08-13T00:00:02.000Z");
    expect(useCanvasStore.getState().saveState).toBe("saved");
    expect(useCanvasStore.getState().saveError).toBeNull();
  });

  it("连续三次 409 才提示", async () => {
    saveBoard.mockRejectedValue(conflict());
    loadBoard.mockResolvedValue({
      board: { ...board, updatedAt: "2026-08-13T00:00:02.000Z" },
      nodes: [remoteNode],
      edges: [],
    });

    useCanvasStore.getState().addNode("sticky");
    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS * 6);

    expect(saveBoard).toHaveBeenCalledTimes(3);
    expect(useCanvasStore.getState().saveState).toBe("error");
    expect(useCanvasStore.getState().saveError).toBe(
      "Board changed since it was loaded",
    );
  });

  it("切看板时丢掉未触发的定时器", async () => {
    useCanvasStore.getState().addNode("sticky");
    useCanvasStore.getState().selectBoard("other-board");

    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS * 4);
    expect(saveBoard).not.toHaveBeenCalled();
  });
});
