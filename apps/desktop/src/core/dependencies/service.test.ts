import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { EventBus } from "../bus";
import { loadBoard } from "../canvas/documents";
import { controlDispatcher, type ControlOutcome } from "../collab/control";
import { resetSendLimits } from "../collab/send-limits";
import { pendingFor } from "../collab/send-queue";
import { resetInboxWake } from "../collab/wake";
import { Router } from "../http/router";
import { rfc3339 } from "../workspaces/support";
import { baselineFor, evaluate } from "./evaluate";
import { installRoutes } from "./index";
import { setDependencyService } from "./registry";
import { DependencyService } from "./service";
import { dependenciesOf, launchFor } from "./store";

/**
 * 依赖编排挪到 core 之后的验收（Agent 自动化设计 §6、§10「零客户端依赖启
 * 动」）。
 *
 * 这里没有页面：没有谁挂载节点、没有谁敲启动行。上游的状态直接写进
 * `agent_status` 再发一帧 `agent.status`——与 hook 上报走到这里时是同一个样子；
 * 终端桥是 fixture 的桩，`spawnForNode` 记下被起的终端并在 `terminal_sessions`
 * 里落一行，与终端域真起一个 shell 之后看到的一样。
 */

let fixture: AgentFixture;
let me: string;
let upstream: string;
let bus: EventBus;
let clock: number;
let service: DependencyService;
let spawned: { nodeId: string; agentId: string; cwd: string }[];

async function run(
  nodeId: string,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<ControlOutcome> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch(verb, callerFor(fixture, nodeId), args);
}

function ok(outcome: ControlOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    throw new Error(`refused: ${outcome.code} ${outcome.message}`);
  }
  return (outcome.body as { result: Record<string, unknown> }).result;
}

/** 上游报一次状态：写行，再发那一帧。时刻取当前的假时钟，每次往前走一秒。 */
function report(
  nodeId: string,
  state: string,
  verdict: { errored?: boolean; interrupted?: boolean } = {},
): void {
  clock += 1_000;
  const at = new Date(clock).toISOString();
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, " +
        "restored, last_event_at, errored, interrupted, updated_at) " +
        "VALUES (?, ?, 'codex', ?, 0, 1, 0, ?, ?, ?, ?) " +
        "ON CONFLICT(node_id) DO UPDATE SET state = excluded.state, " +
        "last_event_at = excluded.last_event_at, errored = excluded.errored, " +
        "interrupted = excluded.interrupted, updated_at = excluded.updated_at",
    )
    .run(
      nodeId,
      fixture.workspaceId,
      state,
      at,
      state === "done" ? (verdict.errored === true ? 1 : 0) : null,
      state === "done" ? (verdict.interrupted === true ? 1 : 0) : null,
      rfc3339(),
    );
  bus.emit("workspace.event", {
    workspaceId: fixture.workspaceId,
    event: {
      type: "agent.status",
      status: { nodeId, state },
    },
  });
}

/** 等服务里正在跑的启动落地。 */
async function settled(nodeId: string): Promise<void> {
  await service.maybeLaunch(nodeId);
  await new Promise((resolve) => setImmediate(resolve));
  await service.maybeLaunch(nodeId);
}

function startService(): DependencyService {
  const next = new DependencyService({
    database: fixture.database,
    collab: () => fixture.collab,
    bus,
    clock: () => clock,
    // 等提示符安静的那几秒：推时钟，不真的睡。
    delay: async (ms) => {
      clock += ms;
    },
    sweepEveryMs: false,
  });
  setDependencyService(next);
  next.start();
  return next;
}

async function openAfter(args: Record<string, unknown> = {}): Promise<string> {
  const body = ok(
    await run(me, "open-agent", {
      agent: "codex",
      title: "Reviewer",
      after: upstream,
      ...args,
    }),
  );
  return body.id as string;
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  fixture = agentFixture();
  me = fixture.agentNode("Planner");
  upstream = fixture.agentNode("Builder", "codex");
  bus = new EventBus();
  // 与协作域的 `nowSeconds` 同一条时间线：建边用的是它，过期比的是这个。
  clock = Date.now();
  spawned = [];
  fixture.terminal.bridge.spawnForNode = async (request) => {
    spawned.push({
      nodeId: request.nodeId,
      agentId: request.agentId,
      cwd: request.cwd,
    });
    const sessionId = fixture.session(request.nodeId, request.agentId);
    return { sessionId, generation: 1 };
  };
  service = startService();
});

afterEach(async () => {
  await service.stop();
  setDependencyService(undefined);
  fixture.close();
  resetSendLimits();
  resetInboxWake();
});

describe("服务端触发（没有页面）", () => {
  it("上游这一轮结束后，core 自己起终端、敲启动行、排第一条任务", async () => {
    report(upstream, "working");
    const created = await openAfter({ task: "复查 Builder 的改动" });

    // 还在等：没起终端，第一条任务也没进队列（排早了会在队列 TTL 里过期）。
    await settled(created);
    expect(spawned).toHaveLength(0);
    expect(pendingFor(fixture.database, created, 0)).toHaveLength(0);
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    const data = document.nodes.find((node) => node.id === created)?.data as {
      agent: Record<string, unknown>;
    };
    expect(data.agent.pendingLaunch).toBeUndefined();

    report(upstream, "done");
    await settled(created);

    expect(spawned).toEqual([
      expect.objectContaining({ nodeId: created, agentId: "codex" }),
    ]);
    // 启动行是一次写，带回车；正文不在这一行里，走的是投递队列。
    expect(fixture.terminal.writes).toHaveLength(1);
    expect(fixture.terminal.writes[0]?.data).toMatch(/codex.*\r$/);
    expect(fixture.terminal.writes[0]?.data).not.toContain("复查");
    const queued = pendingFor(fixture.database, created, 0);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.origin).toBe("first-task");
    expect(queued[0]?.sourceNodeId).toBe(me);
    expect(fixture.nudged).toContain(created);

    expect(launchFor(fixture.database, created)?.state).toBe("launched");
    expect(dependenciesOf(fixture.database, created)[0]?.state).toBe(
      "satisfied",
    );
    // 会话 id 记进节点数据：页面之后挂载时贴回这个 pane，不再起第二个。
    const after = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    ).nodes.find((node) => node.id === created)?.data as {
      sessionId?: string;
      agent: Record<string, unknown>;
    };
    expect(after.sessionId).toBe(
      launchFor(fixture.database, created)?.sessionId,
    );
    expect(typeof after.sessionId).toBe("string");
    expect(after.agent.initialCommand).toMatch(/codex/);
  });

  it("节点已经有终端（页面开着）就往那个 shell 里敲，不再起一个", async () => {
    report(upstream, "working");
    const created = await openAfter();
    const sessionId = fixture.session(created, "codex");
    fixture.terminal.foreground = { command: "-zsh", children: [] };

    report(upstream, "done");
    await settled(created);

    expect(spawned).toHaveLength(0);
    expect(fixture.terminal.writes).toEqual([
      expect.objectContaining({ sessionId }),
    ]);
    expect(launchFor(fixture.database, created)?.state).toBe("launched");
  });

  it("上游早已干净地做完，current 当场放行", async () => {
    report(upstream, "done");
    const created = await openAfter();
    await settled(created);
    expect(spawned).toHaveLength(1);
    expect(launchFor(fixture.database, created)?.state).toBe("launched");
  });

  it("next 不认创建之前的 done：旧结束重放也不会启动", async () => {
    report(upstream, "done");
    const created = await openAfter({ "after-turn": "next" });
    await settled(created);
    expect(spawned).toHaveLength(0);

    // 同一行再广播一次（重连、读回执都会这样）：仍然是那条旧 done。
    bus.emit("workspace.event", {
      workspaceId: fixture.workspaceId,
      event: { type: "agent.status", status: { nodeId: upstream } },
    });
    await settled(created);
    expect(spawned).toHaveLength(0);

    report(upstream, "working");
    report(upstream, "done");
    await settled(created);
    expect(spawned).toHaveLength(1);

    // 满足一次之后，上游再结束多少次都不会再启动一遍。
    report(upstream, "working");
    report(upstream, "done");
    await settled(created);
    expect(spawned).toHaveLength(1);
    expect(fixture.terminal.writes).toHaveLength(1);
  });

  it("多个上游：全部满足才启动", async () => {
    const second = fixture.agentNode("Tester", "codex");
    report(upstream, "working");
    report(second, "working");
    const created = ok(
      await run(me, "open-agent", {
        agent: "codex",
        after: [upstream, second],
      }),
    ).id as string;
    report(upstream, "done");
    await settled(created);
    expect(spawned).toHaveLength(0);
    report(second, "done");
    await settled(created);
    expect(spawned).toHaveLength(1);
  });
});

describe("失败、退出与删除不放行", () => {
  it("current：上游这一轮失败，边是 failed，下游不启动", async () => {
    report(upstream, "working");
    const created = await openAfter();
    report(upstream, "done", { errored: true });
    await settled(created);
    expect(spawned).toHaveLength(0);
    expect(dependenciesOf(fixture.database, created)[0]).toMatchObject({
      state: "failed",
      reason: "upstreamFailed",
    });
  });

  it("current：被中断也不算完成", async () => {
    report(upstream, "working");
    const created = await openAfter();
    report(upstream, "done", { interrupted: true });
    await settled(created);
    expect(dependenciesOf(fixture.database, created)[0]?.state).toBe("failed");
    expect(spawned).toHaveLength(0);
  });

  it("next：失败的一轮不放行，继续等下一次成功", async () => {
    report(upstream, "working");
    const created = await openAfter({ "after-turn": "next" });
    report(upstream, "done", { errored: true });
    await settled(created);
    expect(spawned).toHaveLength(0);
    expect(dependenciesOf(fixture.database, created)[0]).toMatchObject({
      state: "waiting",
      reason: "upstreamFailed",
    });
    report(upstream, "working");
    report(upstream, "done");
    await settled(created);
    expect(spawned).toHaveLength(1);
  });

  it("上游的终端退出了：还在等的边转 failed", async () => {
    report(upstream, "working");
    const created = await openAfter();
    bus.emit("workspace.event", {
      workspaceId: fixture.workspaceId,
      event: { type: "terminal.exit", sessionId: "gone", nodeId: upstream },
    });
    await settled(created);
    expect(dependenciesOf(fixture.database, created)[0]).toMatchObject({
      state: "failed",
      reason: "upstreamExited",
    });
    expect(spawned).toHaveLength(0);
  });

  it("上游被删掉是 missing，不当成功", async () => {
    report(upstream, "working");
    const created = await openAfter();
    fixture.database.prepare("DELETE FROM nodes WHERE id = ?").run(upstream);
    await service.sweep();
    await settled(created);
    expect(dependenciesOf(fixture.database, created)[0]?.state).toBe("missing");
    expect(spawned).toHaveLength(0);
  });

  it("下游被删掉：它的启动与边一起清掉", async () => {
    report(upstream, "working");
    const created = await openAfter();
    fixture.database.prepare("DELETE FROM nodes WHERE id = ?").run(created);
    await service.sweep();
    expect(launchFor(fixture.database, created)).toBeUndefined();
    expect(dependenciesOf(fixture.database, created)).toHaveLength(0);
  });
});

describe("TTL", () => {
  it("等过了期是 expired，之后上游做完也不启动", async () => {
    report(upstream, "working");
    const created = await openAfter({ ttl: 5 });
    clock += 6 * 60_000;
    await service.sweep();
    expect(dependenciesOf(fixture.database, created)[0]).toMatchObject({
      state: "expired",
      reason: "ttl",
    });
    report(upstream, "done");
    await settled(created);
    expect(spawned).toHaveLength(0);
  });

  it("--ttl 只收合理的整数分钟", async () => {
    const outcome = await run(me, "open-agent", {
      agent: "codex",
      after: upstream,
      ttl: "0",
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("取消与列出（路由）", () => {
  let router: Router;

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const url = new URL(path, "http://core");
    const encoded = Buffer.from(body === undefined ? "" : JSON.stringify(body));
    const answer = await router.dispatch(method, url.pathname, {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: {},
      body: encoded,
      raw: undefined as never,
      json: <T>() => JSON.parse(encoded.toString("utf8")) as T,
    });
    return answer as { status: number; body: Record<string, unknown> };
  }

  beforeEach(() => {
    router = new Router();
    installRoutes(router, fixture.database);
  });

  it("列出还在等的下游，camelCase，带上游的名字", async () => {
    report(upstream, "working");
    const created = await openAfter();
    const listed = await call(
      "GET",
      `/api/workspaces/${fixture.workspaceId}/dependencies`,
    );
    expect(listed.status).toBe(200);
    const launches = listed.body.launches as Record<string, unknown>[];
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      nodeId: created,
      state: "waiting",
      hasTask: false,
    });
    expect(
      (launches[0]?.dependencies as Record<string, unknown>[])[0],
    ).toMatchObject({
      upstreamNodeId: upstream,
      upstreamTitle: "Builder",
      condition: "current",
      state: "waiting",
      baseline: { state: "working" },
    });
  });

  it("取消最后一条挡路的边：下游当场启动，之后不再出现在列表里", async () => {
    report(upstream, "working");
    const created = await openAfter();
    const id = dependenciesOf(fixture.database, created)[0]?.id as string;
    const cancelled = await call(
      "DELETE",
      `/api/workspaces/${fixture.workspaceId}/dependencies/${id}`,
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.dependency).toMatchObject({ state: "cancelled" });
    await settled(created);
    expect(spawned).toHaveLength(1);
    const listed = await call(
      "GET",
      `/api/workspaces/${fixture.workspaceId}/dependencies`,
    );
    expect(listed.body.launches).toEqual([]);
    // 取消是终态：上游之后做完什么都不会发生。
    report(upstream, "done");
    await settled(created);
    expect(spawned).toHaveLength(1);
  });

  it("失败的边可以取消，取消了才放行", async () => {
    report(upstream, "working");
    const created = await openAfter();
    report(upstream, "done", { errored: true });
    await settled(created);
    const id = dependenciesOf(fixture.database, created)[0]?.id as string;
    await call(
      "DELETE",
      `/api/workspaces/${fixture.workspaceId}/dependencies/${id}`,
    );
    await settled(created);
    expect(spawned).toHaveLength(1);
  });

  it("别的工作空间的 id 是 404", async () => {
    report(upstream, "working");
    const created = await openAfter();
    const id = dependenciesOf(fixture.database, created)[0]?.id as string;
    const refused = await call(
      "DELETE",
      `/api/workspaces/elsewhere/dependencies/${id}`,
    );
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({ code: "not_found" });
  });

  it("旧 pendingLaunch 迁入：建成依赖行，重复迁入不重复建", async () => {
    report(upstream, "working");
    const legacy = fixture.agentNode("Legacy", "codex");
    const first = await call(
      "POST",
      `/api/workspaces/${fixture.workspaceId}/dependencies`,
      { nodeId: legacy, after: [upstream, "deleted-long-ago"] },
    );
    expect(first.status).toBe(200);
    expect(dependenciesOf(fixture.database, legacy)).toHaveLength(1);
    const again = await call(
      "POST",
      `/api/workspaces/${fixture.workspaceId}/dependencies`,
      { nodeId: legacy, after: [upstream] },
    );
    expect(again.status).toBe(200);
    expect(dependenciesOf(fixture.database, legacy)).toHaveLength(1);
    report(upstream, "done");
    await settled(legacy);
    expect(spawned.map((entry) => entry.nodeId)).toEqual([legacy]);
  });

  it("旧数据里的上游都不在了：按旧语义当场启动", async () => {
    const legacy = fixture.agentNode("Legacy", "codex");
    await call("POST", `/api/workspaces/${fixture.workspaceId}/dependencies`, {
      nodeId: legacy,
      after: ["deleted-long-ago"],
    });
    await settled(legacy);
    expect(spawned.map((entry) => entry.nodeId)).toEqual([legacy]);
  });
});

describe("core 重启后恢复", () => {
  it("停机期间上游做完了：新服务的第一遍扫描补判并启动", async () => {
    report(upstream, "working");
    const created = await openAfter({ task: "接着做" });
    await service.stop();

    // core 不在的时候那一次 done 进了库，但没有人听见那一帧。
    clock += 1_000;
    fixture.database
      .prepare(
        "UPDATE agent_status SET state = 'done', errored = 0, interrupted = 0, " +
          "last_event_at = ? WHERE node_id = ?",
      )
      .run(new Date(clock).toISOString(), upstream);

    service = startService();
    await service.sweep();
    await settled(created);
    expect(spawned).toHaveLength(1);
    expect(pendingFor(fixture.database, created, 0)).toHaveLength(1);
  });

  it("启动写完行后没来得及落账就重启：前台已经是这个 Agent，不敲第二遍", async () => {
    report(upstream, "working");
    const created = await openAfter({ task: "接着做" });
    report(upstream, "done");
    await settled(created);
    expect(fixture.terminal.writes).toHaveLength(1);

    // 模拟「写完了、记账之前被杀」：把启动退回等待。
    fixture.database
      .prepare(
        "UPDATE agent_dependency_launches SET state = 'waiting' WHERE node_id = ?",
      )
      .run(created);
    await service.stop();
    fixture.terminal.foreground = { command: "codex" };
    service = startService();
    await service.sweep();
    await settled(created);

    expect(fixture.terminal.writes).toHaveLength(1);
    expect(launchFor(fixture.database, created)?.state).toBe("launched");
    // 第一条任务有幂等键：重来一遍也只有一条。
    expect(pendingFor(fixture.database, created, 0)).toHaveLength(1);
  });
});

describe("判定（纯函数）", () => {
  const edge = {
    id: "d",
    workspaceId: "w",
    downstreamNodeId: "b",
    upstreamNodeId: "a",
    condition: "current" as const,
    baselineState: "done",
    baselineEventAt: "2026-09-25T08:00:00.000Z",
    observedBusy: false,
    state: "waiting" as const,
    reason: null,
    createdAt: 0,
    updatedAt: 0,
    expiresAt: 0,
    resolvedAt: null,
  };
  const status = (fields: Record<string, unknown>) =>
    ({
      nodeId: "a",
      workspaceId: "w",
      agentId: "codex",
      unread: false,
      verified: true,
      restored: false,
      updatedAt: "",
      ...fields,
    }) as never;

  it("没报过状态的上游不算完成", () => {
    expect(evaluate(edge, { exists: true }).kind).toBe("wait");
    expect(baselineFor("current", undefined).satisfied).toBe(false);
  });

  it("基准那一条 done 不是新的结束", () => {
    expect(
      evaluate(edge, {
        exists: true,
        status: status({
          state: "done",
          lastEventAt: "2026-09-25T08:00:00.000Z",
        }),
      }).kind,
    ).toBe("wait");
  });

  it("基准之后见过忙，时刻没挪的 done（过期扫描）也算这一轮结束", () => {
    expect(
      evaluate(
        { ...edge, observedBusy: true },
        {
          exists: true,
          status: status({
            state: "done",
            lastEventAt: "2026-09-25T08:00:00.000Z",
          }),
        },
      ).kind,
    ).toBe("satisfied");
  });

  it("error 状态是失败", () => {
    expect(
      evaluate(
        { ...edge, observedBusy: true },
        { exists: true, status: status({ state: "error" }) },
      ),
    ).toEqual({ kind: "failed", reason: "upstreamFailed" });
  });
});
