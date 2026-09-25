import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { createControlDispatcher } from "../collab/control";
import { resetSendLimits } from "../collab/send-limits";
import type { TerminalBridge } from "../collab/service";
import { TerminalDispatcher } from "../schedule/dispatch";
import { HOST_ID, config, openStore } from "../schedule/fixture";
import {
  AutomationColdStartPolicy,
  type AutomationTarget,
} from "../schedule/types";
import { HIBERNATE_INTENT, setHibernationWaker } from "./hibernate";

/**
 * 休眠节点的两个外来唤醒者（终端宿主设计 §7.2）：投递与计划。
 *
 * 终端是桩，唤醒是一个记账的函数：这里要守的是**次序**——`send` 在走门链之前
 * 先叫醒目标、计划只在授权了冷启动时才叫醒——而不是接回来这件事本身，那由
 * `hibernator.test.ts` 在假 CLI 上守着。
 */

let fixture: AgentFixture;
let me: string;
let peer: string;
let peerSession: string;
let woken: string[];

function hibernate(nodeId: string, sessionId: string): void {
  fixture.database
    .prepare(
      "UPDATE terminal_sessions SET status = 'terminated', attach_state = 'exited', " +
        "termination_intent = ? WHERE id = ?",
    )
    .run(HIBERNATE_INTENT, sessionId);
  fixture.terminal.liveGeneration = undefined as never;
  fixture.terminal.drive.set(nodeId, { state: "exited" } as never);
}

/** 桩上的唤醒：行回到 running，目标变成「刚起来、还没报过」。 */
function bridge(): TerminalBridge {
  return {
    ...fixture.terminal.bridge,
    generation: () => fixture.terminal.liveGeneration,
    wakeNode: async (nodeId) => {
      const row = fixture.database
        .prepare(
          "SELECT id FROM terminal_sessions WHERE owner_node_id = ? AND termination_intent = ?",
        )
        .get(nodeId, HIBERNATE_INTENT) as { id: string } | undefined;
      if (row === undefined) return false;
      woken.push(nodeId);
      fixture.database
        .prepare(
          "UPDATE terminal_sessions SET status = 'running', termination_intent = 'none', " +
            "generation = generation + 1 WHERE id = ?",
        )
        .run(row.id);
      fixture.terminal.liveGeneration = 2;
      fixture.terminal.drive.set(nodeId, { state: "starting" } as never);
      return true;
    },
  };
}

beforeEach(() => {
  resetSendLimits();
  fixture = agentFixture();
  woken = [];
  me = fixture.agentNode("Caller");
  peer = fixture.agentNode("Peer");
  peerSession = fixture.session(peer, "claude");
  fixture.link(me, peer);
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
  setHibernationWaker(undefined);
});

async function send(): Promise<{ ok: boolean; body?: unknown; code?: string }> {
  const dispatcher = createControlDispatcher({
    ...fixture.collab,
    terminals: bridge(),
  });
  return dispatcher.dispatch("send", callerFor(fixture, me), {
    to: peer,
    body: "做这件事",
  }) as never;
}

describe("投递唤醒", () => {
  it("投给休眠节点：先叫醒，再按「刚起来」排队等它报 idle", async () => {
    hibernate(peer, peerSession);
    const outcome = await send();
    expect(woken).toEqual([peer]);
    expect(outcome.ok).toBe(true);
    expect(outcome.body).toMatchObject({ outcome: "queued" });
    // 还没投进去：接回来的 CLI 自己报一条之后，出队泵才会投。
    expect(fixture.terminal.submits).toEqual([]);
  });

  it("醒着的节点照常投，不叫醒任何东西", async () => {
    const outcome = await send();
    expect(woken).toEqual([]);
    expect(outcome.body).toMatchObject({ outcome: "delivered" });
  });

  it("接不回来就由 send 如实拒绝", async () => {
    hibernate(peer, peerSession);
    const dispatcher = createControlDispatcher({
      ...fixture.collab,
      terminals: {
        ...bridge(),
        generation: () => undefined,
        wakeNode: async () => {
          throw new Error("spawn failed");
        },
      },
    });
    const outcome = (await dispatcher.dispatch("send", callerFor(fixture, me), {
      to: peer,
      body: "做这件事",
    })) as { ok: boolean; code?: string };
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("TARGET_GONE");
  });
});

describe("计划唤醒", () => {
  function dispatcher(): TerminalDispatcher {
    const { store } = openStore();
    return new TerminalDispatcher({
      database: fixture.database,
      store,
      hostId: HOST_ID,
      terminals: () => ({
        ...fixture.terminal.bridge,
        generation: () => undefined,
      }),
      settings: () => fixture.collab.settings,
      clock: () => 1_700_000_000_000,
    });
  }

  function target(policy: AutomationColdStartPolicy): AutomationTarget {
    const frozen = config().target as AutomationTarget;
    frozen.nodeId = peer;
    frozen.coldStartPolicy = policy;
    frozen.agentLaunch = {
      agentId: "claude",
      workingDirectory: fixture.directory,
      args: [],
      permissionMode: "default",
      modelId: "",
    } as never;
    return frozen;
  }

  it("授权了冷启动：用 resume 接回原来的会话，不另起一个", async () => {
    hibernate(peer, peerSession);
    setHibernationWaker(async (nodeId, reason) => {
      woken.push(`${nodeId}:${reason}`);
      return { sessionId: peerSession, generation: 2 };
    });
    const status = await dispatcher().supports(
      target(AutomationColdStartPolicy.LAUNCH_FROZEN),
      { coldStart: true },
    );
    expect(status).toEqual({ state: "busy", generation: 2 });
    expect(woken).toEqual([`${peer}:schedule`]);
  });

  it("没授权冷启动：答离线，这一次运行被跳过，节点照睡", async () => {
    hibernate(peer, peerSession);
    setHibernationWaker(async (nodeId) => {
      woken.push(nodeId);
      return { sessionId: peerSession, generation: 2 };
    });
    const status = await dispatcher().supports(
      target(AutomationColdStartPolicy.SKIP),
      { coldStart: true },
    );
    expect(status.state).toBe("offline");
    expect(woken).toEqual([]);
  });
});
