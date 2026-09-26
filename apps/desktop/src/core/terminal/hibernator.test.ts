import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type AgentFixture, agentFixture } from "../agent/fixture";
import { humanActor } from "../drive/lease";
import { upsertAgentStatus } from "../hook/store";
import { enqueue } from "../collab/send-queue";
import { uuidV7 } from "../workspaces/support";
import type { WorkspaceEvent } from "../bus";
import {
  type Attachment,
  type BackendCapabilities,
  type BackendKind,
  type BackendNotice,
  type BackendRef,
  type ForegroundInfo,
  type SessionKey,
  type TerminalBackend,
  type TerminalHandle,
  type TerminalSpec,
  type TerminateMode,
  notFound,
} from "./backend";
import {
  HIBERNATE_INTENT,
  type EcoPolicy,
  hibernatedSession,
  scheduledFor,
} from "./hibernate";
import { Hibernator, resumeLine } from "./hibernator";
import {
  artifactLayout,
  prepareInjection,
  shellWord,
} from "../hook/install/inject";
import { tempDir } from "../testing/temp-dir";
import { TerminalManager } from "./manager";

/**
 * Eco 休眠的状态机（终端宿主设计 §7.2），在一个假 CLI 上跑。
 *
 * 「假 CLI」是一个后端：它记下每一次 create、每一行敲进来的字，前台报什么由
 * 用例决定。要断言的正是这两样——结束的是不是那个会话、接回来时敲进 shell 的
 * 是不是那条 `--resume <同一个 id>`——而一个真 PTY 只会让这件事取决于机器上装
 * 没装 claude。
 */

class FakeCli implements TerminalBackend {
  readonly kind: BackendKind = "tmux";
  readonly created: TerminalSpec[] = [];
  readonly typed: string[] = [];
  readonly terminated: string[] = [];
  foreground: ForegroundInfo = { pid: 4242, command: "claude", children: [] };
  failTerminate = false;
  private readonly alive = new Set<SessionKey>();
  private attachments = 1;

  async create(spec: TerminalSpec): Promise<TerminalHandle> {
    this.created.push(spec);
    this.alive.add(spec.sessionKey);
    return {
      sessionKey: spec.sessionKey,
      generation: spec.generation,
      backendRef: `fake-${spec.sessionKey}-${spec.generation}`,
      pid: 4242,
    };
  }
  async attach(): Promise<Attachment> {
    return {
      attachmentId: this.attachments++,
      generation: 1,
      onData: () => {},
      onExit: () => {},
    };
  }
  async detach(): Promise<void> {}
  async input(_key: SessionKey, bytes: Buffer): Promise<void> {
    this.typed.push(bytes.toString("utf8"));
  }
  async paste(): Promise<void> {}
  async resize(): Promise<void> {}
  async capture(): Promise<string> {
    return "";
  }
  async signal(): Promise<void> {}
  async terminate(key: SessionKey, mode: TerminateMode): Promise<void> {
    if (this.failTerminate) throw notFound("still there");
    this.terminated.push(`${key}:${mode}`);
    this.alive.delete(key);
  }
  async getForeground(key: SessionKey): Promise<ForegroundInfo> {
    if (!this.alive.has(key)) throw notFound("gone");
    return this.foreground;
  }
  getCapabilities(): BackendCapabilities {
    return {
      kind: "tmux",
      persistent: true,
      redrawsOnAttach: true,
      usable: true,
    };
  }
  async list(): Promise<BackendRef[]> {
    return [];
  }
  async destroyByReference(): Promise<void> {}
  async scroll(): Promise<void> {}
  async setDormant(): Promise<void> {}
  notices(_listener: (notice: BackendNotice) => void): void {}
  async detachAll(): Promise<void> {}
}

let fixture: AgentFixture;
let cli: FakeCli;
let manager: TerminalManager;
let hibernator: Hibernator;
let now: number;
let policy: EcoPolicy;
let events: WorkspaceEvent[];
let nudged: string[];
let injectionDir: string;
let background: { shellChildren: string[]; agentDescendants: string[] };

const MINUTE = 60_000;

beforeEach(() => {
  fixture = agentFixture();
  cli = new FakeCli();
  injectionDir = tempDir("armadra-hibernator-injection-");
  writeFileSync(join(injectionDir, "armadra-hook"), "#!/bin/sh\n", "utf8");
  prepareInjection("claude", {
    dataDir: injectionDir,
    env: {
      ...process.env,
      ARMADRA_HOOK_BIN: join(injectionDir, "armadra-hook"),
    },
  });
  now = Date.parse("2026-09-26T08:00:00.000Z");
  policy = { enabled: true, idleMinutes: 30 };
  events = [];
  nudged = [];
  background = { shellChildren: ["claude"], agentDescendants: [] };
  manager = new TerminalManager({
    database: fixture.database,
    backends: new Map([["tmux", cli]]),
    effective: "tmux",
    now: () => new Date(now).toISOString(),
    clock: () => now,
  });
  hibernator = new Hibernator({
    database: fixture.database,
    manager,
    settings: () => fixture.collab.settings,
    policy: () => policy,
    environment: (nodeId) => [["ARMADRA_NODE_ID", nodeId]],
    program: () => ({ path: "/opt/bin/claude" }),
    dataDir: injectionDir,
    publish: (_workspaceId, event) => {
      events.push(event);
    },
    nudge: (nodeId) => {
      nudged.push(nodeId);
    },
    processes: () => background,
    clock: () => now,
    // 等提示符与等前台都是轮询：让时钟随每一次「等」往前走，用例不真的睡。
    delay: async (ms) => {
      now += ms;
    },
  });
});

afterEach(() => {
  fixture.close();
});

/** 一个 Agent 节点、它的会话、一条 hook 报来的 idle 与 provider 会话 id。 */
async function idleAgent(
  agentId = "claude",
  data: Record<string, unknown> = {},
): Promise<{ nodeId: string; sessionId: string }> {
  const nodeId = fixture.agentNode("Agent", agentId);
  if (Object.keys(data).length > 0) {
    fixture.database
      .prepare("UPDATE nodes SET data_json = ? WHERE id = ?")
      .run(
        JSON.stringify({ kind: "terminal", agent: { id: agentId, ...data } }),
        nodeId,
      );
  }
  const session = await manager.spawn({
    workspaceId: fixture.workspaceId,
    cwd: fixture.directory,
    ownerNodeId: nodeId,
    agentId,
  });
  report(nodeId, "done", agentId);
  return { nodeId, sessionId: session.id };
}

function report(
  nodeId: string,
  state: string,
  agentId = "claude",
  sessionId: string | null = "prov-1",
): void {
  upsertAgentStatus(
    fixture.database,
    {
      nodeId,
      workspaceId: fixture.workspaceId,
      agentId,
      state,
      stateSource: "hook",
      unread: false,
      sessionId: sessionId ?? undefined,
      pendingId: undefined,
      verified: true,
      transcriptPath: undefined,
      sessionPhase: undefined,
      errored: undefined,
      interrupted: undefined,
      lastEventAt: new Date(now).toISOString(),
    },
    new Date(now).toISOString(),
  );
}

/** 第一轮巡检起表，再让时间过去。 */
async function idleFor(minutes: number): Promise<string[]> {
  await hibernator.tick();
  now += minutes * MINUTE;
  return hibernator.tick();
}

describe("running → idle → hibernated", () => {
  it("闲够阈值就结束会话，行记成休眠，事件在确认退出之后才发", async () => {
    const { nodeId, sessionId } = await idleAgent();
    await hibernator.tick();
    expect(hibernator.state(nodeId)).toBe("idle");
    now += 29 * MINUTE;
    expect(await hibernator.tick()).toEqual([]);
    now += 2 * MINUTE;
    expect(await hibernator.tick()).toEqual([sessionId]);

    expect(cli.terminated).toEqual([`${nodeId}:session`]);
    expect(hibernator.state(nodeId)).toBe("hibernated");
    expect(manager.isAlive(sessionId)).toBe(false);
    const row = manager.session(sessionId);
    expect(row.status).toBe("terminated");
    expect(row.hibernation).toBe("hibernated");
    expect(hibernatedSession(fixture.database, nodeId)?.sessionId).toBe(
      sessionId,
    );
    expect(events).toEqual([
      { type: "terminal.hibernation", sessionId, nodeId, state: "hibernated" },
    ]);
  });

  it("后端没确认退出就还是 running", async () => {
    const { nodeId, sessionId } = await idleAgent();
    cli.failTerminate = true;
    expect(await idleFor(31)).toEqual([]);
    expect(manager.isAlive(sessionId)).toBe(true);
    expect(manager.session(sessionId).hibernation).toBeNull();
    expect(hibernator.state(nodeId)).toBe("running");
    expect(events).toEqual([]);
  });

  it("关掉 Eco 就一个都不睡", async () => {
    await idleAgent();
    policy = { enabled: false, idleMinutes: 30 };
    expect(await idleFor(120)).toEqual([]);
    expect(cli.terminated).toEqual([]);
  });

  it("重启之后接管的会话从这个进程第一次看见它起算，不按九天前那条上报", async () => {
    const { sessionId } = await idleAgent();
    now += 9 * 24 * 60 * MINUTE;
    expect(await hibernator.tick()).toEqual([]);
    now += 31 * MINUTE;
    expect(await hibernator.tick()).toEqual([sessionId]);
  });
});

describe("不该休眠的会话", () => {
  it("正在一轮里、停在审批上都不睡", async () => {
    const { nodeId } = await idleAgent();
    for (const state of ["working", "blocked", "waiting"]) {
      report(nodeId, state);
      expect(await idleFor(31)).toEqual([]);
    }
    expect(cli.terminated).toEqual([]);
  });

  it("有半截输入不睡", async () => {
    const { sessionId } = await idleAgent();
    await manager.input(sessionId, 1, "git sta");
    expect(await idleFor(31)).toEqual([]);
  });

  it("人抢着租约不睡", async () => {
    const { sessionId } = await idleAgent();
    manager.takeoverDrive(sessionId, humanActor("local", ""));
    expect(await idleFor(31)).toEqual([]);
  });

  it("有人附着着不睡", async () => {
    const { sessionId } = await idleAgent();
    await manager.attach(sessionId, { cols: 80, rows: 24 });
    expect(await idleFor(31)).toEqual([]);
  });

  it("投递队列里有它的东西不睡", async () => {
    const { nodeId } = await idleAgent();
    await hibernator.tick();
    now += 31 * MINUTE;
    // 队列项五分钟过期，所以在到点那一刻放进去。
    queueFor(nodeId);
    expect(await hibernator.tick()).toEqual([]);
  });

  it("普通 shell 不睡", async () => {
    const nodeId = fixture.agentNode("Shell", null);
    await manager.spawn({
      workspaceId: fixture.workspaceId,
      cwd: fixture.directory,
      ownerNodeId: nodeId,
    });
    expect(await idleFor(31)).toEqual([]);
  });

  it("关掉了 resume 能力的自定义 Agent 不睡", async () => {
    fixture.customAgents.push({
      id: "custom:mine",
      label: "Mine",
      color: "#fff",
      launchCmd: "claude",
      args: [],
      env: {},
      baseAgent: "claude",
      disabledCapabilities: ["resume"],
    } as never);
    await idleAgent("custom:mine");
    expect(await idleFor(31)).toEqual([]);
  });

  it("没报过 provider 会话 id 不睡", async () => {
    const { nodeId } = await idleAgent();
    report(nodeId, "done", "claude", null);
    expect(await idleFor(31)).toEqual([]);
  });

  it("前台已经不是 Agent 不睡", async () => {
    await idleAgent();
    cli.foreground = { pid: 4242, command: "zsh", children: ["vim notes"] };
    expect(await idleFor(31)).toEqual([]);
  });

  it("Agent 下面挂着后台命令不睡", async () => {
    await idleAgent();
    background = {
      shellChildren: ["claude"],
      agentDescendants: ["/bin/zsh -c npm run dev", "node vite"],
    };
    expect(await idleFor(31)).toEqual([]);
  });

  it("有没授权冷启动的计划投给它就不睡", async () => {
    const { nodeId } = await idleAgent();
    plan(nodeId, "AUTOMATION_COLD_START_POLICY_SKIP", 0);
    expect(scheduledFor(fixture.database, nodeId, now)).toBe(true);
    expect(await idleFor(31)).toEqual([]);
  });

  it("授权了冷启动的计划只在快到期时挡", async () => {
    const { nodeId } = await idleAgent();
    plan(
      nodeId,
      "AUTOMATION_COLD_START_POLICY_LAUNCH_FROZEN",
      now + 5 * MINUTE,
    );
    expect(scheduledFor(fixture.database, nodeId, now)).toBe(true);
    expect(scheduledFor(fixture.database, nodeId, now - 60 * MINUTE)).toBe(
      false,
    );
  });
});

describe("hibernated → resuming → running", () => {
  it("在同一个会话 id 上起下一代，敲 CLI 自己的恢复行", async () => {
    const { nodeId, sessionId } = await idleAgent("claude", {
      model: "opus",
      permissionMode: "auto-edit",
    });
    await idleFor(31);
    events.length = 0;

    const woken = await hibernator.wake(nodeId, "focus");
    expect(woken).toEqual({ sessionId, generation: 2 });
    expect(manager.isAlive(sessionId)).toBe(true);
    expect(manager.session(sessionId)).toMatchObject({
      status: "running",
      generation: 2,
      hibernation: null,
    });
    expect(cli.created.map((spec) => spec.generation)).toEqual([1, 2]);
    // 同一段对话：`--resume` 后面是 hook 报过的那个 provider 会话 id，模型与
    // 权限模式读节点现在的设置，画布注入的 argv 跟在最后（恢复时要重带）。
    expect(cli.typed).toHaveLength(1);
    expect(
      cli.typed[0]?.startsWith(
        `/opt/bin/claude --resume prov-1 --permission-mode acceptEdits --model opus --settings ${shellWord(artifactLayout(injectionDir, "claude").settings as string)}`,
      ),
    ).toBe(true);
    // 旧的那条 idle 属于上一代：投递门链要等接回来的 CLI 自己再报一条。
    const restored = fixture.database
      .prepare("SELECT restored FROM agent_status WHERE node_id = ?")
      .get(nodeId) as { restored: number };
    expect(restored.restored).toBe(1);
    expect(events.map((event) => (event as { state?: string }).state)).toEqual([
      "resuming",
      "running",
    ]);
    expect(nudged).toEqual([nodeId]);
    expect(hibernator.state(nodeId)).toBe("running");
  });

  it("两条路同时叫醒只起一个", async () => {
    const { nodeId } = await idleAgent();
    await idleFor(31);
    const [first, second] = await Promise.all([
      hibernator.wake(nodeId, "focus"),
      hibernator.wake(nodeId, "delivery"),
    ]);
    expect(first).toEqual(second);
    expect(cli.created).toHaveLength(2);
    // 已经醒了再叫：答活着的那个，不再起。
    await hibernator.wake(nodeId, "focus");
    expect(cli.created).toHaveLength(2);
  });

  it("被新会话取代的休眠不再接回", async () => {
    const { nodeId } = await idleAgent();
    await idleFor(31);
    const fresh = await manager.spawn({
      workspaceId: fixture.workspaceId,
      cwd: fixture.directory,
      ownerNodeId: nodeId,
      agentId: "claude",
    });
    expect(hibernatedSession(fixture.database, nodeId)).toBeUndefined();
    expect(await hibernator.wake(nodeId, "focus")).toEqual({
      sessionId: fresh.id,
      generation: 1,
    });
    expect(cli.typed).toEqual([]);
  });

  it("接不回来就报 failed，要人处理", async () => {
    const { nodeId } = await idleAgent();
    await idleFor(31);
    events.length = 0;
    cli.foreground = { pid: 4242, command: "zsh", children: [] };
    await expect(hibernator.wake(nodeId, "focus")).rejects.toMatchObject({
      code: "wake_failed",
    });
    expect(hibernator.state(nodeId)).toBe("failed");
    expect(events.at(-1)).toMatchObject({
      type: "terminal.hibernation",
      state: "failed",
      reason: "agentDidNotStart",
    });
  });

  it("投给休眠节点的东西让巡检先把它叫醒", async () => {
    const { nodeId, sessionId } = await idleAgent();
    await idleFor(31);
    policy = { enabled: false, idleMinutes: 30 };
    queueFor(nodeId);
    await hibernator.tick();
    expect(manager.isAlive(sessionId)).toBe(true);
    expect(cli.typed).toHaveLength(1);
  });

  it("Codex 的恢复是子命令，排在所有旗标之前", () => {
    expect(
      resumeLine(
        fixture.collab.settings,
        "codex",
        { agent: { id: "codex", model: "gpt-5" } },
        "thread-9",
      ),
    ).toBe("codex resume thread-9 --model gpt-5");
  });
});

function queueFor(nodeId: string): void {
  const source = fixture.agentNode("Source");
  enqueue(fixture.database, {
    id: uuidV7(),
    workspaceId: fixture.workspaceId,
    sourceNodeId: source,
    targetNodeId: nodeId,
    origin: "send",
    messageKey: undefined,
    body: "做这件事",
    hops: 0,
    trail: [],
    now: Math.floor(now / 1000),
    state: "queued",
  });
}

function plan(nodeId: string, coldStartPolicy: string, dueMs: number): void {
  fixture.database
    .prepare(
      "INSERT INTO automation_plans (workspace_id, plan_id, revision, payload_json, state, next_due_at_ms, updated_at_ms) " +
        "VALUES (?, ?, 1, ?, 'AUTOMATION_PLAN_STATE_ACTIVE', ?, 0)",
    )
    .run(
      fixture.workspaceId,
      uuidV7(),
      JSON.stringify({
        state: "AUTOMATION_PLAN_STATE_ACTIVE",
        config: { target: { nodeId, coldStartPolicy } },
      }),
      dueMs,
    );
}

// 行上的那个标记是恢复的唯一依据，用一个常量守住拼写。
it("休眠写进 termination_intent 的就是那个常量", () => {
  expect(HIBERNATE_INTENT).toBe("hibernate");
});
