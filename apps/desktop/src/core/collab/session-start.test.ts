import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { sessionStartIdle } from "../agent/target-state";
import { putContextLinks } from "../canvas/context-links";
import { freeLease } from "../drive/lease";
import { listDeliveries } from "./deliveries";
import { controlDispatcher, type ControlOutcome } from "./control";
import { SendPump } from "./send-pump";
import { resetSendLimits } from "./send-limits";
import { pendingCountFor } from "./send-queue";

/**
 * 「只报过开场、还没开过一轮」的目标的首投（设计 `agent-delivery.md` §4.3）。
 *
 * 真机复现（`tools/probes/agent-e2e.mjs` 场景 2，Claude Code 2.1.260，页面挂
 * 着）：Claude 起来报一条 `SessionStart`，归约把状态清空，之后停在输入框上一条
 * 事件都不发。`targetState()` 对空状态答 `starting`，`send` 排进
 * `TARGET_STARTING` 之后再没有东西叫醒出队泵，两分钟后仍是 `attempts = 0`。
 */

let fixture: AgentFixture;
let me: string;

function age(sessionId: string, ms: number): void {
  fixture.database
    .prepare("UPDATE terminal_sessions SET created_at = ? WHERE id = ?")
    .run(new Date(Date.now() - ms).toISOString(), sessionId);
}

function quiet(sessionId: string, pending = false): void {
  fixture.terminal.activity.set(sessionId, {
    pending,
    lastInputAt: undefined,
    lastOutputAt: Date.now() - 500,
  });
}

/** 库里那一行：hook 报过开场，状态是空的——真机上 Claude 起来之后的样子。 */
function opened(
  nodeId: string,
  { phase = "start", restored = 0 }: { phase?: string; restored?: number } = {},
): void {
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, state_source, " +
        "unread, verified, restored, session_phase, session_id, updated_at) " +
        "VALUES (?, ?, 'claude', NULL, 'hook', 0, 1, ?, ?, 'prov-1', ?)",
    )
    .run(
      nodeId,
      fixture.workspaceId,
      restored,
      phase,
      new Date().toISOString(),
    );
}

/** 一个 Claude 节点，连好线，终端域答 `starting / hook`（与真机一致）。 */
function claudeNode(): { id: string; sessionId: string } {
  const id = fixture.agentNode("claude", "claude");
  const sessionId = fixture.session(id, "claude");
  putContextLinks(fixture.database, fixture.workspaceId, me, [
    { id, title: "claude", kind: "terminal" },
  ]);
  fixture.terminal.drive.set(id, {
    nodeId: id,
    sessionId,
    state: "starting",
    stateSource: "hook",
    lease: freeLease(0),
    driveGeneration: 0,
  } as never);
  fixture.terminal.foreground = { command: "claude" };
  return { id, sessionId };
}

async function run(
  verb: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  const outcome: ControlOutcome = await dispatcher.dispatch(
    verb,
    callerFor(fixture, me),
    args,
  );
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
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

describe("a CLI that has only reported its session start", () => {
  it("投得出去：开场之后停在输入框上，会话不新、没有半截的行", async () => {
    const claude = claudeNode();
    opened(claude.id);
    age(claude.sessionId, 10_000);
    quiet(claude.sessionId);

    const answer = await run("send", { to: claude.id, body: "做这件事" });
    expect(answer).toMatchObject({ outcome: "delivered", targetState: "idle" });
    expect(fixture.terminal.submits[0]?.data ?? "").toContain("做这件事");
    const recorded = listDeliveries(fixture.collab, fixture.workspaceId, 10);
    expect(recorded[0]).toMatchObject({
      outcome: "delivered",
      targetState: "idle",
    });
  });

  /**
   * 节能休眠接回来的会话：行还是原来那一行（`created_at` 是几分钟前），进程是
   * 刚起来的下一代。开场事件在界面铺开之前就到，按行的年龄算「够老」就当场放
   * 行，正文打进了还没铺开的输入框，回车丢了——2026-09-26 direct 后端端到端
   * 实测：`send` 唤醒的 Claude 投递记成 delivered，正文停在输入框里没提交。
   * 年龄要从这一代进程起来的时刻算。
   */
  it("接回来的下一代按它自己起来的时刻算年龄", async () => {
    const claude = claudeNode();
    opened(claude.id);
    age(claude.sessionId, 10 * 60_000);
    fixture.terminal.activity.set(claude.sessionId, {
      pending: false,
      lastInputAt: undefined,
      lastOutputAt: Date.now() - 500,
      startedAt: Date.now() - 1_000,
    });

    const queued = await run("send", { to: claude.id, body: "做这件事" });
    expect(queued).toMatchObject({
      outcome: "queued",
      reason: "TARGET_STARTING",
    });
    expect(fixture.terminal.submits).toHaveLength(0);
  });

  it("会话刚起来先排队，由快探在够老之后投出去", async () => {
    const claude = claudeNode();
    opened(claude.id);
    quiet(claude.sessionId);
    const pump = new SendPump(() => fixture.collab);
    (fixture.collab as { nudge?: (nodeId: string) => void }).nudge = (nodeId) =>
      pump.noteQueued(nodeId);

    const queued = await run("send", { to: claude.id, body: "做这件事" });
    expect(queued).toMatchObject({
      outcome: "queued",
      reason: "TARGET_STARTING",
    });
    expect(fixture.terminal.submits).toHaveLength(0);

    age(claude.sessionId, 10_000);
    // 开场之后不会再有事件：只有探测会再问它一次。
    expect(await pump.probeSilentStarters()).toBe(1);
    expect(fixture.terminal.submits).toHaveLength(1);
    expect(pendingCountFor(fixture.database, claude.id, 0)).toBe(0);
    pump.stop();
  });

  it("有半截的行、重启读回来的行、已结束的会话都不放行", async () => {
    const claude = claudeNode();
    age(claude.sessionId, 10_000);

    opened(claude.id, { restored: 1 });
    quiet(claude.sessionId);
    expect((await run("send", { to: claude.id, body: "一" })).outcome).toBe(
      "queued",
    );

    fixture.database
      .prepare("UPDATE agent_status SET restored = 0 WHERE node_id = ?")
      .run(claude.id);
    quiet(claude.sessionId, true);
    await new SendPump(() => fixture.collab).drain(claude.id);
    expect(fixture.terminal.submits).toHaveLength(0);

    fixture.database
      .prepare(
        "UPDATE agent_status SET session_phase = 'end' WHERE node_id = ?",
      )
      .run(claude.id);
    quiet(claude.sessionId);
    await new SendPump(() => fixture.collab).drain(claude.id);
    expect(fixture.terminal.submits).toHaveLength(0);
  });
});

describe("sessionStartIdle", () => {
  const status = {
    state: undefined,
    stateSource: "hook",
    sessionPhase: "start",
    restored: false,
  };
  const observed = {
    pending: false,
    lastInputAt: undefined,
    lastOutputAt: undefined,
  };

  it("四条都成立才放行", () => {
    expect(sessionStartIdle({ status, observed, sessionAgeMs: 7_000 })).toBe(
      true,
    );
    expect(sessionStartIdle({ status, observed, sessionAgeMs: 1_000 })).toBe(
      false,
    );
    expect(
      sessionStartIdle({
        status: { ...status, state: "done" },
        observed,
        sessionAgeMs: 7_000,
      }),
    ).toBe(false);
    expect(
      sessionStartIdle({
        status: { ...status, stateSource: "observed" },
        observed,
        sessionAgeMs: 7_000,
      }),
    ).toBe(false);
    expect(
      sessionStartIdle({ status: undefined, observed, sessionAgeMs: 7_000 }),
    ).toBe(false);
  });
});
