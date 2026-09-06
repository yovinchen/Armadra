import { beforeEach, describe, expect, it } from "vitest";
import type {
  CanvasNode,
  HostResources,
  SessionResources,
} from "@armadra/shared";

import { usePreferencesStore } from "@/app/preferences-store";
import {
  LOCAL_HOST,
  UNKNOWN,
  diskUsedPercent,
  executionHostOf,
  executionHosts,
  formatCount,
  formatLoad,
  formatMetricBytes,
  formatPercent,
  formatUptime,
  liveSessions,
  memoryUsedPercent,
  sessionsOnHost,
  sortSessions,
  unknownReasonKey,
} from "./metrics";

/**
 * T02 的一条硬规则：**测不出来是短横线，不是 0**（终端宿主设计 §8）。
 * 这份测试主要是钉住这一点，防止哪天有人「顺手」给个默认值。
 */

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
});

const host = (patch: Partial<HostResources> = {}): HostResources => ({
  hostId: "local",
  location: "local",
  platform: "macos",
  cpuPercent: 12.5,
  cpuCores: 10,
  memory: {
    totalBytes: 1_000,
    usedBytes: 400,
    availableBytes: 600,
    swapTotalBytes: 200,
    swapUsedBytes: 50,
    pressure: null,
  },
  loadAverage: { one: 1.234, five: 2, fifteen: 3 },
  disk: { mountPoint: "/", totalBytes: 1_000, availableBytes: 250 },
  power: { source: "ac", batteryPercent: null, charging: null },
  uptimeSeconds: 90_061,
  sampledAt: "2026-09-05T10:00:00+00:00",
  ...patch,
});

const session = (patch: Partial<SessionResources> = {}): SessionResources => ({
  sessionId: "s-1",
  sessionKey: "s-1",
  workspaceId: "w-1",
  nodeId: null,
  generation: 1,
  backend: "direct",
  location: "local",
  cwd: "/tmp",
  pid: 1,
  alive: true,
  cpuPercent: 10,
  memoryBytes: 1_024,
  memoryEstimated: true,
  childCount: 0,
  state: "runnable",
  startTimeUnixMs: 1_788_556_300_000,
  children: [],
  unknownReason: null,
  ...patch,
});

describe("未知指标", () => {
  it("null 与 undefined 都是短横线，绝不是 0", () => {
    expect(formatPercent(null)).toBe(UNKNOWN);
    expect(formatPercent(undefined)).toBe(UNKNOWN);
    expect(formatMetricBytes(null)).toBe(UNKNOWN);
    expect(formatCount(null)).toBe(UNKNOWN);
    expect(formatLoad(null)).toBe(UNKNOWN);
    expect(formatUptime(null, { day: "d", hour: "h", minute: "m" })).toBe(
      UNKNOWN,
    );
  });

  it("真的是 0 时照常显示 0，不要跟未知混为一谈", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatMetricBytes(0)).toBe("0 B");
    expect(formatCount(0)).toBe("0");
  });

  it("百分比保留一位小数，整数不带 .0", () => {
    expect(formatPercent(98.76)).toBe("98.8%");
    expect(formatPercent(50)).toBe("50%");
  });

  it("运行时长按天 / 时 / 分收敛", () => {
    const labels = { day: "d", hour: "h", minute: "m" };
    expect(formatUptime(90_061, labels)).toBe("1d 1h");
    expect(formatUptime(3_720, labels)).toBe("1h 2m");
    expect(formatUptime(120, labels)).toBe("2m");
  });
});

describe("推导出来的比例", () => {
  it("两个数都在才算得出来", () => {
    expect(memoryUsedPercent(host())).toBe(40);
    expect(diskUsedPercent(host())).toBe(75);
  });

  it("缺一个就是 null，而不是猜一个", () => {
    expect(
      memoryUsedPercent(
        host({
          memory: {
            totalBytes: 1_000,
            usedBytes: null,
            availableBytes: 600,
            swapTotalBytes: null,
            swapUsedBytes: null,
            pressure: null,
          },
        }),
      ),
    ).toBeNull();
    expect(diskUsedPercent(host({ disk: null }))).toBeNull();
    expect(
      diskUsedPercent(
        host({
          disk: { mountPoint: "/", totalBytes: null, availableBytes: 250 },
        }),
      ),
    ).toBeNull();
  });
});

describe("会话排序", () => {
  const titleOf = (row: SessionResources) => row.sessionId;

  it("按 CPU 从高到低，测不出来的排最后而不是当 0", () => {
    const rows = [
      session({ sessionId: "a", cpuPercent: 1 }),
      session({ sessionId: "b", cpuPercent: null, unknownReason: "remote" }),
      session({ sessionId: "c", cpuPercent: 90 }),
    ];
    expect(
      sortSessions(rows, "cpu", titleOf).map((row) => row.sessionId),
    ).toEqual(["c", "a", "b"]);
  });

  it("按内存同理", () => {
    const rows = [
      session({ sessionId: "a", memoryBytes: null }),
      session({ sessionId: "b", memoryBytes: 5 }),
      session({ sessionId: "c", memoryBytes: 50 }),
    ];
    expect(
      sortSessions(rows, "memory", titleOf).map((row) => row.sessionId),
    ).toEqual(["c", "b", "a"]);
  });

  it("按名称时用调用方给的标题", () => {
    const rows = [session({ sessionId: "b" }), session({ sessionId: "a" })];
    expect(
      sortSessions(rows, "name", titleOf).map((row) => row.sessionId),
    ).toEqual(["a", "b"]);
  });

  it("排序不改原数组", () => {
    const rows = [
      session({ sessionId: "a", cpuPercent: 1 }),
      session({ sessionId: "c", cpuPercent: 90 }),
    ];
    sortSessions(rows, "cpu", titleOf);
    expect(rows.map((row) => row.sessionId)).toEqual(["a", "c"]);
  });
});

describe("未知原因", () => {
  it("有数字时不给徽标，没数字时给出 i18n 键", () => {
    expect(unknownReasonKey(null)).toBeNull();
    expect(unknownReasonKey("remote")).toBe("resources.unknown.remote");
    expect(unknownReasonKey("no-pid")).toBe("resources.unknown.no-pid");
  });
});

describe("已经不在的会话", () => {
  it("退出的和进程找不到的都不进列表", () => {
    const rows = liveSessions([
      session({ sessionId: "live" }),
      session({ sessionId: "ended", alive: false, unknownReason: "exited" }),
      session({
        sessionId: "gone",
        memoryBytes: null,
        cpuPercent: null,
        unknownReason: "not-found",
      }),
    ]);
    expect(rows.map((row) => row.sessionId)).toEqual(["live"]);
  });

  it("远端、没有 pid 和刚起来的会话都留着——它们还在，只是测不到", () => {
    const rows = liveSessions([
      session({
        sessionId: "remote",
        location: "remote",
        unknownReason: "remote",
      }),
      session({ sessionId: "no-pid", pid: null, unknownReason: "no-pid" }),
      session({ sessionId: "warming", unknownReason: "warming-up" }),
    ]);
    expect(rows.map((row) => row.sessionId)).toEqual([
      "remote",
      "no-pid",
      "warming",
    ]);
  });
});

describe("执行主机", () => {
  const terminal = (id: string, hostId?: string): CanvasNode =>
    ({
      id,
      type: "terminal",
      title: "t",
      position: { x: 0, y: 0 },
      data: {
        kind: "terminal",
        ...(hostId ? { ssh: { hostId } } : {}),
      },
    }) as unknown as CanvasNode;

  it("节点上的 SSH 覆盖优先于工作空间的执行主机", () => {
    const row = session({ sessionId: "a", nodeId: "n-1", location: "remote" });
    expect(executionHostOf(row, [terminal("n-1", "build-box")], "ci-box")).toBe(
      "build-box",
    );
  });

  it("没有覆盖时跟随工作空间；工作空间也没有就是本机", () => {
    const row = session({ sessionId: "a", nodeId: "n-1" });
    expect(executionHostOf(row, [terminal("n-1")], "ci-box")).toBe("ci-box");
    expect(executionHostOf(row, [terminal("n-1")], "")).toBe(LOCAL_HOST);
  });

  it("远端会话说不出是哪台机器时是 null，而不是被算成本机", () => {
    const orphaned = session({
      sessionId: "a",
      nodeId: null,
      location: "remote",
    });
    expect(executionHostOf(orphaned, [], "")).toBeNull();
  });

  it("按主机过滤只留那台机器上的会话，未知单独成组", () => {
    const rows = [
      session({ sessionId: "local" }),
      session({ sessionId: "ssh", nodeId: "n-1", location: "remote" }),
      session({ sessionId: "orphan", nodeId: null, location: "remote" }),
    ];
    const nodes = [terminal("n-1", "build-box")];
    expect(executionHosts(rows, nodes, "")).toEqual([
      "build-box",
      LOCAL_HOST,
      null,
    ]);
    expect(
      sessionsOnHost(rows, "build-box", nodes, "").map((row) => row.sessionId),
    ).toEqual(["ssh"]);
    expect(
      sessionsOnHost(rows, null, nodes, "").map((row) => row.sessionId),
    ).toEqual(["orphan"]);
    expect(sessionsOnHost(rows, "all", nodes, "")).toHaveLength(3);
  });
});
