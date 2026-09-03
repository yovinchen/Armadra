import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { AgentStatus, CanvasNode } from "@ai-coding-canvas/shared";

import { useAgentStatusStore } from "./status-store";
import {
  MAX_RETRIES,
  STALL_TIMEOUT_MS,
  armPendingLaunch,
  dependenciesSatisfied,
  dependencySatisfied,
  disarmPendingLaunch,
  resetPendingLaunches,
  runPendingLaunchNow,
  usePendingLaunchStore,
  usePendingLaunchWatcher,
} from "./pending-launch";

const BOARD = "019ff7d1-0d12-7421-833d-2c5e8d64ed00";
const DEP = "019ff7d1-0d12-7421-833d-2c5e8d64ed01";
const OTHER = "019ff7d1-0d12-7421-833d-2c5e8d64ed02";
const NODE = "019ff7d1-0d12-7421-833d-2c5e8d64ed03";
const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed04";

function terminal(id: string): CanvasNode {
  const now = "2026-09-04T10:00:00.000Z";
  return {
    id,
    boardId: BOARD,
    type: "terminal",
    title: id.slice(0, 4),
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    data: { kind: "terminal" },
    createdAt: now,
    updatedAt: now,
  } as CanvasNode;
}

function status(
  nodeId: string,
  partial: Partial<AgentStatus> = {},
): AgentStatus {
  return {
    nodeId,
    workspaceId: WORKSPACE,
    agentId: "claude",
    unread: false,
    verified: true,
    restored: false,
    updatedAt: "2026-09-04T10:00:00.000Z",
    ...partial,
  };
}

const ids = (...values: string[]) => new Set(values);

describe("dependency gate", () => {
  it("accepts a clean `done`", () => {
    expect(
      dependencySatisfied(DEP, ids(DEP), {
        [DEP]: status(DEP, { state: "done" }),
      }),
    ).toBe(true);
  });

  it("rejects a `done` that failed", () => {
    expect(
      dependencySatisfied(DEP, ids(DEP), {
        [DEP]: status(DEP, { state: "done", errored: true }),
      }),
    ).toBe(false);
  });

  it("treats an unknown state as not satisfied", () => {
    expect(dependencySatisfied(DEP, ids(DEP), {})).toBe(false);
    expect(dependencySatisfied(DEP, ids(DEP), { [DEP]: status(DEP) })).toBe(
      false,
    );
    expect(
      dependencySatisfied(DEP, ids(DEP), {
        [DEP]: status(DEP, { state: "working" }),
      }),
    ).toBe(false);
  });

  it("treats a deleted dependency as satisfied", () => {
    expect(dependencySatisfied(DEP, ids(OTHER), {})).toBe(true);
  });

  it("requires every dependency", () => {
    const nodes = [terminal(DEP), terminal(OTHER)];
    const statuses = { [DEP]: status(DEP, { state: "done" }) };
    expect(dependenciesSatisfied([DEP], nodes, statuses)).toBe(true);
    expect(dependenciesSatisfied([DEP, OTHER], nodes, statuses)).toBe(false);
    expect(dependenciesSatisfied([], nodes, statuses)).toBe(true);
  });
});

/* -------------------------- 发送、重试、手动运行 --------------------------- */

/**
 * 门与计时器都直接读两个 store；测试把它们置成需要的样子而不是去 mock
 * 模块，这样断言的是真实路径。看板文档只需要节点 id 与 `data.agent`。
 */
async function setBoard(nodes: CanvasNode[]) {
  const { useCanvasStore } = await import("../store/canvas-store");
  useCanvasStore.setState({
    document: {
      board: {
        id: BOARD,
        workspaceId: WORKSPACE,
        name: "Default",
        viewport: { x: 0, y: 0, zoom: 1 },
        createdAt: "2026-09-04T10:00:00.000Z",
        updatedAt: "2026-09-04T10:00:00.000Z",
      },
      nodes,
      edges: [],
    },
  } as never);
}

beforeEach(async () => {
  vi.useFakeTimers();
  resetPendingLaunches();
  useAgentStatusStore.getState().reset();
  await setBoard([terminal(DEP), terminal(NODE)]);
});

afterEach(() => {
  cleanup();
  resetPendingLaunches();
  vi.useRealTimers();
});

describe("pending launch", () => {
  it("waits for the dependency and then types the launch line once", () => {
    const send = vi.fn();
    // 真实路径：门由 store 订阅推动，而这个订阅挂在终端表面的 hook 上。
    renderHook(() => usePendingLaunchWatcher(NODE, true));
    act(() => {
      armPendingLaunch(NODE, { command: "codex 'go'", after: [DEP] }, send);
    });
    expect(send).not.toHaveBeenCalled();
    expect(usePendingLaunchStore.getState().entries[NODE]?.phase).toBe(
      "waiting",
    );

    // 依赖还在跑：门仍然关着。
    act(() => {
      useAgentStatusStore
        .getState()
        .upsert(status(DEP, { state: "working" }), { now: Date.now() });
    });
    expect(send).not.toHaveBeenCalled();

    act(() => {
      useAgentStatusStore
        .getState()
        .upsert(
          status(DEP, { state: "done", updatedAt: "2026-09-04T10:01:00.000Z" }),
          { now: Date.now(), selected: true, focused: true },
        );
    });
    expect(send).toHaveBeenCalledExactlyOnceWith("codex 'go'");
    expect(usePendingLaunchStore.getState().entries[NODE]).toEqual({
      phase: "sent",
      attempts: 1,
    });
    // rope 边在启动之后要继续画，所以依赖被记了下来。
    expect(usePendingLaunchStore.getState().launchedAfter[NODE]).toEqual([DEP]);
  });

  it("fires immediately when the dependency is already gone", () => {
    const send = vi.fn();
    armPendingLaunch(NODE, { command: "claude", after: [OTHER] }, send);
    expect(send).toHaveBeenCalledExactlyOnceWith("claude");
  });

  it("retries three times and then hands over to the ▶ button", () => {
    const send = vi.fn();
    armPendingLaunch(NODE, { command: "claude", after: [] }, send);
    expect(send).toHaveBeenCalledTimes(1);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      vi.advanceTimersByTime(STALL_TIMEOUT_MS);
    }
    expect(send).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    expect(usePendingLaunchStore.getState().entries[NODE]?.phase).toBe("sent");

    vi.advanceTimersByTime(STALL_TIMEOUT_MS);
    expect(send).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    expect(usePendingLaunchStore.getState().entries[NODE]?.phase).toBe(
      "manual",
    );

    // ▶：再敲一次，不再自动重试。
    runPendingLaunchNow(NODE);
    expect(send).toHaveBeenCalledTimes(2 + MAX_RETRIES);
    vi.advanceTimersByTime(STALL_TIMEOUT_MS * 4);
    expect(send).toHaveBeenCalledTimes(2 + MAX_RETRIES);
  });

  it("stops retrying once the node reports a status", () => {
    const send = vi.fn();
    armPendingLaunch(NODE, { command: "claude", after: [] }, send);
    useAgentStatusStore
      .getState()
      .upsert(status(NODE, { state: "working" }), { now: Date.now() });
    vi.advanceTimersByTime(STALL_TIMEOUT_MS * 4);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("forgets the timers on unmount but keeps the rope memory", () => {
    const send = vi.fn();
    armPendingLaunch(NODE, { command: "claude", after: [] }, send);
    disarmPendingLaunch(NODE);
    vi.advanceTimersByTime(STALL_TIMEOUT_MS * 4);
    expect(send).toHaveBeenCalledTimes(1);
    expect(usePendingLaunchStore.getState().entries[NODE]).toBeUndefined();
    expect(usePendingLaunchStore.getState().launchedAfter[NODE]).toEqual([]);
  });
});
