import { describe, expect, it, vi } from "vitest";
import type { Board, BoardDocument } from "@ai-coding-canvas/shared";
import { CanvasSaveQueue } from "./canvas-save-queue";

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
    );
  });
});
