import { describe, expect, it, vi } from "vitest";
import type { Board, BoardDocument } from "@armadra/shared";
import { CanvasSaveQueue, replayLocalEdits } from "./canvas-save-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type Save = (
  workspaceId: string,
  boardId: string,
  document: BoardDocument,
) => Promise<BoardDocument>;

const documentOf = (id: string) =>
  ({ nodes: [{ id }] }) as unknown as BoardDocument;

describe("CanvasSaveQueue", () => {
  it("serializes saves and collapses pending edits to the latest document", async () => {
    const first = deferred<BoardDocument>();
    const latest = deferred<BoardDocument>();
    const save = vi
      .fn<Save>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);
    const queue = new CanvasSaveQueue(save, vi.fn(), vi.fn());
    const documentA = documentOf("a");
    const documentB = documentOf("b");
    const documentC = documentOf("c");

    const a = queue.enqueue("workspace", "board", documentA);
    const b = queue.enqueue("workspace", "board", documentB);
    const c = queue.enqueue("workspace", "board", documentC);
    expect(save).toHaveBeenCalledTimes(1);

    first.resolve(documentA);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]?.[2]).toBe(documentC);
    latest.resolve(documentC);
    await Promise.all([a, b, c]);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("keeps two boards of the same workspace apart", async () => {
    const save = vi
      .fn<Save>()
      .mockImplementation(async (_ws, _board, document) => document);
    const queue = new CanvasSaveQueue(save, vi.fn(), vi.fn());

    await Promise.all([
      queue.enqueue("workspace", "board-1", documentOf("one")),
      queue.enqueue("workspace", "board-2", documentOf("two")),
    ]);
    await queue.flush();

    expect(save.mock.calls.map((call) => call[1]).sort()).toEqual([
      "board-1",
      "board-2",
    ]);
  });

  it("rebases a queued document onto the freshly saved board timestamp", async () => {
    const inFlight = deferred<BoardDocument>();
    const save = vi.fn<Save>().mockReturnValueOnce(inFlight.promise);
    const queue = new CanvasSaveQueue(save, vi.fn(), vi.fn());

    void queue.enqueue("workspace", "board", documentOf("a"));
    const queued = {
      board: { id: "board", updatedAt: "stale" },
      nodes: [],
      edges: [],
      strokes: [],
    } as unknown as BoardDocument;
    void queue.enqueue("workspace", "board", queued);

    const rebased = { id: "board", updatedAt: "fresh" } as unknown as Board;
    queue.rebasePending("workspace", "board", rebased);

    save.mockImplementationOnce(async (_ws, _board, document) => document);
    inFlight.resolve(documentOf("a"));
    await queue.flush();

    expect(save.mock.calls[1]?.[2].board).toBe(rebased);
  });

  it("drops a pending board without cancelling the one in flight", async () => {
    const inFlight = deferred<BoardDocument>();
    const save = vi.fn<Save>().mockReturnValueOnce(inFlight.promise);
    const queue = new CanvasSaveQueue(save, vi.fn(), vi.fn());

    void queue.enqueue("workspace", "board-1", documentOf("one"));
    void queue.enqueue("workspace", "board-2", documentOf("two"));
    queue.clear("workspace", "board-2");
    inFlight.resolve(documentOf("one"));
    await queue.flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1]).toBe("board-1");
  });

  it("reports the failing board to the error callback", async () => {
    const onError = vi.fn();
    const save = vi.fn<Save>().mockRejectedValue(new Error("CAS conflict"));
    const queue = new CanvasSaveQueue(save, vi.fn(), onError);

    await queue
      .enqueue("workspace", "board", documentOf("a"))
      .catch(() => undefined);

    expect(onError).toHaveBeenCalledWith(
      "workspace",
      "board",
      expect.any(Error),
      "edit",
    );
  });

  it("把保存原因透给回调：视口保存不是编辑", async () => {
    const onSaved = vi.fn();
    const save = vi.fn<Save>().mockResolvedValue(documentOf("saved"));
    const queue = new CanvasSaveQueue(save, onSaved, vi.fn());

    await queue.saveViewport("workspace", "board", documentOf("a"));

    expect(onSaved).toHaveBeenCalledWith(
      "workspace",
      "board",
      expect.anything(),
      expect.anything(),
      "viewport",
    );
  });

  it("同一轮里只要有过编辑，折叠后的那次就算编辑", async () => {
    const onSaved = vi.fn();
    const inFlight = deferred<BoardDocument>();
    const save = vi
      .fn<Save>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(documentOf("saved"));
    const queue = new CanvasSaveQueue(save, onSaved, vi.fn());

    void queue.enqueue("workspace", "board", documentOf("a"));
    void queue.enqueue("workspace", "board", documentOf("b"));
    void queue.saveViewport("workspace", "board", documentOf("c"));
    inFlight.resolve(documentOf("saved"));
    await queue.flush();

    expect(onSaved).toHaveBeenLastCalledWith(
      "workspace",
      "board",
      expect.anything(),
      expect.anything(),
      "edit",
    );
  });
});

/* --------------------------- 409 变基重放（Phase 4） ----------------------- */

/** 本地这份文档最后一次与 Runtime 对齐的时刻；`createdAt` 早于它 = 存过。 */
const SYNCED_AT = "2026-09-04T10:00:00.000Z";
const BEFORE = "2026-09-04T09:00:00.000Z";
const AFTER = "2026-09-04T10:00:05.000Z";

interface NodeFixture {
  id: string;
  createdAt: string;
  position?: { x: number; y: number };
  parentId?: string;
}

function docOf(
  updatedAt: string,
  nodes: NodeFixture[],
  edges: {
    id: string;
    source: string;
    target: string;
    createdAt: string;
  }[] = [],
  board: Partial<Board> = {},
): BoardDocument {
  return {
    board: {
      id: "board",
      updatedAt,
      viewport: { x: 0, y: 0, zoom: 1 },
      kanban: { columns: [], cards: {} },
      whiteboard: "",
      ...board,
    },
    nodes,
    edges,
  } as unknown as BoardDocument;
}

describe("replayLocalEdits", () => {
  it("远端加了一个节点 + 本地移了一个节点：两个改动都留下", () => {
    const local = docOf(
      SYNCED_AT,
      [
        { id: "a", createdAt: BEFORE, position: { x: 500, y: 500 } },
        { id: "b", createdAt: BEFORE, position: { x: 0, y: 0 } },
      ],
      [],
      { viewport: { x: 12, y: 34, zoom: 0.75 } },
    );
    const remote = docOf("2026-09-04T10:00:03.000Z", [
      // 另一个窗口没动过 a、b，只多开了一个 c
      { id: "a", createdAt: BEFORE, position: { x: 100, y: 100 } },
      { id: "b", createdAt: BEFORE, position: { x: 0, y: 0 } },
      { id: "c", createdAt: AFTER, position: { x: 900, y: 900 } },
    ]);

    const merged = replayLocalEdits(remote, local);

    expect(merged.nodes.map((node) => node.id).sort()).toEqual(["a", "b", "c"]);
    // 本地拖到 (500,500) 的那一下不能被远端的旧位置盖回去
    expect(merged.nodes.find((node) => node.id === "a")?.position).toEqual({
      x: 500,
      y: 500,
    });
    // 远端新开的节点原样保留
    expect(merged.nodes.find((node) => node.id === "c")?.position).toEqual({
      x: 900,
      y: 900,
    });
    // 下一次 PUT 的 CAS 戳来自远端，视口仍是本窗口的
    expect(merged.board.updatedAt).toBe("2026-09-04T10:00:03.000Z");
    expect(merged.board.viewport).toEqual({ x: 12, y: 34, zoom: 0.75 });
  });

  it("远端删掉的节点不复活，本地新建的节点留下", () => {
    const local = docOf(SYNCED_AT, [
      { id: "gone", createdAt: BEFORE },
      { id: "fresh", createdAt: AFTER },
    ]);
    const remote = docOf(AFTER, []);

    const merged = replayLocalEdits(remote, local);

    expect(merged.nodes.map((node) => node.id)).toEqual(["fresh"]);
  });

  it("剔掉两端不齐的悬空边，并解开指向已删分组的父级", () => {
    const local = docOf(
      SYNCED_AT,
      [
        { id: "kept", createdAt: BEFORE, parentId: "group" },
        { id: "group", createdAt: BEFORE },
      ],
      [
        { id: "e1", source: "kept", target: "group", createdAt: BEFORE },
        { id: "e2", source: "kept", target: "vanished", createdAt: AFTER },
      ],
    );
    const remote = docOf(AFTER, [{ id: "kept", createdAt: BEFORE }]);

    const merged = replayLocalEdits(remote, local);

    expect(merged.nodes.map((node) => node.id)).toEqual(["kept"]);
    expect(merged.nodes[0]?.parentId).toBeUndefined();
    expect(merged.edges).toEqual([]);
  });
});
