import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentStatusStore } from "../agent/status-store";
import {
  connectWorkspaceEvents,
  nextReconnectDelay,
  onWorkspaceEvent,
  onWorkspaceConnection,
  resetWorkspaceEvents,
} from "./events";

const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed22";
const NODE = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  receive(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }

  drop() {
    this.onclose?.();
  }
}

const original = globalThis.WebSocket;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  useAgentStatusStore.getState().reset();
});

afterEach(() => {
  resetWorkspaceEvents();
  vi.useRealTimers();
  globalThis.WebSocket = original;
});

function statusFrame(state: "working" | "done") {
  return JSON.stringify({
    type: "agent.status",
    status: {
      nodeId: NODE,
      workspaceId: WORKSPACE,
      agentId: "claude",
      state,
      unread: false,
      verified: true,
      restored: false,
      updatedAt: new Date().toISOString(),
    },
  });
}

describe("workspace events", () => {
  it("reports connection generations without a late closed socket hiding the replacement", () => {
    const seen = vi.fn();
    const off = onWorkspaceConnection(seen);
    const release = connectWorkspaceEvents(WORKSPACE);
    const originalSocket = FakeSocket.instances[0]!;
    originalSocket.onopen?.();
    originalSocket.drop();
    vi.advanceTimersByTime(1000);
    FakeSocket.instances[1]!.onopen?.();
    originalSocket.drop();
    expect(seen.mock.calls).toEqual([
      [WORKSPACE, true],
      [WORKSPACE, false],
      [WORKSPACE, true],
    ]);
    off();
    release();
  });
  it("opens one socket per workspace and parses frames", () => {
    const seen = vi.fn();
    const off = onWorkspaceEvent("agent.status", seen);
    const release = connectWorkspaceEvents(WORKSPACE);
    const second = connectWorkspaceEvents(WORKSPACE);

    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0]!.url).toContain(
      `/api/workspaces/${WORKSPACE}/events`,
    );

    FakeSocket.instances[0]!.receive(statusFrame("working"));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(useAgentStatusStore.getState().statuses[NODE]!.state).toBe(
      "working",
    );

    off();
    release();
    second();
  });

  it("drops frames that are not valid workspace events", () => {
    const seen = vi.fn();
    onWorkspaceEvent("agent.status", seen);
    const release = connectWorkspaceEvents(WORKSPACE);

    FakeSocket.instances[0]!.receive("not json");
    FakeSocket.instances[0]!.receive(JSON.stringify({ type: "nope" }));
    FakeSocket.instances[0]!.receive(
      JSON.stringify({ type: "agent.status", status: { nodeId: 1 } }),
    );

    expect(seen).not.toHaveBeenCalled();
    release();
  });

  it("reconnects with an exponential backoff", () => {
    const release = connectWorkspaceEvents(WORKSPACE);

    FakeSocket.instances[0]!.drop();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1]!.drop();
    vi.advanceTimersByTime(1_999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);

    // 成功握手把退避清零。
    FakeSocket.instances[2]!.onopen?.();
    FakeSocket.instances[2]!.drop();
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(4);

    release();
  });

  it("stops reconnecting once the last subscriber releases", () => {
    const release = connectWorkspaceEvents(WORKSPACE);
    release();
    expect(FakeSocket.instances[0]!.closed).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("caps the backoff at 10s", () => {
    expect(nextReconnectDelay(null)).toBe(1_000);
    expect(nextReconnectDelay(1_000)).toBe(2_000);
    expect(nextReconnectDelay(8_000)).toBe(10_000);
    expect(nextReconnectDelay(10_000)).toBe(10_000);
  });
});

describe("断线续订（R4c）", () => {
  /**
   * 第一次连上时页面还没有位置，所以问的是 `now`：它要的是「从现在起别漏」，
   * 而 `cursor=0` 是「把这个 core 发过的一切重放一遍」——两个不同的问题。
   */
  it("第一次带 cursor=now，重连带记下的那个数", () => {
    const release = connectWorkspaceEvents(WORKSPACE);
    const first = FakeSocket.instances[0] as FakeSocket;
    expect(first.url).toContain("?cursor=now");
    first.onopen?.();
    first.receive(
      JSON.stringify({ type: "cursor", cursor: 42, floor: 1, watermark: 42 }),
    );
    first.drop();
    vi.advanceTimersByTime(2_000);
    const second = FakeSocket.instances[1] as FakeSocket;
    expect(second.url).toContain("?cursor=42");
    release();
  });

  /** 游标只准前进：退回去等于把已经应用过的改动当成没发生。 */
  it("控制帧只让游标前进", () => {
    const release = connectWorkspaceEvents(WORKSPACE);
    const first = FakeSocket.instances[0] as FakeSocket;
    first.onopen?.();
    first.receive(
      JSON.stringify({ type: "cursor", cursor: 42, floor: 1, watermark: 42 }),
    );
    first.receive(
      JSON.stringify({ type: "cursor", cursor: 7, floor: 1, watermark: 42 }),
    );
    first.drop();
    vi.advanceTimersByTime(2_000);
    expect((FakeSocket.instances[1] as FakeSocket).url).toContain("?cursor=42");
    release();
  });

  /**
   * core 在升级之前就拒绝一个掉出保留下限的游标，那条连接根本没打开。
   * 拿同一个数重连只会撞上同一堵墙，而重连是按秒退避的。
   */
  it("升级被拒之后回到实时订阅，不再拿同一个数重连", () => {
    const release = connectWorkspaceEvents(WORKSPACE);
    const first = FakeSocket.instances[0] as FakeSocket;
    first.onopen?.();
    first.receive(
      JSON.stringify({ type: "cursor", cursor: 9, floor: 1, watermark: 9 }),
    );
    first.drop();
    vi.advanceTimersByTime(2_000);
    // 第二条没 open 就被关掉 = 409。
    (FakeSocket.instances[1] as FakeSocket).drop();
    vi.advanceTimersByTime(5_000);
    const third = FakeSocket.instances[2] as FakeSocket;
    expect(third.url).not.toContain("cursor=");
    release();
  });

  /** 控制帧不是第 22 个事件：它不该被派发给任何订阅者。 */
  it("控制帧不派发给事件订阅者", () => {
    const seen = vi.fn();
    const off = onWorkspaceEvent("board.changed", seen);
    const release = connectWorkspaceEvents(WORKSPACE);
    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.onopen?.();
    socket.receive(
      JSON.stringify({ type: "cursor", cursor: 3, floor: 0, watermark: 3 }),
    );
    expect(seen).not.toHaveBeenCalled();
    off();
    release();
  });
});
