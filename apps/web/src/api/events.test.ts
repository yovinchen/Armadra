import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentStatusStore } from "../agent/status-store";
import {
  connectWorkspaceEvents,
  nextReconnectDelay,
  onWorkspaceEvent,
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
