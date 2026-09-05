import { describe, expect, it } from "vitest";
import {
  orphanSessionSchema,
  platformComponentSchema,
  powerLeaseRequestSchema,
  powerStateSchema,
  resourceSnapshotSchema,
  resourceSubscriptionSchema,
  sessionResourcesSchema,
  workspaceEventSchema,
} from "../src/index.js";

/**
 * T02 的两条契约（终端宿主设计 §8/§9）：
 *
 * 1. 取不到的指标是 `null`，不是 `0`——两者在界面上是完全不同的两句话。
 * 2. 被策略挡下的租约仍然要出现在列表里，只是 `active: false`。
 */

const sampledAt = "2026-09-05T10:00:00+00:00";

const host = {
  hostId: "local",
  location: "local" as const,
  platform: "macos",
  cpuPercent: 31.7,
  cpuCores: 10,
  memory: {
    totalBytes: 34359738368,
    usedBytes: 19_000_000_000,
    availableBytes: 14647967744,
    swapTotalBytes: 8589934592,
    swapUsedBytes: 7327449088,
  },
  loadAverage: { one: 16.1, five: 14.2, fifteen: 12.8 },
  disk: {
    mountPoint: "/",
    totalBytes: 994662584320,
    availableBytes: 134203822212,
  },
  power: { source: "ac" as const, batteryPercent: 100, charging: false },
  uptimeSeconds: 2677696,
  sampledAt,
};

const session = {
  sessionId: "01a071e9-36e8-7972-8be3-21b9371868e6",
  sessionKey: "01a071e9-36e8-7972-8be3-21b9371868e6",
  workspaceId: "01a071e6-f5e6-7ec2-a62e-d0bcb7b34d2e",
  nodeId: null,
  generation: 1,
  backend: "direct" as const,
  location: "local" as const,
  cwd: "/tmp/root",
  pid: 70922,
  alive: true,
  cpuPercent: 98.8,
  memoryBytes: 4587520,
  memoryEstimated: true,
  childCount: 1,
  state: "runnable",
  startTimeUnixMs: 1788556300000,
  children: [
    {
      pid: 70923,
      startTimeUnixMs: 1788556301000,
      name: "node",
      parentPid: 70922,
      memoryBytes: 1048576,
      cpuPercent: 12.5,
    },
  ],
  unknownReason: null,
};

const components = [
  {
    kind: "runtime" as const,
    process: {
      pid: 70900,
      startTimeUnixMs: 1788556200000,
      name: "armadra-runtime",
      parentPid: 1,
      memoryBytes: 41943040,
      cpuPercent: 1.2,
    },
    tree: false,
    childCount: null,
    children: [],
    unknownReason: null,
  },
  {
    kind: "commandWorker" as const,
    process: {
      pid: 70901,
      startTimeUnixMs: 1788556210000,
      name: "armadra-runtime",
      parentPid: 70890,
      memoryBytes: 12582912,
      cpuPercent: 0,
    },
    tree: true,
    childCount: 1,
    children: [
      {
        pid: 70902,
        startTimeUnixMs: 1788556211000,
        name: "rg",
        parentPid: 70901,
        memoryBytes: 2097152,
        cpuPercent: null,
      },
    ],
    unknownReason: null,
  },
];

const power = {
  policy: "manual" as const,
  holding: true,
  mechanism: "caffeinate",
  inhibitor: {
    platform: "macos",
    kind: "caffeinate",
    available: true,
    detail: null,
  },
  leases: [
    {
      id: "01a071ec-0aad-7252-887f-c3ae7edd93c6",
      source: "manual" as const,
      reason: "long build",
      sessionId: null,
      workspaceId: null,
      createdAt: sampledAt,
      renewedAt: sampledAt,
      expiresAt: "2026-09-05T10:05:00+00:00",
      active: true,
      blockedBy: null,
    },
  ],
};

const snapshot = {
  workspaceId: session.workspaceId,
  host,
  sessions: [session],
  components,
  orphans: [],
  power,
  intervalMs: 2000,
  sampledAt,
};

describe("资源采样", () => {
  it("接受完整的一次采样", () => {
    const parsed = resourceSnapshotSchema.parse(snapshot);
    expect(parsed.sessions[0]?.cpuPercent).toBe(98.8);
    expect(parsed.host.disk?.availableBytes).toBe(134203822212);
  });

  it("取不到的指标保留为 null，不折成 0", () => {
    const parsed = sessionResourcesSchema.parse({
      ...session,
      alive: false,
      cpuPercent: null,
      memoryBytes: null,
      memoryEstimated: false,
      childCount: null,
      state: null,
      unknownReason: "exited",
    });
    expect(parsed.cpuPercent).toBeNull();
    expect(parsed.memoryBytes).toBeNull();
    expect(parsed.childCount).toBeNull();
    expect(parsed.unknownReason).toBe("exited");
  });

  it("整台主机测不出来时也是 null", () => {
    const parsed = resourceSnapshotSchema.parse({
      ...snapshot,
      host: {
        ...host,
        cpuPercent: null,
        cpuCores: null,
        loadAverage: null,
        disk: null,
        uptimeSeconds: null,
        memory: {
          totalBytes: null,
          usedBytes: null,
          availableBytes: null,
          swapTotalBytes: null,
          swapUsedBytes: null,
        },
        power: { source: null, batteryPercent: null, charging: null },
      },
    });
    expect(parsed.host.cpuPercent).toBeNull();
    expect(parsed.host.memory.totalBytes).toBeNull();
    expect(parsed.host.power.source).toBeNull();
  });

  it("缺字段而不是给 null 的旧 Runtime 会被拒绝", () => {
    const { cpuPercent: _dropped, ...withoutCpu } = session;
    expect(sessionResourcesSchema.safeParse(withoutCpu).success).toBe(false);
  });

  it("SSH 会话标为 remote 且不带数字", () => {
    const parsed = sessionResourcesSchema.parse({
      ...session,
      location: "remote",
      cpuPercent: null,
      memoryBytes: null,
      memoryEstimated: false,
      childCount: null,
      state: null,
      unknownReason: "remote",
    });
    expect(parsed.location).toBe("remote");
    expect(parsed.memoryBytes).toBeNull();
  });

  it("平台组件与用户会话分开，进程按 pid + startTime 认身份", () => {
    const parsed = resourceSnapshotSchema.parse(snapshot);
    const runtime = parsed.components.find((it) => it.kind === "runtime")!;
    // Runtime 只算自己：它的子进程就是用户会话，已经各有各的行。
    expect(runtime.tree).toBe(false);
    expect(runtime.childCount).toBeNull();
    expect(parsed.sessions.map((it) => it.pid)).not.toContain(
      runtime.process.pid,
    );

    // 命令 Worker 反过来算整棵树，它跑的命令就是它存在的理由。
    const worker = parsed.components.find((it) => it.kind === "commandWorker")!;
    expect(worker.tree).toBe(true);
    expect(worker.children[0]?.name).toBe("rg");
    // 测得的 0 与测不出来是两句话，schema 两个都收。
    expect(worker.process.cpuPercent).toBe(0);
    expect(worker.children[0]?.cpuPercent).toBeNull();

    // 每个进程的身份是 pid + startTime，光看 pid 会把回收的号码认混。
    const keys = parsed.components.map(
      (it) => `${it.process.pid}:${it.process.startTimeUnixMs}`,
    );
    expect(new Set(keys).size).toBe(keys.length);

    expect(
      platformComponentSchema.safeParse({ ...runtime, kind: "browser" })
        .success,
    ).toBe(false);
  });

  it("会话带上进程树；列表被截断时 childCount 仍是真实总数", () => {
    const parsed = sessionResourcesSchema.parse(session);
    expect(parsed.children).toHaveLength(1);
    expect(parsed.children[0]?.parentPid).toBe(parsed.pid);
    expect(parsed.startTimeUnixMs).toBe(1788556300000);

    const truncated = sessionResourcesSchema.parse({
      ...session,
      childCount: 400,
      children: session.children,
    });
    // 空列表配非零 childCount 表示「没列出来」，不表示「没有子进程」。
    expect(truncated.childCount).toBe(400);
    expect(truncated.children.length).toBeLessThan(truncated.childCount!);
  });

  it("采样通过工作空间事件流推送", () => {
    const event = workspaceEventSchema.parse({
      type: "resource.sample",
      snapshot,
    });
    expect(event.type).toBe("resource.sample");
    if (event.type === "resource.sample") {
      expect(event.snapshot.intervalMs).toBe(2000);
    }
  });

  it("订阅回执带上生效间隔和过期时间", () => {
    const parsed = resourceSubscriptionSchema.parse({
      subscriptionId: "sub-1",
      workspaceId: session.workspaceId,
      intervalMs: 30000,
      effectiveIntervalMs: 2000,
      expiresAt: "2026-09-05T10:00:06+00:00",
    });
    // 自己按 30s 续约，看到的却是别人要来的 2s 采样。
    expect(parsed.intervalMs).toBe(30000);
    expect(parsed.effectiveIntervalMs).toBe(2000);
    expect(
      resourceSubscriptionSchema.safeParse({
        subscriptionId: "sub-1",
        workspaceId: session.workspaceId,
        intervalMs: 0,
        effectiveIntervalMs: 2000,
        expiresAt: sampledAt,
      }).success,
    ).toBe(false);
  });
});

describe("孤立会话", () => {
  it("有行的可以认领，没行的只能终止", () => {
    const withRow = orphanSessionSchema.parse({
      id: `session:${session.sessionId}`,
      reason: "no-node",
      sessionId: session.sessionId,
      backendRef: "armadra-01a071e6-1b9371868e6-1",
      workspaceId: session.workspaceId,
      nodeId: session.sessionKey,
      sessionKey: session.sessionKey,
      cwd: "/tmp/root",
      agentId: null,
      createdAt: sampledAt,
      lastOutputAt: null,
      adoptable: true,
    });
    expect(withRow.adoptable).toBe(true);

    const withoutRow = orphanSessionSchema.parse({
      id: "ref:armadra-aaaa-bbbb-1",
      reason: "no-row",
      sessionId: null,
      backendRef: "armadra-aaaa-bbbb-1",
      workspaceId: null,
      nodeId: null,
      sessionKey: null,
      cwd: null,
      agentId: null,
      createdAt: null,
      lastOutputAt: null,
      adoptable: false,
    });
    expect(withoutRow.adoptable).toBe(false);
    expect(withoutRow.sessionId).toBeNull();
  });
});

describe("防休眠租约", () => {
  it("被策略挡下的租约仍然在列表里，只是没生效", () => {
    const parsed = powerStateSchema.parse({
      ...power,
      policy: "never",
      holding: false,
      mechanism: null,
      leases: [{ ...power.leases[0]!, active: false, blockedBy: "policy" }],
    });
    expect(parsed.holding).toBe(false);
    expect(parsed.leases).toHaveLength(1);
    expect(parsed.leases[0]?.blockedBy).toBe("policy");
  });

  it("平台没有机制时报 unavailable 而不是假装生效", () => {
    const parsed = powerStateSchema.parse({
      ...power,
      holding: false,
      mechanism: null,
      inhibitor: {
        platform: "freebsd",
        kind: null,
        available: false,
        detail: "This platform has no sleep inhibitor implementation",
      },
      leases: [
        { ...power.leases[0]!, active: false, blockedBy: "unavailable" },
      ],
    });
    expect(parsed.inhibitor.available).toBe(false);
    expect(parsed.leases[0]?.blockedBy).toBe("unavailable");
  });

  it("申请租约必须给出原因", () => {
    expect(
      powerLeaseRequestSchema.safeParse({ source: "manual", reason: "" })
        .success,
    ).toBe(false);
    expect(
      powerLeaseRequestSchema.parse({
        source: "session",
        reason: "agent is working",
        sessionId: session.sessionId,
        ttlSeconds: 300,
      }).ttlSeconds,
    ).toBe(300);
  });

  it("只认这四种策略", () => {
    for (const policy of ["never", "agentSessions", "automation", "manual"]) {
      expect(powerStateSchema.safeParse({ ...power, policy }).success).toBe(
        true,
      );
    }
    expect(
      powerStateSchema.safeParse({ ...power, policy: "always" }).success,
    ).toBe(false);
  });
});
