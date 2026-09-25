import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ResourceSnapshot, SessionResources } from "@armadra/shared";

const resources = vi.fn();
const subscribeResources = vi.fn();
const unsubscribeResources = vi.fn();
const notify = vi.fn();
const toastWarning = vi.fn();

vi.mock("@/api/client", () => ({
  runtimeApi: {
    resources: (...args: unknown[]) => resources(...args),
    subscribeResources: (...args: unknown[]) => subscribeResources(...args),
    unsubscribeResources: (...args: unknown[]) => unsubscribeResources(...args),
  },
}));
vi.mock("@/platform", () => ({
  notify: (...args: unknown[]) => notify(...args),
}));
vi.mock("sonner", () => ({
  toast: { warning: (...args: unknown[]) => toastWarning(...args) },
}));

import { MemoryBadge } from "./MemoryBadge";
import { resetAlerts } from "./memory-alert";
import { resetSampling, SLOW_INTERVAL_MS } from "./sampling";
import { usePreferencesStore } from "@/app/preferences-store";

/**
 * 徽标的四条验收（路线图 §4.3）：
 *
 *  1. 显示进程树的内存，比如 `512 MB`；
 *  2. 测不出来显示 `unknown`，**不显示 0**；
 *  3. 越过阈值变色，并且**每个会话只提醒一次**；
 *  4. 节点不可见时把采样节奏降到 30 秒。
 */

const MB = 1024 * 1024;

const session = (patch: Partial<SessionResources> = {}): SessionResources => ({
  sessionId: "s-1",
  sessionKey: "s-1",
  workspaceId: "w-1",
  nodeId: "n-1",
  generation: 1,
  backend: "direct",
  location: "local",
  executionHostId: "local",
  cwd: "/tmp",
  pid: 100,
  alive: true,
  cpuPercent: 4,
  memoryBytes: 512 * MB,
  memoryEstimated: true,
  childCount: 1,
  state: "runnable",
  startTimeUnixMs: 1_788_556_300_000,
  children: [],
  unknownReason: null,
  ...patch,
});

const snapshot = (sessions: SessionResources[]): ResourceSnapshot =>
  ({
    workspaceId: "w-1",
    host: {} as never,
    executionHosts: [],
    sessions,
    components: [],
    orphans: [],
    power: {} as never,
    intervalMs: 2_000,
    sampledAt: "2026-09-05T10:00:00+00:00",
  }) as ResourceSnapshot;

beforeEach(() => {
  vi.clearAllMocks();
  resetSampling();
  resetAlerts();
  subscribeResources.mockResolvedValue({
    subscriptionId: "sub-1",
    workspaceId: "w-1",
    intervalMs: 2_000,
    effectiveIntervalMs: 2_000,
    expiresAt: "2026-09-05T10:00:06+00:00",
  });
  unsubscribeResources.mockResolvedValue(undefined);
  // 窗口在前台：提醒走应用内 toast，而不是系统通知。两条路都只走一次。
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  usePreferencesStore.setState({
    locale: "zh-CN",
    sessionMemoryWarnBytes: 2 * 1024 * MB,
  });
});

afterEach(() => {
  cleanup();
  resetSampling();
});

const mount = (props: Partial<React.ComponentProps<typeof MemoryBadge>> = {}) =>
  render(
    <MemoryBadge
      nodeId="n-1"
      workspaceId="w-1"
      sessionId="s-1"
      generation={1}
      visible
      {...props}
    />,
  );

describe("MemoryBadge", () => {
  it("显示进程树占用", async () => {
    resources.mockResolvedValue(snapshot([session()]));
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("memory-badge-n-1").textContent).toBe("512 MB"),
    );
  });

  it("测不出来显示 unknown，不是 0", async () => {
    resources.mockResolvedValue(
      snapshot([session({ memoryBytes: null, unknownReason: "warming-up" })]),
    );
    mount();
    const badge = await screen.findByTestId("memory-badge-n-1");
    await waitFor(() => expect(badge.textContent).toBe("unknown"));
    expect(badge.textContent).not.toContain("0");
    expect(badge.dataset.over).toBeUndefined();
  });

  it("换代之后不拿上一代的数字冒充当前占用", async () => {
    resources.mockResolvedValue(snapshot([session({ generation: 1 })]));
    mount({ generation: 2 });
    const badge = await screen.findByTestId("memory-badge-n-1");
    await waitFor(() => expect(badge.textContent).toBe("unknown"));
  });

  it("超过阈值变色，并且同一个会话只提醒一次", async () => {
    resources.mockResolvedValue(
      snapshot([session({ memoryBytes: 3_000 * MB })]),
    );
    const view = mount();
    await waitFor(() =>
      expect(screen.getByTestId("memory-badge-n-1").dataset.over).toBe("true"),
    );
    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));

    // 采样每隔几秒来一次，每一份都还在越线上——重挂一次也不该再提醒。
    view.unmount();
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("memory-badge-n-1").dataset.over).toBe("true"),
    );
    expect(toastWarning).toHaveBeenCalledTimes(1);
  });

  it("测不出来的内存不会触发提醒", async () => {
    resources.mockResolvedValue(
      snapshot([session({ memoryBytes: null, unknownReason: "no-pid" })]),
    );
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("memory-badge-n-1").textContent).toBe(
        "unknown",
      ),
    );
    // unknown 不是「超了」：为一个不存在的数字发通知是最糟的一种误报。
    expect(toastWarning).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("节点不可见时把采样降到 30 秒", async () => {
    resources.mockResolvedValue(snapshot([session()]));
    mount({ visible: false });
    await waitFor(() =>
      expect(subscribeResources).toHaveBeenCalledWith(
        "w-1",
        undefined,
        SLOW_INTERVAL_MS,
      ),
    );
  });

  it("可见的节点用设置里的那档，不传间隔", async () => {
    resources.mockResolvedValue(snapshot([session()]));
    mount();
    await waitFor(() =>
      expect(subscribeResources).toHaveBeenCalledWith(
        "w-1",
        undefined,
        undefined,
      ),
    );
  });
});
