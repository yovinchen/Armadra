import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { loadBoard } from "../canvas/documents";
import { getContextLinks } from "../canvas/context-links";
import { freeLease } from "../drive/lease";
import { controlDispatcher, type ControlOutcome } from "./control";
import { SendPump } from "./send-pump";
import { resetSendLimits } from "./send-limits";
import { pendingFor } from "./send-queue";
import { resetInboxWake } from "./wake";

/**
 * 带任务启动（设计 `agent-delivery.md` §8 与 §11 的「阶段 D」测试栏）。
 *
 * 这一批要证的只有一件事：**第一条任务与第二条任务是同一条路**。所以断言的不
 * 是「`--task` 有没有被敲进去」，而是它有没有真的变成 `agent_send_queue` 里一
 * 条普通的排队项，走普通的门链、等一条**真的** idle、投出普通的信封。
 */

let fixture: AgentFixture;
let me: string;

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

function result(outcome: ControlOutcome): Record<string, unknown> {
  return ok(outcome).result as Record<string, unknown>;
}

/** 新节点起了 PTY、装了 hook，并处在 `state` 这个状态。 */
function bring(nodeId: string, state: string, stateSource = "hook"): string {
  const sessionId = fixture.session(nodeId, "codex");
  fixture.terminal.drive.set(nodeId, {
    nodeId,
    sessionId,
    state,
    stateSource,
    lease: freeLease(0),
    driveGeneration: 0,
  } as never);
  return sessionId;
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  fixture = agentFixture();
  me = fixture.agentNode("Planner");
  fixture.name(me, "planner");
  fixture.terminal.foreground = { command: "codex" };
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
  resetInboxWake();
});

describe("open-agent --task", () => {
  it("建节点、连线、把任务排上，启动行一个字也不带", async () => {
    const body = result(
      await run(me, "open-agent", {
        agent: "codex",
        title: "复查",
        task: "在 /tmp 建 b.txt 写 hi",
      }),
    );
    expect(body.command).toBe("codex");
    expect(body.linked).toBe(true);
    const created = body.id as string;

    // 连线是 `send` 的授权来源，所以它得同时在画布文档与两份链接文档里。
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    expect(
      document.edges.some(
        (edge) => edge.source === me && edge.target === created,
      ),
    ).toBe(true);
    expect(
      getContextLinks(fixture.database, me).links.some(
        (link) => link.id === created,
      ),
    ).toBe(true);
    expect(
      getContextLinks(fixture.database, created).links.some(
        (link) => link.id === me,
      ),
    ).toBe(true);

    const queued = pendingFor(fixture.database, created, 0);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.origin).toBe("first-task");
    expect(queued[0]?.body).toBe("在 /tmp 建 b.txt 写 hi");
    // 节点刚建好，什么都没敲进去。
    expect(fixture.terminal.submits).toHaveLength(0);
  });

  it("等的是第一条真正的 idle，不是一个定时器", async () => {
    const created = result(
      await run(me, "open-agent", { agent: "codex", task: "做这件事" }),
    ).id as string;
    const pump = new SendPump(() => fixture.collab);

    // 还没有 PTY：那不是拒绝，是「还早」，排队项留在队里等。
    await pump.drain(created);
    expect(fixture.terminal.submits).toHaveLength(0);
    expect(pendingFor(fixture.database, created, 0)).toHaveLength(1);

    // CLI 起来了，报了第一条 `SessionStart`——还不能投。
    bring(created, "starting");
    await pump.drain(created);
    expect(fixture.terminal.submits).toHaveLength(0);

    // 重启之后从库里读回来的那条 `done` 也走这一条：`targetState` 把 `restored`
    // 投影成 `starting`，所以泵看见的仍然是上面那个答案（§4.1、Q4）。
    // 第一条真的空闲到了。
    bring(created, "idle");
    await pump.drain(created);
    expect(fixture.terminal.submits).toHaveLength(1);
    const written = fixture.terminal.submits[0]?.data ?? "";
    expect(written).toContain("from: planner");
    expect(written).toContain("做这件事");
    expect(pendingFor(fixture.database, created, 0)).toHaveLength(0);
  });

  it("Codex 那种「启动不上报」的节点，等的是终端安静下来", async () => {
    // 真机上那条失败的端到端形状（§4.3）：Codex 起到提示符一条 hook 都不发，
    // 于是 `agent_status` 里没有它的行，第一条任务按 §4.1 会永远排在
    // `TARGET_STARTING` 上。这条路把它放出去——判据是观察，不是上报。
    const created = result(
      await run(me, "open-agent", { agent: "codex", task: "做这件事" }),
    ).id as string;
    const sessionId = fixture.session(created, "codex");
    fixture.terminal.drive.set(created, {
      nodeId: created,
      sessionId,
      state: "starting",
      stateSource: undefined,
      lease: freeLease(0),
      driveGeneration: 0,
    } as never);
    fixture.database
      .prepare("UPDATE terminal_sessions SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 10_000).toISOString(), sessionId);
    fixture.terminal.activity.set(sessionId, {
      pending: false,
      lastInputAt: undefined,
      lastOutputAt: Date.now() - 5_000,
    });

    const pump = new SendPump(() => fixture.collab);
    // 触发源是清扫那把定时器捎带的探测，不是一条 `agent.status`——那条事件按
    // 定义不会来。
    expect(await pump.probeSilentStarters()).toBe(1);

    expect(fixture.terminal.submits).toHaveLength(1);
    const written = fixture.terminal.submits[0]?.data ?? "";
    expect(written).toContain("from: planner");
    expect(written).toContain("做这件事");
    expect(pendingFor(fixture.database, created, 0)).toHaveLength(0);
  });

  it("过渡期里 --prompt 等价于 --task，并带一行 warning", async () => {
    const body = result(
      await run(me, "open-agent", { agent: "codex", prompt: "做这件事" }),
    );
    expect(body.warning).toBe("--prompt 已更名为 --task");
    expect(body.command).toBe("codex");
    expect(pendingFor(fixture.database, body.id as string, 0)[0]?.body).toBe(
      "做这件事",
    );
  });

  it("写下权限模式与模型，页面重拼启动行时才带得上", async () => {
    const created = result(
      await run(me, "open-agent", {
        agent: "codex",
        "permission-mode": "full-auto",
        model: "gpt-5-codex",
      }),
    ).id as string;
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    const data = document.nodes.find((node) => node.id === created)?.data as {
      agent: Record<string, unknown>;
    };
    expect(data.agent.permissionMode).toBe("full-auto");
    expect(data.agent.model).toBe("gpt-5-codex");
    // 这个 CLI 没有的权限模式当场拒绝，不静默降级。
    const refused = await run(me, "open-agent", {
      agent: "pi",
      "permission-mode": "full-auto",
    });
    expect(refused.ok).toBe(false);
  });

  it("任务受 send 的同一道正文闸管", async () => {
    const refused = await run(me, "open-agent", {
      agent: "codex",
      task: "x".repeat(2_001),
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.code).toBe("BODY_TOO_LONG");
    // 拒绝发生在建节点之前：不留一个没人要的空节点。
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    expect(document.nodes).toHaveLength(1);
  });

  it("演练不改画布，也不排任何东西", async () => {
    const body = result(
      await run(me, "open-agent", {
        agent: "codex",
        task: "做这件事",
        "dry-run": true,
      }),
    );
    expect(body.dryRun).toBe(true);
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    expect(document.nodes).toHaveLength(1);
  });
});
