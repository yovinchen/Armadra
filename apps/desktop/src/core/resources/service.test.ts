import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EventBus, type WorkspaceEvent } from "../bus";
import { openDatabase, type OpenedDatabase } from "../db/open";
import { createWorkspace } from "../workspaces/table";
import {
  MAX_REQUESTED_INTERVAL_MS,
  MAX_SUBSCRIPTIONS,
  MIN_SUBSCRIPTION_TTL_MS,
  ResourceService,
} from "./service";
import { Sampler, type ProcessRow } from "./sample";
import { listOrphans, adoptOrphan, orphanTarget, OrphanError } from "./sessions";

const here = dirname(fileURLToPath(import.meta.url));

function row(pid: number, parent = 1): ProcessRow {
  return {
    pid,
    parent,
    rssBytes: 4096,
    cpuMs: 0,
    startTimeUnixMs: 1_000,
    state: "sleeping",
    name: "zsh",
    path: "/bin/zsh",
  };
}

interface Fixture {
  readonly db: OpenedDatabase;
  readonly bus: EventBus;
  readonly dataDir: string;
  readonly workspaceId: string;
  readonly events: { workspaceId: string; event: WorkspaceEvent }[];
  clock: number;
  watchers: number;
  service: ResourceService;
  close(): void;
}

function fixture(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-resources-"));
  const db = openDatabase({
    file: join(dataDir, "canvas.db"),
    migrationsDir: resolve(here, "../../../../runtime/migrations"),
    unifiedMigrationsDir: resolve(here, "../db/migrations"),
  });
  // 工作空间的 id 是库生成的；测试按它回填，而不是硬写一个。
  const workspace = createWorkspace(db.database, {
    name: "一",
    rootPath: dataDir,
  });
  const bus = new EventBus();
  const events: { workspaceId: string; event: WorkspaceEvent }[] = [];
  bus.on("workspace.event", (frame) => events.push(frame));
  const state = {
    db,
    bus,
    dataDir,
    workspaceId: workspace.id,
    events,
    clock: 1_000_000,
    watchers: 1,
    service: undefined as unknown as ResourceService,
    close() {
      state.service.stop();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  state.service = new ResourceService({
    database: db.database,
    settings: undefined,
    bus,
    dataDir,
    now: () => state.clock,
    audience: () => state.watchers,
    sampler: new Sampler(
      () => state.clock,
      () => new Map([[process.pid, row(process.pid)]]),
    ),
  });
  return state;
}

describe("资源采样的订阅", () => {
  let state: Fixture;

  beforeEach(() => {
    state = fixture();
  });

  afterEach(() => {
    state.close();
  });

  it("没有订阅时循环不跑", () => {
    expect(state.service.sampling()).toBe(false);
  });

  it("第一个订阅起循环，最后一个过期之后它自己停", async () => {
    const subscription = state.service.subscribe(state.workspaceId, {});
    expect(state.service.sampling()).toBe(true);
    state.service.unsubscribe(subscription.subscriptionId);
    // 循环在**下一拍**才发现没有订阅了，于是停掉自己——它不会在退订的那一刻被
    // 打断，因为一次已经安排好的采样不值得为此取消。
    await new Promise((done) => setTimeout(done, 2_100));
    expect(state.service.sampling()).toBe(false);
  });

  it("要求更慢的被满足，要求比设置更快的不被满足", () => {
    // 默认 2 s 是设置的下限，也是预算。
    expect(state.service.subscribe(state.workspaceId, { intervalMs: 500 }).intervalMs).toBe(
      2_000,
    );
    expect(
      state.service.subscribe(state.workspaceId, { intervalMs: 30_000 }).intervalMs,
    ).toBe(30_000);
    // 60 s 是上限，客户端没法停一个一小时采一次的订阅。
    expect(
      state.service.subscribe(state.workspaceId, { intervalMs: 3_600_000 }).intervalMs,
    ).toBe(MAX_REQUESTED_INTERVAL_MS);
  });

  it("循环按所有活订阅里最快的那个跑", () => {
    state.service.subscribe(state.workspaceId, { intervalMs: 30_000 });
    expect(state.service.effectiveInterval()).toBe(30_000);
    const fast = state.service.subscribe(state.workspaceId, { intervalMs: 2_000 });
    expect(state.service.effectiveInterval()).toBe(2_000);
    state.service.unsubscribe(fast.subscriptionId);
    expect(state.service.effectiveInterval()).toBe(30_000);
  });

  it("续订用同一个 id，过期的 id 换一个新的", () => {
    const first = state.service.subscribe(state.workspaceId, {});
    const renewed = state.service.subscribe(state.workspaceId, {
      subscriptionId: first.subscriptionId,
    });
    expect(renewed.subscriptionId).toBe(first.subscriptionId);
    state.clock += MIN_SUBSCRIPTION_TTL_MS + 1;
    const afterLapse = state.service.subscribe(state.workspaceId, {
      subscriptionId: first.subscriptionId,
    });
    expect(afterLapse.subscriptionId).not.toBe(first.subscriptionId);
  });

  it("订阅数有上限，满了复用最接近过期的那个", () => {
    const ids = new Set<string>();
    for (let index = 0; index < MAX_SUBSCRIPTIONS + 5; index += 1) {
      // 每个订阅的 TTL 一样，所以按插入顺序最早的那个最接近过期。
      state.clock += 1;
      ids.add(state.service.subscribe(state.workspaceId, {}).subscriptionId);
    }
    // 满了之后复用的是**已有**的那个 id，所以见过的 id 总数停在上限上，而不是
    // 继续长。
    expect(ids.size).toBe(MAX_SUBSCRIPTIONS);
    // 活着的从来不超过上限。
    expect(state.service.effectiveInterval()).toBe(2_000);
  });

  it("TTL 至少是下限，哪怕间隔很小", () => {
    const subscription = state.service.subscribe(state.workspaceId, { intervalMs: 2_000 });
    const ttl = Date.parse(subscription.expiresAt) - state.clock;
    expect(ttl).toBeGreaterThanOrEqual(MIN_SUBSCRIPTION_TTL_MS);
  });

  it("关掉的面板不再产生 resource.sample", async () => {
    state.service.subscribe(state.workspaceId, { intervalMs: 2_000 });
    // 有人连着：这一拍发出去。
    await new Promise((done) => setTimeout(done, 2_100));
    const withAudience = state.events.length;
    expect(withAudience).toBeGreaterThan(0);
    expect(state.events[0]?.event.type).toBe("resource.sample");

    // 没有人连着事件流了：订阅还在，但一帧都不该再发——采样本身才是那笔开销。
    state.watchers = 0;
    await new Promise((done) => setTimeout(done, 2_100));
    expect(state.events.length).toBe(withAudience);
  });

  it("快照带着这个工作空间的 id、主机那一段和电源策略", () => {
    const snapshot = state.service.snapshot(state.workspaceId);
    expect(snapshot.workspaceId).toBe(state.workspaceId);
    expect(snapshot.host.hostId).toBe("local");
    expect(snapshot.host.location).toBe("local");
    // 第一次采样没有基线，CPU 是 null 而不是零。
    expect(snapshot.host.cpuPercent).toBeNull();
    expect(snapshot.power.policy).toBe("manual");
    expect(snapshot.power.leases).toEqual([]);
    // core 自己那一行永远在。
    expect(snapshot.components.some((one) => one.kind === "runtime")).toBe(true);
  });
});

describe("孤立会话", () => {
  let state: Fixture;

  beforeEach(() => {
    state = fixture();
  });

  afterEach(() => {
    state.close();
  });

  function insertSession(options: {
    id: string;
    ownerNodeId: string | null;
    sessionKey?: string;
    backendRef?: string | null;
  }): void {
    state.db.database
      .prepare(
        "INSERT INTO terminal_sessions(id, workspace_id, session_key, kind, owner_node_id, cwd, shell, status, backend_kind, backend_ref, generation, attach_state, created_at) VALUES(?, ?, ?, 'terminal', ?, '/tmp', '/bin/zsh', 'running', 'tmux', ?, 1, 'live', '2026-09-01T00:00:00Z')",
      )
      .run(
        options.id,
        state.workspaceId,
        options.sessionKey ?? "6f1b4c2e-1111-7111-8111-111111111111",
        options.ownerNodeId,
        options.backendRef ?? `armadra-${options.id}`,
      );
  }

  it("节点被删掉的会话可以被认领，没有行的只能被终止", () => {
    insertSession({ id: "s-1", ownerNodeId: null });
    const orphans = listOrphans(state.db.database, state.workspaceId, [
      "armadra-stray-1",
      "armadra-s-1",
    ]);
    const byId = new Map(orphans.map((one) => [one.id, one]));
    expect(byId.get("session:s-1")?.adoptable).toBe(true);
    expect(byId.get("session:s-1")?.reason).toBe("no-node");
    expect(byId.get("ref:armadra-stray-1")?.adoptable).toBe(false);
    expect(byId.get("ref:armadra-stray-1")?.reason).toBe("no-row");
    // 这个会话已经有行了，所以它不会再作为「没有行」出现一次。
    expect(byId.has("ref:armadra-s-1")).toBe(false);
  });

  it("认领交回的节点 id 就是会话自己的 key", () => {
    insertSession({ id: "s-1", ownerNodeId: null });
    const adopted = adoptOrphan(state.db.database, state.workspaceId, "s-1");
    expect(adopted.nodeId).toBe("6f1b4c2e-1111-7111-8111-111111111111");
    expect(adopted.workspaceId).toBe(state.workspaceId);
    expect(adopted.cwd).toBe("/tmp");
  });

  it("另一个工作空间的会话不能被这里认领", () => {
    insertSession({ id: "s-1", ownerNodeId: null });
    expect(() => adoptOrphan(state.db.database, "ws-2", "s-1")).toThrow(
      OrphanError,
    );
  });

  it("key 不是 UUID 的行没有可用的节点身份", () => {
    insertSession({ id: "s-2", ownerNodeId: null, sessionKey: "hand-edited" });
    expect(() => adoptOrphan(state.db.database, state.workspaceId, "s-2")).toThrow(
      /node identity/,
    );
  });

  it("已经被另一个会话占着的节点不会被抢走", () => {
    insertSession({ id: "s-1", ownerNodeId: null });
    insertSession({
      id: "s-2",
      ownerNodeId: "6f1b4c2e-1111-7111-8111-111111111111",
      sessionKey: "6f1b4c2e-2222-7222-8222-222222222222",
    });
    expect(() => adoptOrphan(state.db.database, state.workspaceId, "s-1")).toThrow(
      /already owns/,
    );
  });

  it("孤立 id 只有两种形状，别的一律 400", () => {
    insertSession({ id: "s-1", ownerNodeId: null });
    expect(orphanTarget(state.db.database, state.workspaceId, "session:s-1")).toEqual({
      kind: "session",
      sessionId: "s-1",
    });
    expect(orphanTarget(state.db.database, state.workspaceId, "ref:armadra-x")).toEqual({
      kind: "ref",
      reference: "armadra-x",
    });
    // 一个任意的 pid 根本不能通过这条路寻址。
    expect(() => orphanTarget(state.db.database, state.workspaceId, "1234")).toThrow(
      /session:<id>/,
    );
  });
});
