import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resources = vi.fn();
const subscribeResources = vi.fn();
const unsubscribeResources = vi.fn();
let publish: ((event: unknown) => void) | null = null;

vi.mock("@/api/client", () => ({
  runtimeApi: {
    resources: (...args: unknown[]) => resources(...args),
    subscribeResources: (...args: unknown[]) => subscribeResources(...args),
    unsubscribeResources: (...args: unknown[]) => unsubscribeResources(...args),
  },
}));
vi.mock("@/api/events", () => ({
  onWorkspaceEvent: (_type: string, handler: (event: unknown) => void) => {
    publish = handler;
    return () => {
      publish = null;
    };
  },
}));

import {
  joinSampling,
  resetSampling,
  SLOW_INTERVAL_MS,
  type SamplingState,
} from "./sampling";

/**
 * 共享订阅的三条约束（路线图 §4.3）：
 *
 *  1. 一个工作空间只有**一份**订阅，不管有多少徽标和面板在看；
 *  2. 节奏取所有看客里最快的一档；
 *  3. 最后一个看客走掉才退订——Runtime 的采样循环靠这个停下来。
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  resetSampling();
  publish = null;
  resources.mockResolvedValue({ workspaceId: "w-1", sessions: [] });
  subscribeResources.mockImplementation(
    (_workspaceId: string, id: string | undefined) =>
      Promise.resolve({
        subscriptionId: id ?? "sub-1",
        workspaceId: "w-1",
        intervalMs: 60_000,
        effectiveIntervalMs: 2_000,
        expiresAt: "2026-09-05T10:00:06+00:00",
      }),
  );
  unsubscribeResources.mockResolvedValue(undefined);
});

afterEach(() => resetSampling());

describe("共享采样订阅", () => {
  it("十个看客只发一份订阅，样本广播给所有人", async () => {
    const seen: SamplingState[][] = [[], []];
    const first = joinSampling("w-1", "fast", (state) => seen[0]!.push(state));
    const second = joinSampling("w-1", "fast", (state) => seen[1]!.push(state));
    await flush();

    expect(subscribeResources).toHaveBeenCalledTimes(1);
    expect(resources).toHaveBeenCalledTimes(1);

    publish?.({ snapshot: { workspaceId: "w-1", sessions: [] } });
    expect(seen[0]!.at(-1)?.snapshot).toBeTruthy();
    expect(seen[1]!.at(-1)?.snapshot).toBeTruthy();

    first.leave();
    expect(unsubscribeResources).not.toHaveBeenCalled();
    second.leave();
    await flush();
    expect(unsubscribeResources).toHaveBeenCalledWith("w-1", "sub-1");
  });

  it("全是离屏看客时用 30 秒，来一个可见的就立刻改回快的", async () => {
    const badge = joinSampling("w-1", "slow", () => {});
    await flush();
    expect(subscribeResources).toHaveBeenLastCalledWith(
      "w-1",
      undefined,
      SLOW_INTERVAL_MS,
    );

    // 面板打开：节奏立刻变快，而不是等这份 30 秒的订阅到期。
    const panel = joinSampling("w-1", "fast", () => {});
    await flush();
    expect(subscribeResources).toHaveBeenLastCalledWith(
      "w-1",
      "sub-1",
      undefined,
    );

    // 面板关掉，只剩离屏徽标：回到慢的，而不是让快订阅一直续到过期。
    panel.leave();
    await flush();
    expect(subscribeResources).toHaveBeenLastCalledWith(
      "w-1",
      "sub-1",
      SLOW_INTERVAL_MS,
    );
    badge.leave();
  });

  it("节奏没变就不重发订阅", async () => {
    const handle = joinSampling("w-1", "fast", () => {});
    await flush();
    const calls = subscribeResources.mock.calls.length;
    handle.setCadence("fast");
    await flush();
    expect(subscribeResources.mock.calls.length).toBe(calls);
    handle.leave();
  });

  it("别的工作空间的样本不会串台", async () => {
    const seen: SamplingState[] = [];
    const handle = joinSampling("w-1", "fast", (state) => seen.push(state));
    await flush();
    const before = seen.length;
    publish?.({ snapshot: { workspaceId: "w-2", sessions: [] } });
    // 一条也不该广播出去：别人的样本不是这个工作空间的状态更新。
    expect(seen.length).toBe(before);
    handle.leave();
  });
});
