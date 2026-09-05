import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostCanvasClient } from "@armadra/host-client";

const canvasOwnership = vi.fn();

vi.mock("../api/client", () => ({
  RuntimeRequestError: class extends Error {},
  runtimeApi: { canvasOwnership: () => canvasOwnership() },
}));

const { useCanvasOwnership } = await import("./store");
const {
  canvasEventCursor,
  resetCanvasEventCursor,
  resetCanvasRevisions,
  setCanvasHostResolver,
} = await import("./gateway");
const { followCanvasEvents, pollCanvasEvents } = await import("./follow");

const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const timestamp = "2026-08-13T00:00:00.000Z";

const ownership = (owner: "runtime" | "host") => ({
  domain: "canvas" as const,
  owner,
  epoch: 4n,
  phase: "settled",
  reasonCode: "ownership.switch.verified",
  updatedAt: timestamp,
});

function client(
  subscribeEvents: ReturnType<typeof vi.fn>,
  getSnapshot = vi.fn(),
) {
  return {
    subscribeEvents,
    getSnapshot,
    client: { subscribeEvents, getSnapshot } as unknown as HostCanvasClient,
  };
}

beforeEach(() => {
  canvasOwnership.mockReset();
  canvasOwnership.mockResolvedValue(ownership("host"));
  resetCanvasRevisions();
});

afterEach(() => {
  setCanvasHostResolver(null);
  useCanvasOwnership.getState().reset();
  vi.useRealTimers();
});

describe("按 sequence 续订画布事件", () => {
  it("Runtime 在写、或还没读过文档时不订阅", async () => {
    const host = client(vi.fn());
    setCanvasHostResolver(async () => host.client);

    canvasOwnership.mockResolvedValue(ownership("runtime"));
    await useCanvasOwnership.getState().probe();
    expect(await pollCanvasEvents(workspaceId)).toBe("unavailable");

    useCanvasOwnership.getState().reset();
    canvasOwnership.mockResolvedValue(ownership("host"));
    await useCanvasOwnership.getState().probe();
    // Host 在写，但这个工作空间还没读到过文档：没有可续的位置，从 0 开始
    // 订会把整段历史当成刚发生的改动。
    expect(await pollCanvasEvents(workspaceId)).toBe("unavailable");
    expect(host.subscribeEvents).not.toHaveBeenCalled();
  });

  it("从记住的游标之后取，有事件才报改动并前进", async () => {
    await useCanvasOwnership.getState().probe();
    resetCanvasEventCursor(workspaceId, 9007199254740993n);
    const subscribe = vi
      .fn()
      .mockResolvedValueOnce({
        status: "ok",
        events: [],
        nextCursor: 9007199254740993n,
        hasMore: false,
        minCursor: 1n,
        highWatermark: 9007199254740993n,
      })
      .mockResolvedValueOnce({
        status: "ok",
        events: [{ sequence: 9007199254740994n, entityId: "node-1" }],
        nextCursor: 9007199254740994n,
        hasMore: false,
        minCursor: 1n,
        highWatermark: 9007199254740994n,
      });
    const host = client(subscribe);
    setCanvasHostResolver(async () => host.client);

    expect(await pollCanvasEvents(workspaceId)).toBe("idle");
    expect(subscribe).toHaveBeenLastCalledWith(9007199254740993n, 200);
    expect(canvasEventCursor(workspaceId)).toBe(9007199254740993n);

    expect(await pollCanvasEvents(workspaceId)).toBe("changed");
    expect(canvasEventCursor(workspaceId)).toBe(9007199254740994n);
  });

  /**
   * 同一台 Host 上别的工作空间在忙时，一页里可能一条本工作空间的事件都没有。
   * 那一段确实已经看过了，游标必须跟上，否则跟随器会一直重扫同一段历史。
   */
  it("整页都被过滤掉时游标照样前进，并接着追下一页", async () => {
    await useCanvasOwnership.getState().probe();
    resetCanvasEventCursor(workspaceId, 10n);
    const subscribe = vi
      .fn()
      .mockResolvedValueOnce({
        status: "ok",
        events: [],
        nextCursor: 60n,
        hasMore: true,
        minCursor: 1n,
        highWatermark: 90n,
      })
      .mockResolvedValueOnce({
        status: "ok",
        events: [],
        nextCursor: 90n,
        hasMore: false,
        minCursor: 1n,
        highWatermark: 90n,
      });
    const host = client(subscribe);
    setCanvasHostResolver(async () => host.client);

    expect(await pollCanvasEvents(workspaceId)).toBe("idle");
    expect(subscribe).toHaveBeenNthCalledWith(1, 10n, 200);
    expect(subscribe).toHaveBeenNthCalledWith(2, 60n, 200);
    expect(canvasEventCursor(workspaceId)).toBe(90n);
  });

  it("游标过旧时按快照重置，而不是从保留下限硬续", async () => {
    await useCanvasOwnership.getState().probe();
    resetCanvasEventCursor(workspaceId, 2n);
    const subscribe = vi.fn().mockResolvedValue({
      status: "snapshotRequired",
      minCursor: 40n,
      highWatermark: 90n,
    });
    const getSnapshot = vi.fn().mockResolvedValue({ sequence: 90n });
    const host = client(subscribe, getSnapshot);
    setCanvasHostResolver(async () => host.client);

    expect(await pollCanvasEvents(workspaceId)).toBe("resnapshot");
    // 快照自带它一致的那个序号；用保留下限会漏掉下限到快照之间的改动。
    expect(canvasEventCursor(workspaceId)).toBe(90n);
  });

  it("游标超出水位时停止跟随，不把游标退回去", async () => {
    await useCanvasOwnership.getState().probe();
    resetCanvasEventCursor(workspaceId, 500n);
    const subscribe = vi.fn().mockResolvedValue({
      status: "cursorAhead",
      minCursor: 1n,
      highWatermark: 90n,
    });
    const host = client(subscribe);
    setCanvasHostResolver(async () => host.client);

    expect(await pollCanvasEvents(workspaceId)).toBe("diverged");
    expect(canvasEventCursor(workspaceId)).toBe(500n);
  });

  it("这一轮问不到就不动游标", async () => {
    await useCanvasOwnership.getState().probe();
    resetCanvasEventCursor(workspaceId, 7n);
    const subscribe = vi.fn().mockRejectedValue(new Error("offline"));
    const host = client(subscribe);
    setCanvasHostResolver(async () => host.client);

    expect(await pollCanvasEvents(workspaceId)).toBe("unreachable");
    expect(canvasEventCursor(workspaceId)).toBe(7n);
  });

  it("跟随器只在有改动时回调，diverged 之后停表", async () => {
    vi.useFakeTimers();
    await useCanvasOwnership.getState().probe();
    resetCanvasEventCursor(workspaceId, 1n);
    const subscribe = vi
      .fn()
      .mockResolvedValueOnce({
        status: "ok",
        events: [{ sequence: 2n, entityId: "node-1" }],
        nextCursor: 2n,
        hasMore: false,
        minCursor: 1n,
        highWatermark: 2n,
      })
      .mockResolvedValue({
        status: "cursorAhead",
        minCursor: 1n,
        highWatermark: 1n,
      });
    const host = client(subscribe);
    setCanvasHostResolver(async () => host.client);
    const changed = vi.fn();

    const stop = followCanvasEvents(workspaceId, changed, 10);
    await vi.advanceTimersByTimeAsync(15);
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15);
    expect(changed).toHaveBeenCalledTimes(1);
    // diverged 之后不再排下一轮：继续问只会一直得到同一个答案。
    const calls = subscribe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(subscribe.mock.calls.length).toBe(calls);
    stop();
  });
});
