import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { HIBERNATE_INTENT } from "../terminal/hibernate";
import { createControlDispatcher } from "./control";
import { resetSendLimits } from "./send-limits";
import type { TerminalBridge } from "./service";

/**
 * `send` 给一个休眠节点时**不等**它接回来（终端宿主设计 §7.2）。
 *
 * 接回来要起 shell、等提示符安静、敲恢复行、等前台变成 CLI——真 Claude 实测
 * 约 1.5 秒起，Codex 更久；而 `armadra-hook canvas` 整个请求的预算是 1.5 秒。
 * 2026-09-26 的端到端里 `send` 先等完唤醒再排队，客户端先超时，报「请求到了
 * 但没等到回答，可能已经生效」，退出码非零——发送方的 Agent 看到的是失败，
 * 而这条消息其实排上了、随后也投了出去。
 *
 * 所以唤醒只踢一下，`send` 当场答「排队，等目标起来」；唤醒途中出队泵再试，
 * 看到的是一个前台还是 shell 的会话，同样留在队里而不是被当成硬拒绝取消掉。
 */

let fixture: AgentFixture;
let me: string;
let peer: string;
let peerSession: string;
let woken: string[];
let release: () => void;
let asleep: boolean;

function hibernate(nodeId: string, sessionId: string): void {
  fixture.database
    .prepare(
      "UPDATE terminal_sessions SET status = 'terminated', attach_state = 'exited', " +
        "termination_intent = ? WHERE id = ?",
    )
    .run(HIBERNATE_INTENT, sessionId);
  fixture.terminal.liveGeneration = undefined as never;
  fixture.terminal.drive.set(nodeId, { state: "exited" } as never);
  asleep = true;
}

/** 起到一半：行已经回到 running，前台还是 shell。 */
function halfAwake(nodeId: string, sessionId: string): void {
  fixture.database
    .prepare(
      "UPDATE terminal_sessions SET status = 'running', termination_intent = 'none', " +
        "generation = generation + 1 WHERE id = ?",
    )
    .run(sessionId);
  fixture.terminal.liveGeneration = 2;
  fixture.terminal.foreground = { command: "zsh" };
  fixture.terminal.drive.set(nodeId, { state: "starting" } as never);
}

/** 唤醒要到 `release()` 才结束，像真的那样慢。 */
function bridge(): TerminalBridge {
  return {
    ...fixture.terminal.bridge,
    generation: () => fixture.terminal.liveGeneration,
    sleeping: () => asleep,
    wakeNode: async (nodeId) => {
      if (!asleep) return false;
      woken.push(nodeId);
      await new Promise<void>((done) => {
        release = done;
      });
      return true;
    },
  };
}

function dispatcher() {
  return createControlDispatcher({ ...fixture.collab, terminals: bridge() });
}

async function send(body = "做这件事") {
  return (await dispatcher().dispatch("send", callerFor(fixture, me), {
    to: peer,
    body,
  })) as { ok: boolean; body?: unknown; code?: string };
}

/** 在 `ms` 毫秒内有没有答案。 */
async function within<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise.then((value) => ({ value })),
    new Promise<undefined>((done) => setTimeout(() => done(undefined), ms)),
  ]);
}

beforeEach(() => {
  resetSendLimits();
  fixture = agentFixture();
  woken = [];
  release = () => {};
  asleep = false;
  me = fixture.agentNode("Caller");
  peer = fixture.agentNode("Peer");
  peerSession = fixture.session(peer, "claude");
  fixture.link(me, peer);
});

afterEach(() => {
  release();
  fixture.close();
  resetSendLimits();
});

describe("send 给休眠节点", () => {
  it("踢一下唤醒就答「排队」，不等唤醒结束", async () => {
    hibernate(peer, peerSession);
    const answered = await within(send(), 200);
    expect(woken).toEqual([peer]);
    expect(answered).toBeDefined();
    expect(answered?.value).toMatchObject({
      ok: true,
      body: { outcome: "queued", reason: "TARGET_STARTING" },
    });
    expect(fixture.terminal.submits).toEqual([]);
  });

  it("唤醒途中（前台还是 shell）再投一条：照样排队，不当成硬拒绝", async () => {
    hibernate(peer, peerSession);
    halfAwake(peer, peerSession);
    const answered = await within(send("第二条"), 200);
    expect(answered?.value).toMatchObject({
      ok: true,
      body: { outcome: "queued", reason: "TARGET_STARTING" },
    });
    const states = fixture.database
      .prepare("SELECT state FROM agent_send_queue WHERE target_node_id = ?")
      .all(peer) as { state: string }[];
    expect(states.map((row) => row.state)).toEqual(["queued"]);
  });

  it("醒着的节点照常投，不叫醒任何东西", async () => {
    const outcome = await send();
    expect(woken).toEqual([]);
    expect(outcome.body).toMatchObject({ outcome: "delivered" });
  });

  it("不是休眠也没在起的死会话：照旧当场拒绝", async () => {
    hibernate(peer, peerSession);
    asleep = false;
    const outcome = await send();
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("TARGET_GONE");
  });
});
