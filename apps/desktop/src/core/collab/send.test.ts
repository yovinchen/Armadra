import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { freeLease } from "../drive/lease";
import { VERBS, controlDispatcher, type ControlOutcome } from "./control";
import { SendPump } from "./send-pump";
import { EDGE_MIN_INTERVAL_MS, resetSendLimits } from "./send-limits";
import {
  SEND_QUEUE_MAX_PER_TARGET,
  expireQueue,
  pendingCountFor,
} from "./send-queue";

/**
 * `send` 与那一队（设计 `agent-delivery.md` §11 的「阶段 C」测试栏）。
 *
 * 每一条都走 {@link import("./control").ControlDispatcher}，也就是 Hook 面认完
 * 人之后真正调用的那个入口——一条只在模块内部成立的规矩过不了这里。
 *
 * 终端是桩。要站起一个 PTY 才能检查「停在权限提示上的节点不会被写入」的用例是
 * 没人会写的用例，而桩上那两个数组（`submits` / `writes`）正好是这一批里最值得
 * 断言的东西：写进去了几次，以及写进去的是什么。
 */

let fixture: AgentFixture;
let me: string;
let peer: string;
let peerSession: string;

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
  if (!outcome.ok)
    throw new Error(`refused: ${outcome.code} ${outcome.message}`);
  return outcome.body;
}

function refusal(outcome: ControlOutcome): {
  status: number;
  code: string;
  message: string;
  detail?: Record<string, unknown>;
} {
  if (outcome.ok) {
    throw new Error(`expected a refusal, got ${JSON.stringify(outcome.body)}`);
  }
  return outcome;
}

/** 目标此刻的样子。桩答什么，门链就看见什么。 */
function target(
  patch: Partial<{
    state: string;
    stateSource: string;
    lease: ReturnType<typeof freeLease>;
  }>,
): void {
  fixture.terminal.drive.set(peer, {
    nodeId: peer,
    sessionId: peerSession,
    state: "idle",
    stateSource: "hook",
    lease: freeLease(0),
    driveGeneration: 0,
    ...patch,
  } as never);
}

async function send(
  args: Record<string, unknown> = {},
): Promise<ControlOutcome> {
  return run(me, "send", { to: peer, body: "做这件事", ...args });
}

beforeEach(() => {
  resetSendLimits();
  fixture = agentFixture();
  me = fixture.agentNode("Caller");
  peer = fixture.agentNode("Codex", "codex");
  peerSession = fixture.session(peer, "codex");
  fixture.link(me, peer);
  fixture.terminal.foreground = { command: "codex" };
  target({});
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
});

describe("the verb table", () => {
  it("carries send, outbox and cancel", () => {
    expect(VERBS).toContain("send");
    expect(VERBS).toContain("outbox");
    expect(VERBS).toContain("cancel");
  });
});

describe("the gate chain", () => {
  it("delivers into an idle linked peer, and the envelope names the sender", async () => {
    const body = ok(await send());
    expect(body).toMatchObject({
      ok: true,
      protocol: "armadra.delivery.v1",
      outcome: "delivered",
      targetState: "idle",
    });
    expect(fixture.terminal.submits).toHaveLength(1);
    const written = fixture.terminal.submits[0]?.data ?? "";
    // 信封五行的形状（§3.6）。nonce 每次铸造，所以断言的是结构而不是字节。
    expect(written).toMatch(/^--- ARMADRA MESSAGE \S+ ---\n/);
    expect(written).toContain(`from: Caller (${me})   via: Caller`);
    expect(written).toContain("\n做这件事\n");
    expect(written).toMatch(/--- END ARMADRA MESSAGE \S+ ---$/);
    // 驱动者说了自己是谁：阶段 B 的租约要靠它分辨「谁在驱动」。
    expect(fixture.terminal.submits[0]?.driver).toMatchObject({
      kind: "agent",
      nodeId: me,
    });
  });

  it("refuses an unlinked node with NOT_LINKED and names the two ways out", async () => {
    const stranger = fixture.agentNode("Stranger", "codex");
    const refused = refusal(await run(me, "send", { to: stranger, body: "x" }));
    expect(refused.code).toBe("NOT_LINKED");
    expect(refused.status).toBe(403);
    expect(refused.message).toContain("canvas post");
  });

  it("refuses a target that is not a terminal", async () => {
    const note = fixture.stickyNode("便签", "内容");
    fixture.link(me, note);
    const refused = refusal(await run(me, "send", { to: note, body: "x" }));
    expect(refused.code).toBe("TARGET_NOT_TERMINAL");
    expect(refused.status).toBe(400);
  });

  it("refuses a peer with no running session", async () => {
    fixture.database
      .prepare("UPDATE terminal_sessions SET status = 'exited' WHERE id = ?")
      .run(peerSession);
    const refused = refusal(await send());
    expect(refused.code).toBe("TARGET_GONE");
    expect(refused.status).toBe(404);
  });

  it("refuses when the foreground is no longer the agent the node claims", async () => {
    fixture.terminal.foreground = { command: "vim" };
    const refused = refusal(await send());
    expect(refused.code).toBe("TARGET_NOT_AGENT_PANE");
    expect(refused.status).toBe(409);
    expect(fixture.terminal.submits).toHaveLength(0);
  });

  it("refuses a peer whose state nobody reported, unless the caller insists", async () => {
    target({ stateSource: "observed" });
    const refused = refusal(await send());
    expect(refused.code).toBe("TARGET_STATE_UNVERIFIED");
    // --unverified 要求终端域真的说它安静了；说不出来就排队，不投。
    fixture.terminal.activity.set(peerSession, {
      pending: false,
      lastInputAt: 0,
      lastOutputAt: 0,
    });
    const body = ok(await send({ unverified: true, key: "k2" }));
    expect(body).toMatchObject({
      outcome: "delivered",
      targetState: "observed-quiet",
    });
  });

  it("refuses a body over the limit", async () => {
    const refused = refusal(await send({ body: "x".repeat(2001) }));
    expect(refused.code).toBe("BODY_TOO_LONG");
    expect(refused.status).toBe(400);
  });

  it("answers the same id for the same key and body, and refuses a changed one", async () => {
    const first = ok(await send({ key: "task-1" }));
    const again = ok(await send({ key: "task-1" }));
    expect(again).toMatchObject({ id: first.id, duplicate: true });
    // 一次重发不是一次新的投递。
    expect(fixture.terminal.submits).toHaveLength(1);
    const refused = refusal(await send({ key: "task-1", body: "另一段" }));
    expect(refused.code).toBe("KEY_CONFLICT");
  });

  it("refuses sending to yourself — a node is not in its own link document", async () => {
    const refused = refusal(await run(me, "send", { to: me, body: "x" }));
    expect(refused.code).toBe("NOT_LINKED");
  });
});

describe("a target stopped on a permission prompt", () => {
  /**
   * 设计 §4.5 的那条硬规矩：**任何参数组合下都不会被写入正文。** 三种组合各一
   * 条，因为这是这张表里唯一一条「写错了人无法撤销」的错误。
   */
  it("is queued by default, and nothing is written", async () => {
    target({ state: "awaiting-approval" });
    const body = ok(await send());
    expect(body).toMatchObject({
      outcome: "queued",
      reason: "TARGET_AWAITING_APPROVAL",
      targetState: "awaiting-approval",
    });
    expect(fixture.terminal.submits).toHaveLength(0);
  });

  it("is refused with --no-queue, and nothing is written", async () => {
    target({ state: "awaiting-approval" });
    const refused = refusal(await send({ "no-queue": true }));
    expect(refused.code).toBe("TARGET_AWAITING_APPROVAL");
    expect(refused.status).toBe(409);
    expect(fixture.terminal.submits).toHaveLength(0);
  });

  it("is refused with --interrupt, and not even an Escape is written", async () => {
    target({ state: "awaiting-approval" });
    const refused = refusal(await send({ interrupt: true }));
    expect(refused.code).toBe("TARGET_AWAITING_APPROVAL");
    // Escape 落在一个权限提示上的意思是「拒绝这次工具调用」——那也是替人做决定。
    expect(fixture.terminal.writes).toHaveLength(0);
    expect(fixture.terminal.submits).toHaveLength(0);
  });
});

describe("a busy target", () => {
  it("is queued by default with its position", async () => {
    target({ state: "busy" });
    const body = ok(await send());
    expect(body).toMatchObject({
      outcome: "queued",
      reason: "TARGET_BUSY",
      queuePosition: 1,
    });
    expect(pendingCountFor(fixture.database, peer, nowSeconds())).toBe(1);
  });

  it("is refused with --no-queue", async () => {
    target({ state: "busy" });
    const refused = refusal(await send({ "no-queue": true }));
    expect(refused.code).toBe("TARGET_BUSY");
    expect(pendingCountFor(fixture.database, peer, nowSeconds())).toBe(0);
  });

  it("falls back to the queue when --interrupt does not settle into idle", async () => {
    target({ state: "busy" });
    const body = ok(await send({ interrupt: true }));
    // Escape 发了一次，然后等不到 idle。
    expect(fixture.terminal.writes.map((entry) => entry.data)).toEqual([
      "\u001b",
    ]);
    expect(body).toMatchObject({ outcome: "queued", reason: "TARGET_BUSY" });
    expect(fixture.terminal.submits).toHaveLength(0);
  });

  it("delivers when --interrupt does settle into idle", async () => {
    target({ state: "busy" });
    let polls = 0;
    fixture.terminal.drive.set(peer, {
      nodeId: peer,
      sessionId: peerSession,
      get state() {
        polls += 1;
        return polls > 1 ? "idle" : "busy";
      },
      stateSource: "hook",
      lease: freeLease(0),
      driveGeneration: 0,
    } as never);
    const body = ok(await send({ interrupt: true }));
    expect(body).toMatchObject({ outcome: "delivered" });
    expect(fixture.terminal.submits).toHaveLength(1);
  });

  it("queues a starting target with its own reason", async () => {
    target({ state: "starting" });
    const body = ok(await send());
    expect(body).toMatchObject({
      outcome: "queued",
      reason: "TARGET_STARTING",
      targetState: "starting",
    });
  });
});

describe("the drive lease", () => {
  it("queues behind a person who is typing", async () => {
    target({
      lease: {
        state: "human",
        generation: 1,
        expiresAt: "",
        holder: { kind: "human", id: "device-1", displayName: "你" },
      },
    });
    const body = ok(await send());
    expect(body).toMatchObject({
      outcome: "queued",
      reason: "LEASE_HELD_BY_HUMAN",
    });
    expect(fixture.terminal.submits).toHaveLength(0);
  });

  it("refuses outright after a person took the terminal over", async () => {
    target({
      lease: {
        state: "humanTakeover",
        generation: 2,
        expiresAt: "",
        holder: { kind: "human", id: "device-1", displayName: "你" },
      },
    });
    const refused = refusal(await send());
    // 接管不自动恢复，所以排队没有意义：读 outbox 并告诉用户。
    expect(refused.code).toBe("LEASE_REVOKED");
    expect(pendingCountFor(fixture.database, peer, nowSeconds())).toBe(0);
  });

  it("queues behind another agent, but not behind itself", async () => {
    target({
      lease: {
        state: "agent",
        generation: 3,
        expiresAt: "",
        holder: { kind: "agent", id: "someone-else", displayName: "别人" },
      },
    });
    expect(ok(await send())).toMatchObject({
      outcome: "queued",
      reason: "LEASE_HELD_BY_AGENT",
    });
    target({
      lease: {
        state: "agent",
        generation: 4,
        expiresAt: "",
        holder: { kind: "agent", id: me, displayName: "Caller" },
      },
    });
    expect(ok(await send({ key: "mine" }))).toMatchObject({
      outcome: "delivered",
    });
  });
});

describe("the runaway gates", () => {
  it("refuses a second delivery on the same edge inside the window", async () => {
    ok(await send({ key: "one" }));
    const refused = refusal(await send({ key: "two" }));
    expect(refused.code).toBe("RATE_LIMITED");
    expect(refused.status).toBe(429);
    expect(
      Number((refused.detail as { retryAfterMs?: number }).retryAfterMs),
    ).toBeGreaterThan(0);
    expect(
      Number((refused.detail as { retryAfterMs?: number }).retryAfterMs),
    ).toBeLessThanOrEqual(EDGE_MIN_INTERVAL_MS);
  });

  it("stops a ring at the second hop", async () => {
    // A → B 投成了，于是 B 的来源链里有 A；B 再投回 A 就是一个环。
    ok(await send());
    const meSession = fixture.session(me, "claude");
    fixture.terminal.drive.set(me, {
      nodeId: me,
      sessionId: meSession,
      state: "idle",
      stateSource: "hook",
      lease: freeLease(0),
      driveGeneration: 0,
    } as never);
    fixture.terminal.foreground = { command: "claude" };
    const refused = refusal(await run(peer, "send", { to: me, body: "回敬" }));
    expect(refused.code).toBe("LOOP_DETECTED");
    expect(refused.status).toBe(409);
  });
});

describe("the queue", () => {
  it("stops at sixteen per target, and concurrent senders cannot overflow it", async () => {
    target({ state: "busy" });
    // 并发：容量检查与插入是同一条 SQL，所以二十条同时进来也只有十六条落进去。
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        send({ key: `k${index}` }),
      ),
    );
    const queued = outcomes.filter((outcome) => outcome.ok);
    const full = outcomes.filter(
      (outcome) => !outcome.ok && outcome.code === "QUEUE_FULL",
    );
    expect(queued).toHaveLength(SEND_QUEUE_MAX_PER_TARGET);
    expect(full).toHaveLength(20 - SEND_QUEUE_MAX_PER_TARGET);
    expect(pendingCountFor(fixture.database, peer, nowSeconds())).toBe(
      SEND_QUEUE_MAX_PER_TARGET,
    );
  });

  it("lists what is still waiting, and lets its sender cancel one", async () => {
    target({ state: "busy" });
    const queued = ok(await send());
    const listed = ok(await run(me, "outbox")) as {
      items: Record<string, unknown>[];
    };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: queued.id,
      to: peer,
      position: 1,
      reason: "TARGET_BUSY",
    });
    // 正文不进列表：列表说的是「有什么排着」，不是「排着的东西说了什么」。
    expect(JSON.stringify(listed.items[0])).not.toContain("做这件事");
    const cancelled = ok(await run(me, "cancel", { id: queued.id }));
    expect(cancelled).toMatchObject({ cancelled: true });
    expect(pendingCountFor(fixture.database, peer, nowSeconds())).toBe(0);
  });

  it("does not let one node cancel another node's delivery", async () => {
    target({ state: "busy" });
    const queued = ok(await send());
    const refused = refusal(await run(peer, "cancel", { id: queued.id }));
    expect(refused.status).toBe(404);
  });

  it("expires what waited longer than the TTL", async () => {
    target({ state: "busy" });
    ok(await send());
    // 五分钟之后：过期的那些不再排队，也不再出现在 outbox 里。
    const later = nowSeconds() + 301;
    expect(expireQueue(fixture.database, later)).toBe(1);
    expect(pendingCountFor(fixture.database, peer, later)).toBe(0);
  });
});

describe("dequeueing", () => {
  function pump(): SendPump {
    return new SendPump(() => fixture.collab);
  }

  it("delivers the queued message once the target reports idle", async () => {
    target({ state: "busy" });
    ok(await send());
    expect(fixture.terminal.submits).toHaveLength(0);
    target({ state: "idle" });
    await pump().drain(peer);
    expect(fixture.terminal.submits).toHaveLength(1);
    expect(pendingCountFor(fixture.database, peer, nowSeconds())).toBe(0);
  });

  it("re-runs the whole gate chain rather than only looking at the state", async () => {
    target({ state: "busy" });
    ok(await send());
    // 连线在这两分钟里被删掉了。出队不能因为「入队时是允许的」就放行。
    fixture.database
      .prepare("UPDATE context_links SET links_json = '[]' WHERE node_id = ?")
      .run(me);
    target({ state: "idle" });
    await pump().drain(peer);
    expect(fixture.terminal.submits).toHaveLength(0);
    expect(pendingCountFor(fixture.database, peer, nowSeconds())).toBe(0);
  });

  it("leaves it queued when the person is still holding the terminal", async () => {
    target({ state: "busy" });
    ok(await send());
    target({
      state: "idle",
      lease: {
        state: "human",
        generation: 1,
        expiresAt: "",
        holder: { kind: "human", id: "device-1", displayName: "你" },
      },
    });
    await pump().drain(peer);
    expect(fixture.terminal.submits).toHaveLength(0);
    expect(pendingCountFor(fixture.database, peer, nowSeconds())).toBe(1);
  });

  it("resumes when the person's lease expires, which reports no status at all", async () => {
    // 真机上撞到的那一条：人敲了一个键，租约抢占，排队项等下一次事件；而人停手
    // 十秒之后**目标什么都不会报**——它本来就空闲着。只听 `agent.status` 的话，
    // 这一条会等一个永远不来的事件。
    target({ state: "busy" });
    ok(await send());
    target({
      state: "idle",
      lease: {
        state: "human",
        generation: 1,
        expiresAt: "",
        holder: { kind: "human", id: "device-1", displayName: "你" },
      },
    });
    const driver = pump();
    await driver.drain(peer);
    expect(fixture.terminal.submits).toHaveLength(0);
    // 十秒过去，租约自己过期并广播一帧 `free`。
    target({ state: "idle", lease: freeLease(2) });
    driver.noteFree(peer);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(fixture.terminal.submits).toHaveLength(1);
  });

  it("is driven by the status event, not by a poll", async () => {
    target({ state: "busy" });
    ok(await send());
    target({ state: "idle" });
    const driver = pump();
    driver.noteStatus(peer, "done");
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(fixture.terminal.submits).toHaveLength(1);
  });
});

describe("a delivery that failed halfway", () => {
  it("answers unknown and is never retried", async () => {
    fixture.terminal.submitError = new Error("pty went away");
    const body = ok(await send());
    expect(body).toMatchObject({
      outcome: "unknown",
      retryable: false,
    });
    // 写了一半再写一遍是把「不知道」当成「安全」。
    expect(pendingCountFor(fixture.database, peer, nowSeconds())).toBe(0);
  });
});

describe("the delivery record", () => {
  it("writes a row and publishes an event, with the body's length and not its body", async () => {
    ok(await send());
    const rows = fixture.database
      .prepare(
        "SELECT source_node_id, target_node_id, outcome, body_chars FROM agent_deliveries",
      )
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_node_id: me,
      target_node_id: peer,
      outcome: "delivered",
      body_chars: 4,
    });
    const published = fixture.events.filter(
      (entry) => entry.event.type === "agent.delivery",
    );
    expect(published).toHaveLength(1);
    expect(published[0]?.event).toMatchObject({
      sourceNodeId: me,
      targetNodeId: peer,
      outcome: "delivered",
    });
  });

  it("publishes a queued delivery too", async () => {
    target({ state: "busy" });
    ok(await send());
    const published = fixture.events.filter(
      (entry) => entry.event.type === "agent.delivery",
    );
    expect(published[0]?.event).toMatchObject({ outcome: "queued" });
  });
});

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
