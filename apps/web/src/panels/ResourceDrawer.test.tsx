import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ResourceSnapshot } from "@armadra/shared";

const resources = vi.fn();
const subscribeResources = vi.fn();
const unsubscribeResources = vi.fn();
const terminateTerminal = vi.fn();
const adoptOrphanSession = vi.fn();
const terminateOrphanSession = vi.fn();
const acquirePowerLease = vi.fn();
const releasePowerLease = vi.fn();

vi.mock("@/api/client", () => ({
  runtimeApi: {
    resources: (...args: unknown[]) => resources(...args),
    subscribeResources: (...args: unknown[]) => subscribeResources(...args),
    unsubscribeResources: (...args: unknown[]) => unsubscribeResources(...args),
    terminateTerminal: (...args: unknown[]) => terminateTerminal(...args),
    adoptOrphanSession: (...args: unknown[]) => adoptOrphanSession(...args),
    terminateOrphanSession: (...args: unknown[]) =>
      terminateOrphanSession(...args),
    acquirePowerLease: (...args: unknown[]) => acquirePowerLease(...args),
    releasePowerLease: (...args: unknown[]) => releasePowerLease(...args),
  },
}));

import { ResourceDrawer } from "./ResourceDrawer";
import { usePreferencesStore } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";

/**
 * 面板的两条验收（T02，终端宿主设计 §8）：
 *
 *  1. **关着不采样。** 打开才订阅，关掉立刻退订——Runtime 的采样循环靠这个
 *     停下来。
 *  2. **测不出来显示短横线。** 结束的会话、SSH 会话不能显示成 0。
 */

const snapshot: ResourceSnapshot = {
  workspaceId: "w-1",
  host: {
    hostId: "local",
    location: "local",
    platform: "macos",
    cpuPercent: 31.7,
    cpuCores: 10,
    memory: {
      totalBytes: 34_359_738_368,
      usedBytes: 19_000_000_000,
      availableBytes: 14_647_967_744,
      swapTotalBytes: null,
      swapUsedBytes: null,
    },
    loadAverage: { one: 1.5, five: 1.2, fifteen: 1 },
    disk: {
      mountPoint: "/",
      totalBytes: 1_000_000,
      availableBytes: 250_000,
    },
    power: { source: "ac", batteryPercent: 100, charging: false },
    uptimeSeconds: 3_720,
    sampledAt: "2026-09-05T10:00:00+00:00",
  },
  sessions: [
    {
      sessionId: "s-busy",
      sessionKey: "s-busy",
      workspaceId: "w-1",
      nodeId: null,
      generation: 1,
      backend: "direct",
      location: "local",
      cwd: "/tmp/busy",
      pid: 100,
      alive: true,
      cpuPercent: 98.8,
      memoryBytes: 4_587_520,
      memoryEstimated: true,
      childCount: 1,
      state: "runnable",
      unknownReason: null,
    },
    {
      sessionId: "s-remote",
      sessionKey: "s-remote",
      workspaceId: "w-1",
      nodeId: null,
      generation: 1,
      backend: "direct",
      location: "remote",
      cwd: "/tmp/remote",
      pid: 200,
      alive: true,
      cpuPercent: null,
      memoryBytes: null,
      memoryEstimated: false,
      childCount: null,
      state: null,
      unknownReason: "remote",
    },
  ],
  orphans: [
    {
      id: "session:s-orphan",
      reason: "no-node",
      sessionId: "s-orphan",
      backendRef: "armadra-w1-orphan-1",
      workspaceId: "w-1",
      nodeId: "01a071e9-36e8-7972-8be3-21b9371868e6",
      sessionKey: "01a071e9-36e8-7972-8be3-21b9371868e6",
      cwd: "/tmp/lost",
      agentId: null,
      createdAt: "2026-09-05T09:00:00+00:00",
      lastOutputAt: null,
      adoptable: true,
    },
  ],
  power: {
    policy: "manual",
    holding: false,
    mechanism: null,
    inhibitor: {
      platform: "macos",
      kind: "caffeinate",
      available: true,
      detail: null,
    },
    leases: [],
  },
  intervalMs: 2_000,
  sampledAt: "2026-09-05T10:00:00+00:00",
};

beforeEach(() => {
  vi.clearAllMocks();
  resources.mockResolvedValue(snapshot);
  subscribeResources.mockResolvedValue({
    subscriptionId: "sub-1",
    workspaceId: "w-1",
    intervalMs: 2_000,
    expiresAt: "2026-09-05T10:00:06+00:00",
  });
  unsubscribeResources.mockResolvedValue(undefined);
  usePreferencesStore.setState({ locale: "zh-CN" });
  useCanvasStore.setState({
    workspace: {
      id: "w-1",
      name: "ws",
      rootPath: "/tmp",
      createdAt: "",
      updatedAt: "",
    } as never,
    panels: {
      sidebar: "collapsed",
      explorer: "closed",
      scm: "closed",
      resources: "closed",
      automation: "closed",
      usage: "closed",
      quickOpen: false,
      settings: false,
      palette: false,
    },
  });
});

afterEach(cleanup);

describe("ResourceDrawer", () => {
  it("关着的时候既不请求也不订阅", () => {
    render(<ResourceDrawer />);
    expect(resources).not.toHaveBeenCalled();
    expect(subscribeResources).not.toHaveBeenCalled();
  });

  it("打开后取一次快照并订阅采样", async () => {
    useCanvasStore.getState().setPanel("resources", "drawer");
    render(<ResourceDrawer />);
    await waitFor(() => expect(resources).toHaveBeenCalled());
    expect(resources.mock.calls[0]?.[0]).toBe("w-1");
    await waitFor(() =>
      expect(subscribeResources).toHaveBeenCalledWith("w-1", undefined),
    );
  });

  it("卸载时退订，Runtime 的采样循环才能停下来", async () => {
    useCanvasStore.getState().setPanel("resources", "drawer");
    const view = render(<ResourceDrawer />);
    await waitFor(() => expect(subscribeResources).toHaveBeenCalled());
    view.unmount();
    await waitFor(() =>
      expect(unsubscribeResources).toHaveBeenCalledWith("w-1", "sub-1"),
    );
  });

  it("主机总览显示真实数字，会话表把测不出来的显示成短横线", async () => {
    useCanvasStore.getState().setPanel("resources", "drawer");
    render(<ResourceDrawer />);

    await waitFor(() => expect(screen.getByText("31.7%")).toBeTruthy());
    // 40GB 总内存里用掉 19GB ≈ 55.3%
    expect(screen.getByText("55.3%")).toBeTruthy();
    // 内存没有 swap 数据：整格是短横线，不是 0 B。
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);

    // 远程会话：CPU 与内存两格都是短横线，并写明原因。
    expect(screen.getByText("在远程主机上运行，本机测不到指标")).toBeTruthy();
    expect(screen.getByText("98.8%")).toBeTruthy();
    expect(screen.queryByText("0 B")).toBeNull();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("孤立会话可以认领，并且用 Runtime 给的 nodeId 建节点", async () => {
    adoptOrphanSession.mockResolvedValue({
      sessionId: "s-orphan",
      nodeId: "01a071e9-36e8-7972-8be3-21b9371868e6",
      workspaceId: "w-1",
      cwd: "/tmp/lost",
      shell: "/bin/zsh",
      agentId: null,
      generation: 1,
    });
    useCanvasStore.getState().setPanel("resources", "drawer");
    render(<ResourceDrawer />);

    const button = await screen.findByRole("button", { name: "附着到新节点" });
    button.click();
    await waitFor(() =>
      expect(adoptOrphanSession).toHaveBeenCalledWith("w-1", "s-orphan"),
    );
  });

  it("终止孤立会话要先确认", async () => {
    useCanvasStore.getState().setPanel("resources", "drawer");
    render(<ResourceDrawer />);

    const button = await screen.findByRole("button", { name: "终止" });
    button.click();
    // 点一下只是弹确认框，不该直接打出请求。
    expect(terminateOrphanSession).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText("终止这个孤立会话？")).toBeTruthy(),
    );
  });

  it("手动开关只申请一份 manual 租约，并说明只挡空闲睡眠", async () => {
    acquirePowerLease.mockResolvedValue({
      id: "lease-1",
      source: "manual",
      reason: "用户在资源面板中手动开启",
      sessionId: null,
      workspaceId: null,
      createdAt: "2026-09-05T10:00:00+00:00",
      renewedAt: "2026-09-05T10:00:00+00:00",
      expiresAt: "2026-09-05T10:10:00+00:00",
      active: true,
      blockedBy: null,
    });
    useCanvasStore.getState().setPanel("resources", "drawer");
    render(<ResourceDrawer />);

    const scope = await screen.findByText(
      "只阻止系统空闲睡眠；不常亮屏幕，也不影响合盖或手动睡眠。",
    );
    expect(scope).toBeTruthy();

    const toggle = screen.getByRole("switch");
    toggle.click();
    await waitFor(() =>
      expect(acquirePowerLease).toHaveBeenCalledWith(
        expect.objectContaining({ source: "manual" }),
      ),
    );
    expect(releasePowerLease).not.toHaveBeenCalled();
  });
});
