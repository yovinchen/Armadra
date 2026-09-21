import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { getContextLinks, putContextLinks } from "../canvas/context-links";
import { freeLease } from "../drive/lease";
import { listDeliveries } from "./deliveries";
import { controlDispatcher, type ControlOutcome } from "./control";
import { SILENT_PROBE_INTERVAL_MS, SendPump } from "./send-pump";
import { resetSendLimits } from "./send-limits";
import { pendingCountFor } from "./send-queue";

/**
 * 「启动时不上报」的 CLI 的首投（设计 `agent-delivery.md` §4.3）。
 *
 * 实测的那条失败是这样的：Codex 0.155.1 装了全部 hook，起到提示符**一条事件都
 * 不发**，于是它在 `agent_status` 里根本没有行；`targetState()` 对没有上报的
 * 节点答 `starting`，投递就永远停在 `queued / TARGET_STARTING`——主 Agent 开出
 * 的 Codex 一个都收不到任务。
 *
 * 这一批要证的是那条补救路只在**它该在**的地方开：标了旗、从未上报过、终端域
 * 说它安静、会话也不是刚起的那一瞬。少一个条件就不投。
 */

let fixture: AgentFixture;
let me: string;

/** 会话建立时刻往前挪，好让「会话不新」这一条成立。 */
function age(sessionId: string, ms: number): void {
  fixture.database
    .prepare("UPDATE terminal_sessions SET created_at = ? WHERE id = ?")
    .run(new Date(Date.now() - ms).toISOString(), sessionId);
}

/** 终端域说这个会话有多安静。 */
function quiet(sessionId: string, sinceMs: number, pending = false): void {
  fixture.terminal.activity.set(sessionId, {
    pending,
    lastInputAt: undefined,
    lastOutputAt: Date.now() - sinceMs,
  });
}

/**
 * 一个刚起来、什么都还没上报过的 Agent 节点，已经与调用者连了线。
 *
 * 返回它的 id 与会话 id。`stateSource` 显式给 `undefined`：这正是真机上那个
 * 节点的样子——有 PTY，没有任何一行 `agent_status`。
 */
function silentNode(agentId: string): { id: string; sessionId: string } {
  const id = fixture.agentNode(agentId, agentId);
  const sessionId = fixture.session(id, agentId);
  // 自己接一条线，而不是 `fixture.link`：那个助手是整份覆盖，第二个节点会把第
  // 一个节点的连线抹掉，而这一批里有一条用例同时要两个目标。
  putContextLinks(fixture.database, fixture.workspaceId, me, [
    ...getContextLinks(fixture.database, me).links.map((link) => ({
      id: link.id,
      title: link.title,
      kind: link.kind,
    })),
    { id, title: agentId, kind: "terminal" },
  ]);
  fixture.terminal.drive.set(id, {
    nodeId: id,
    sessionId,
    state: "starting",
    stateSource: undefined,
    lease: freeLease(0),
    driveGeneration: 0,
  } as never);
  return { id, sessionId };
}

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
  return outcome.body;
}

beforeEach(() => {
  resetSendLimits();
  fixture = agentFixture();
  me = fixture.agentNode("Caller");
  fixture.name(me, "planner");
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
});

describe("a CLI that reports nothing at startup", () => {
  it("投得出去：标了旗、没上报过、安静、会话也不新", async () => {
    const codex = silentNode("codex");
    fixture.terminal.foreground = { command: "codex" };

    // 第一次尝试：终端域还说不出它安静，所以排队。
    const queued = ok(
      await run(me, "send", { to: codex.id, body: "做这件事" }),
    );
    expect(queued).toMatchObject({
      outcome: "queued",
      reason: "TARGET_STARTING",
    });

    age(codex.sessionId, 10_000);
    quiet(codex.sessionId, 5_000);
    await new SendPump(() => fixture.collab).drain(codex.id);

    expect(fixture.terminal.submits).toHaveLength(1);
    expect(fixture.terminal.submits[0]?.data ?? "").toContain("做这件事");
    expect(pendingCountFor(fixture.database, codex.id, 0)).toBe(0);
    // 记录面板上看得出这一条是按观察放行的，而不是按一条上报。
    const recorded = listDeliveries(fixture.collab, fixture.workspaceId, 10);
    expect(recorded[0]).toMatchObject({
      outcome: "delivered",
      targetState: "observed-quiet",
    });
  });

  it("没标旗的 CLI 不走这条路：claude 没上报就是还没起来，等着", async () => {
    const claude = silentNode("claude");
    fixture.terminal.foreground = { command: "claude" };
    age(claude.sessionId, 10_000);
    quiet(claude.sessionId, 5_000);

    const queued = ok(
      await run(me, "send", { to: claude.id, body: "做这件事" }),
    );
    expect(queued).toMatchObject({
      outcome: "queued",
      reason: "TARGET_STARTING",
    });
    await new SendPump(() => fixture.collab).drain(claude.id);
    expect(fixture.terminal.submits).toHaveLength(0);
    expect(pendingCountFor(fixture.database, claude.id, 0)).toBe(1);
  });

  it("有半截没提交的行就不投：投进去就是拼接", async () => {
    const codex = silentNode("codex");
    fixture.terminal.foreground = { command: "codex" };
    age(codex.sessionId, 10_000);
    quiet(codex.sessionId, 5_000, true);

    ok(await run(me, "send", { to: codex.id, body: "做这件事" }));
    await new SendPump(() => fixture.collab).drain(codex.id);
    expect(fixture.terminal.submits).toHaveLength(0);
    expect(pendingCountFor(fixture.database, codex.id, 0)).toBe(1);
  });

  it("刚吐过东西照样投：Codex 的空闲屏一直在动，输出不是信号", async () => {
    const codex = silentNode("codex");
    fixture.terminal.foreground = { command: "codex" };
    age(codex.sessionId, 10_000);
    quiet(codex.sessionId, 500);

    ok(await run(me, "send", { to: codex.id, body: "做这件事" }));
    await new SendPump(() => fixture.collab).drain(codex.id);
    expect(fixture.terminal.submits).toHaveLength(1);
  });

  it("会话刚建起来也不投：那一瞬间「安静」恒成立", async () => {
    const codex = silentNode("codex");
    fixture.terminal.foreground = { command: "codex" };
    quiet(codex.sessionId, 5_000);
    // 不动 created_at：会话就是此刻建的。

    ok(await run(me, "send", { to: codex.id, body: "做这件事" }));
    await new SendPump(() => fixture.collab).drain(codex.id);
    expect(fixture.terminal.submits).toHaveLength(0);
  });

  it("已经上报过 busy 的 codex 不走这条路：它正在一轮里", async () => {
    const codex = silentNode("codex");
    fixture.terminal.foreground = { command: "codex" };
    age(codex.sessionId, 10_000);
    quiet(codex.sessionId, 5_000);
    fixture.terminal.drive.set(codex.id, {
      nodeId: codex.id,
      sessionId: codex.sessionId,
      state: "busy",
      stateSource: "hook",
      lease: freeLease(0),
      driveGeneration: 0,
    } as never);

    const queued = ok(
      await run(me, "send", { to: codex.id, body: "做这件事" }),
    );
    expect(queued).toMatchObject({ outcome: "queued", reason: "TARGET_BUSY" });
    await new SendPump(() => fixture.collab).drain(codex.id);
    expect(fixture.terminal.submits).toHaveLength(0);
  });
});

describe("the sweep's probe", () => {
  /** 这个节点已经上报过一条了（库里真的有行，泵读的就是它）。 */
  function reported(nodeId: string, agentId: string): void {
    fixture.database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, state_source, " +
          "unread, verified, restored, updated_at) VALUES (?, ?, ?, 'working', 'hook', 0, 1, 0, ?)",
      )
      .run(nodeId, fixture.workspaceId, agentId, new Date().toISOString());
  }

  it("只对「标了旗 + 从未上报过 + 队里有东西」的目标各试一次", async () => {
    const codex = silentNode("codex");
    const claude = silentNode("claude");
    fixture.terminal.foreground = { command: "codex" };
    ok(await run(me, "send", { to: codex.id, body: "给 codex" }));
    fixture.terminal.foreground = { command: "claude" };
    ok(await run(me, "send", { to: claude.id, body: "给 claude" }));

    const pump = new SendPump(() => fixture.collab);
    // 只有 codex 那一个被问到：claude 没标旗，排队项照常等它的第一条上报。
    expect(await pump.probeSilentStarters()).toBe(1);

    // 报过一条之后它就交回给事件驱动，探测不再碰它。
    reported(codex.id, "codex");
    expect(await pump.probeSilentStarters()).toBe(0);
  });

  it("清扫那把定时器就是它的触发源", async () => {
    const codex = silentNode("codex");
    fixture.terminal.foreground = { command: "codex" };
    ok(await run(me, "send", { to: codex.id, body: "做这件事" }));
    age(codex.sessionId, 10_000);
    quiet(codex.sessionId, 5_000);

    const pump = new SendPump(() => fixture.collab);
    // `sweep` 的返回值说的是过期，不是投递；投递发生在它捎带的那一次探测里。
    expect(pump.sweep()).toBe(0);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(fixture.terminal.submits).toHaveLength(1);
  });

  it("入队那一下推起快探：不用等 60 秒的清扫", async () => {
    const codex = silentNode("codex");
    fixture.terminal.foreground = { command: "codex" };
    const pump = new SendPump(() => fixture.collab);
    // 泵挂成 `nudge`，与 agent 域的装配一致。
    (fixture.collab as { nudge?: (nodeId: string) => void }).nudge = (nodeId) =>
      pump.noteQueued(nodeId);
    ok(await run(me, "send", { to: codex.id, body: "做这件事" }));
    // 入队时会话还太新，没投；快探已经转起来了。
    expect(fixture.terminal.submits).toHaveLength(0);
    age(codex.sessionId, 10_000);
    quiet(codex.sessionId, 5_000);
    await new Promise((resolve) => {
      setTimeout(resolve, SILENT_PROBE_INTERVAL_MS + 200);
    });
    expect(fixture.terminal.submits).toHaveLength(1);
    pump.stop();
  });
});
