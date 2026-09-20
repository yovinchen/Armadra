import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { freeLease } from "../drive/lease";
import { controlDispatcher, type ControlOutcome } from "./control";
import { SendPump } from "./send-pump";
import { resetSendLimits } from "./send-limits";
import { pendingFor } from "./send-queue";
import { DEFAULT_INBOX_WAKE, INBOX_WAKE_MODES, resetInboxWake } from "./wake";
import { INBOX_WAKE_MODES as DOCUMENT_WAKE_MODES } from "../canvas/validation";

/**
 * 收件箱唤醒（设计 `agent-delivery.md` §5 与 §11 的「阶段 D」测试栏）。
 *
 * 唤醒不是第二条投递通道，所以这里断言的几乎都是「它和 `send` 是同一条路」：
 * 同一张队列表、同一道容量、同一条门链、同一个 `writeSubmit`。真正只属于它的
 * 规矩只有三条——三档设置、同一批未读只提示一次、`deliver` 不替人 `ack`。
 */

let fixture: AgentFixture;
let sender: string;
let sleeper: string;
let sleeperSession: string;

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

function pump(): SendPump {
  return new SendPump(() => fixture.collab);
}

/** 目标此刻的样子；桩答什么，唤醒与门链就看见什么。 */
function target(patch: Record<string, unknown> = {}): void {
  fixture.terminal.drive.set(sleeper, {
    nodeId: sleeper,
    sessionId: sleeperSession,
    state: "idle",
    stateSource: "hook",
    lease: freeLease(0),
    driveGeneration: 0,
    ...patch,
  } as never);
}

/** 节点的 `data.agent.inboxWake`，直接改文档——界面还没有这个开关（阶段 E）。 */
function setWake(mode: string | undefined): void {
  const data =
    mode === undefined
      ? { kind: "terminal", agent: { id: "codex" } }
      : { kind: "terminal", agent: { id: "codex", inboxWake: mode } };
  fixture.database
    .prepare("UPDATE nodes SET data_json = ? WHERE id = ?")
    .run(JSON.stringify(data), sleeper);
}

async function post(body: string, key: string): Promise<void> {
  ok(await run(sender, "post", { to: sleeper, key, body }));
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  fixture = agentFixture();
  sender = fixture.agentNode("Planner");
  sleeper = fixture.agentNode("Codex", "codex");
  sleeperSession = fixture.session(sleeper, "codex");
  fixture.link(sender, sleeper);
  fixture.name(sender, "planner");
  fixture.terminal.foreground = { command: "codex" };
  target();
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
  resetInboxWake();
});

describe("the setting itself", () => {
  it("has one list, and the document validator mirrors it", () => {
    expect([...INBOX_WAKE_MODES]).toEqual([...DOCUMENT_WAKE_MODES]);
  });
});

describe("the three settings", () => {
  it("notifies by default, and the notice names the count and the verb", async () => {
    expect(DEFAULT_INBOX_WAKE).toBe("notify");
    await post("材料在 /tmp/a.md", "k1");
    await post("还有第二份", "k2");
    await pump().drain(sleeper);

    expect(fixture.terminal.submits).toHaveLength(1);
    const written = fixture.terminal.submits[0]?.data ?? "";
    expect(written).toContain("收件箱有 2 条新消息");
    expect(written).toContain("armadra-hook canvas inbox");
    // 署名是应用自己，不是把目标的名字写上去冒充一次对话。
    expect(written).toContain("from: Armadra 收件箱");
    // 提示档不泄露正文：它说的是「你有信」，不是信里写了什么。
    expect(written).not.toContain("材料在 /tmp/a.md");
  });

  it("delivers the earliest unread body when the node asks for it", async () => {
    setWake("deliver");
    await post("复查 src/api 的错误返回", "k1");
    await pump().drain(sleeper);

    const written = fixture.terminal.submits[0]?.data ?? "";
    expect(written).toContain("来自 planner 的未读画布消息");
    expect(written).toContain("复查 src/api 的错误返回");
    // 读不等于确认：那条消息还躺在收件箱里等目标自己 ack（§5 第 3 条）。
    const inbox = ok(await run(sleeper, "inbox", {}));
    expect((inbox.messages as unknown[]).length).toBe(1);
  });

  it("does nothing at all when the node switched it off", async () => {
    setWake("off");
    await post("材料在 /tmp/a.md", "k1");
    await pump().drain(sleeper);
    expect(fixture.terminal.submits).toHaveLength(0);
    expect(pendingFor(fixture.database, sleeper, 0)).toHaveLength(0);
  });
});

describe("when it fires", () => {
  it("tells the pump to look as soon as a post lands, not at the next turn", async () => {
    await post("材料在 /tmp/a.md", "k1");
    // 一个空闲的节点不会因为收到一条消息就报状态；只听 `agent.status` 的话，
    // 唤醒会等到它下一次跑完一轮——那正是它最不需要被提醒的时刻。
    expect(fixture.nudged).toContain(sleeper);
  });

  it("stays out of the way while the target is in a turn", async () => {
    target({ state: "busy" });
    await post("材料在 /tmp/a.md", "k1");
    await pump().drain(sleeper);
    expect(pendingFor(fixture.database, sleeper, 0)).toHaveLength(0);

    // 它空下来的那一刻再问一次，这一次才排上并投出去。
    target({ state: "idle" });
    await pump().drain(sleeper);
    expect(fixture.terminal.submits).toHaveLength(1);
  });

  it("notifies once per batch, and again when the batch grows", async () => {
    await post("第一条", "k1");
    await pump().drain(sleeper);
    expect(fixture.terminal.submits).toHaveLength(1);

    // 同一批未读被反复试探不会变成反复提示。
    await pump().drain(sleeper);
    await pump().drain(sleeper);
    expect(fixture.terminal.submits).toHaveLength(1);

    await post("第二条", "k2");
    await pump().drain(sleeper);
    expect(fixture.terminal.submits).toHaveLength(2);
    expect(fixture.terminal.submits[1]?.data ?? "").toContain(
      "收件箱有 2 条新消息",
    );
  });

  it("goes quiet once the inbox is acknowledged", async () => {
    await post("第一条", "k1");
    await pump().drain(sleeper);
    const inbox = ok(await run(sleeper, "inbox", {}));
    const id = (inbox.messages as { id: string }[])[0]?.id as string;
    ok(await run(sleeper, "ack", { id }));

    await pump().drain(sleeper);
    expect(fixture.terminal.submits).toHaveLength(1);
  });
});

describe("the queue it shares with send", () => {
  it("答的是同一条门链：人在打字时它也要等", async () => {
    target({
      lease: {
        state: "human",
        generation: 1,
        expiresAt: "",
        holder: { kind: "human", id: "someone" },
      },
    });
    await post("材料在 /tmp/a.md", "k1");
    await pump().drain(sleeper);
    expect(fixture.terminal.submits).toHaveLength(0);
    const queued = pendingFor(fixture.database, sleeper, 0);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.origin).toBe("mailbox-wake");
    expect(queued[0]?.lastReason).toBe("LEASE_HELD_BY_HUMAN");

    // 人停手、租约过期，泵被那一帧 `free` 推了一下——正文这才投进去。
    target({ lease: freeLease(2) });
    await pump().drain(sleeper);
    expect(fixture.terminal.submits).toHaveLength(1);
  });

  it("排在 send 之后，不插队", async () => {
    ok(await run(sender, "send", { to: sleeper, body: "先做这件事" }));
    expect(fixture.terminal.submits).toHaveLength(1);
    // 那一条投完，目标开了一轮；这时候来一条信。
    target({ state: "busy" });
    await post("材料在 /tmp/a.md", "k1");
    await pump().drain(sleeper);
    expect(fixture.terminal.submits).toHaveLength(1);
  });
});
