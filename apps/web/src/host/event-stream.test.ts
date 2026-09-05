import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  create,
  toBinary,
  EventCursorStatus,
  EventDomain,
  EventPageSchema,
  EventStreamFrameSchema,
} from "@armadra/protocol";
import type { HostCanvasClient } from "@armadra/host-client";

const canvasOwnership = vi.fn();

vi.mock("../api/client", () => ({
  RuntimeRequestError: class extends Error {},
  runtimeApi: { canvasOwnership: () => canvasOwnership() },
  workspaceEventsUrl: (id: string) => `ws://127.0.0.1:0/api/workspaces/${id}`,
}));

const { onWorkspaceEvent, resetWorkspaceEvents } = await import(
  "../api/events"
);
const {
  canvasEventCursor,
  resetCanvasEventCursor,
  resetCanvasRevisions,
  setCanvasHostResolver,
} = await import("../canvas-ownership/gateway");
const { connectCanvasEventStream, setCanvasEventSocketFactory } = await import(
  "./event-stream"
);

const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const canvasId = "019ff7d1-0d12-7421-833d-2c5e8d64ee11";

/** A scripted socket: nothing in these tests reaches the network. */
class FakeSocket {
  binaryType = "blob";
  readyState = 0;
  closed = 0;
  sent: Uint8Array[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(
      ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer),
    );
  }
  close(): void {
    this.closed += 1;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(frame: Parameters<typeof create<typeof EventStreamFrameSchema>>[1]) {
    const wire = toBinary(
      EventStreamFrameSchema,
      create(EventStreamFrameSchema, frame),
    );
    this.onmessage?.({ data: wire.buffer.slice(0) });
  }
}

const sockets: FakeSocket[] = [];

function socketAt(index: number): FakeSocket {
  const socket = sockets[index];
  if (!socket) throw new Error(`the stream never opened socket ${index}`);
  return socket;
}

type PageInit = NonNullable<
  Parameters<typeof create<typeof EventPageSchema>>[1]
>;

function pageFrame(events: PageInit["events"], nextCursor: bigint) {
  return {
    payload: {
      case: "page" as const,
      value: create(EventPageSchema, {
        status: EventCursorStatus.OK,
        events,
        nextCursor,
        minCursor: 0n,
        highWatermark: nextCursor,
      }),
    },
  };
}

function canvasEvent(sequence: bigint) {
  return {
    sequence,
    transactionId: sequence,
    transactionSize: 1,
    workspaceId,
    domain: EventDomain.CANVAS,
    kind: "canvas",
    entityId: canvasId,
    revision: sequence,
    entity: {
      case: "canvas" as const,
      value: { canvasId, workspaceId, updatedAtUnixMs: 1788557900000n },
    },
  };
}

beforeEach(() => {
  sockets.length = 0;
  canvasOwnership.mockReset();
  resetCanvasRevisions();
  resetWorkspaceEvents();
  setCanvasEventSocketFactory((url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  });
});

afterEach(() => {
  setCanvasEventSocketFactory(null);
  setCanvasHostResolver(null);
  resetWorkspaceEvents();
});

describe("Host 事件流接线", () => {
  it("把信封投影成界面已经在订阅的事件，并推进共享游标", () => {
    const changed = vi.fn();
    const sources: string[] = [];
    const boards: string[] = [];
    onWorkspaceEvent("board.changed", (event) => boards.push(event.boardId));

    const handle = connectCanvasEventStream(workspaceId, 4n, {
      onChanged: changed,
      onDiverged: vi.fn(),
      onSource: (source) => sources.push(source),
    });
    expect(handle).not.toBeNull();
    socketAt(0).open();
    expect(sources).toContain("stream");

    socketAt(0).deliver(pageFrame([canvasEvent(5n), canvasEvent(6n)], 6n));
    // 界面的订阅接口没变：面板照旧收 `board.changed`，只是来源换了。
    expect(boards).toEqual([canvasId, canvasId]);
    expect(changed).toHaveBeenCalledTimes(1);
    // 游标是两条路共用的：轮询后备接手时从这里续，不会重扫这一段。
    expect(canvasEventCursor(workspaceId)).toBe(6n);
    handle?.stop();
  });

  it("一页里没有可命名的改动时仍然要求重读，不当作什么都没发生", () => {
    const changed = vi.fn();
    const handle = connectCanvasEventStream(workspaceId, 0n, {
      onChanged: changed,
      onDiverged: vi.fn(),
      onSource: vi.fn(),
    });
    socketAt(0).open();
    // 墓碑不带实体，说不出属于哪块画布；这仍是一次真的改动。
    socketAt(0).deliver(
      pageFrame(
        [
          {
            sequence: 1n,
            transactionId: 1n,
            transactionSize: 1,
            workspaceId,
            domain: EventDomain.CANVAS,
            kind: "node",
            entityId: "node-1",
            revision: 2n,
            deleted: true,
          },
        ],
        1n,
      ),
    );
    expect(changed).toHaveBeenCalledTimes(1);
    handle?.stop();
  });

  it("游标过旧时按快照重置并从那个序号续", async () => {
    const getSnapshot = vi.fn().mockResolvedValue({ sequence: 41n });
    setCanvasHostResolver(
      async () => ({ getSnapshot }) as unknown as HostCanvasClient,
    );
    const changed = vi.fn();
    const sources: string[] = [];
    const handle = connectCanvasEventStream(workspaceId, 1n, {
      onChanged: changed,
      onDiverged: vi.fn(),
      onSource: (source) => sources.push(source),
    });
    socketAt(0).open();
    socketAt(0).deliver({
      payload: {
        case: "page",
        value: create(EventPageSchema, {
          status: EventCursorStatus.SNAPSHOT_REQUIRED,
          minCursor: 40n,
          highWatermark: 120n,
        }),
      },
    });
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(canvasEventCursor(workspaceId)).toBe(41n);
    expect(changed).toHaveBeenCalledTimes(1);
    // 后备在重新接上之前接手，界面不会声称自己还在实时跟随。
    expect(sources).toContain("polling");
    handle?.stop();
  });

  it("游标超出水位时停止跟随，不把游标退回去", () => {
    resetCanvasEventCursor(workspaceId, 500n);
    const diverged = vi.fn();
    const sources: string[] = [];
    const handle = connectCanvasEventStream(workspaceId, 500n, {
      onChanged: vi.fn(),
      onDiverged: diverged,
      onSource: (source) => sources.push(source),
    });
    socketAt(0).open();
    socketAt(0).deliver({
      payload: {
        case: "page",
        value: create(EventPageSchema, {
          status: EventCursorStatus.CURSOR_AHEAD,
          minCursor: 1n,
          highWatermark: 9n,
        }),
      },
    });
    expect(diverged).toHaveBeenCalledTimes(1);
    expect(sources.at(-1)).toBe("stopped");
    expect(canvasEventCursor(workspaceId)).toBe(500n);
    handle?.stop();
  });

  it("停止之后不再投递，也不再报来源", () => {
    const changed = vi.fn();
    const sources: string[] = [];
    const handle = connectCanvasEventStream(workspaceId, 0n, {
      onChanged: changed,
      onDiverged: vi.fn(),
      onSource: (source) => sources.push(source),
    });
    socketAt(0).open();
    handle?.stop();
    const seen = sources.length;
    socketAt(0).onclose?.({});
    expect(sources.length).toBe(seen);
    expect(changed).not.toHaveBeenCalled();
  });
});
