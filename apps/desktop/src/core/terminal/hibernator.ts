import type { DatabaseSync } from "node:sqlite";

import {
  canResume,
  expectedProcesses,
  paneRunsAgent,
  planLaunch,
} from "../agent/launch";
import { type AgentSettings, baseAgent } from "../agent/registry";
import { getAgentStatus } from "../agent/status";
import type { WorkspaceEvent } from "../bus";
import { loadNode, loadSession } from "../collab/nodes";
import { pendingFor, targetsWithPending } from "../collab/send-queue";
import { TerminalError } from "./backend";
import type { EnvPairs } from "./environment";
import {
  type EcoPolicy,
  type HibernationBlocker,
  type HibernationState,
  type WakeReason,
  type WakeResult,
  hasBackgroundWork,
  hibernatedSession,
  hibernationBlockers,
  onlyWaitingForTime,
  programName,
  scheduledFor,
} from "./hibernate";
import type { SessionRecord, TerminalManager } from "./manager";
import { processTable } from "./process";

/**
 * Eco 休眠的执行者：巡检、结束、接回（终端宿主设计 §7.2）。
 *
 * 判据是 `hibernate.ts` 的纯函数；这里只负责把事实取齐、按顺序做事、把每一步
 * 说出去（`terminal.hibernation` 事件）。三条次序是这个文件存在的理由：
 *
 *   1. **确认退出之后才记休眠。** `manager.hibernate` 在后端 `terminate` 返回之后
 *      才写行；抛了就退回 `running`，一个没死透的进程不会被说成睡着了。
 *   2. **接回用同一个会话 id。** `manager.revive` 在原来那行上起下一个代次，页面
 *      按节点数据里的会话 id 重新附着即可，画布不用改一笔。起来之后先把
 *      `agent_status` 记成 `restored`，于是投递门链把它当 `starting`——等 CLI
 *      自己报一条新的空闲再投，而不是把正文打进一个还在铺界面的 shell。
 *   3. **同一节点同时只接一次。** 页面聚焦、投递、计划三条路可能同时叫醒同一个
 *      节点，第二个调用拿到的是第一个的那个 promise，而不是第二个 CLI。
 */

export interface HibernatorOptions {
  readonly database: DatabaseSync;
  readonly manager: TerminalManager;
  readonly settings: () => AgentSettings;
  readonly policy: () => EcoPolicy;
  /** 节点令牌与地址变量——与 `POST /api/terminals` 起 Agent 终端时同一份。 */
  readonly environment: (nodeId: string, agentId: string) => EnvPairs;
  /**
   * 本机解析到的程序路径与集成要求的额外 argv（`GET /api/agents` 那一行的
   * `resolvedPath` / `launchArgs`）。缺席时用注册表里的程序名、不加 argv。
   */
  readonly program?: (agentId: string) => {
    readonly path?: string | undefined;
    readonly args?: readonly string[] | undefined;
  };
  readonly publish?: (workspaceId: string, event: WorkspaceEvent) => void;
  /** 接回来之后推一下出队泵：「启动不上报」的 CLI 等不来第一条事件。 */
  readonly nudge?: (nodeId: string) => void;
  /** pane shell 的直接子进程与 Agent 的子孙，按 argv。注入给用例。 */
  readonly processes?: (
    panePid: number,
    agentNames: readonly string[],
  ) => { shellChildren: string[]; agentDescendants: string[] };
  readonly clock?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** 提示符安静这么久就敲恢复行（与页面、依赖编排同一个数）。 */
const PROMPT_QUIET_MS = 400;
/** 一直没有输出也最多等这么久。 */
const PROMPT_COLD_MS = 3_000;
/** 恢复行敲进去之后，等前台变成这个 Agent 最多这么久。 */
const AGENT_UP_MS = 15_000;
const POLL_MS = 100;

export class Hibernator {
  private readonly database: DatabaseSync;
  private readonly manager: TerminalManager;
  private readonly clock: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly log: (
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  /**
   * 空闲计时的另一个起点：这个进程第一次看见这个会话（这一代）的时刻，或者最后
   * 一次看见有人附着的时刻。重启之后被接管的会话没有输出时间可看，不能因为
   * `agent_status` 里那条上报是九天前的就在启动的第一分钟把它结束掉。
   */
  private readonly activeAt = new Map<
    string,
    { generation: number; atMs: number }
  >();
  /** 节点 → 状态机里的当前位置（只记 `running` 之外的，和 `idle`）。 */
  private readonly states = new Map<string, HibernationState>();
  private readonly waking = new Map<string, Promise<WakeResult>>();
  private ticking = false;

  constructor(private readonly options: HibernatorOptions) {
    this.database = options.database;
    this.manager = options.manager;
    this.clock = options.clock ?? (() => Date.now());
    this.delay =
      options.delay ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? (() => {});
  }

  /** 状态机里的位置。库里休眠着的节点答 `hibernated`，没记过的答 `running`。 */
  state(nodeId: string): HibernationState {
    const known = this.states.get(nodeId);
    if (known !== undefined) return known;
    return hibernatedSession(this.database, nodeId) === undefined
      ? "running"
      : "hibernated";
  }

  /* --------------------------------- 巡检 --------------------------------- */

  /**
   * 一轮巡检，返回这一轮结束掉的会话 id。
   *
   * 先处理投递：队里有东西的休眠节点先叫醒（关掉 Eco 之后也照做——之前睡下的
   * 节点照样要收得到消息）。然后才轮到判谁该睡。
   */
  async tick(): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      await this.wakeQueued();
      const policy = this.options.policy();
      if (!policy.enabled) {
        for (const [nodeId, state] of this.states) {
          if (state === "idle") this.states.delete(nodeId);
        }
        return [];
      }
      const slept: string[] = [];
      for (const record of this.manager.liveRecords()) {
        if (record.ownerNodeId === null) continue;
        const blockers = await this.blockers(record, policy);
        const nodeId = record.ownerNodeId;
        if (blockers.length > 0) {
          // `idle`：判据全过、只差时间。别的理由一出现就退回 running。
          if (onlyWaitingForTime(blockers)) this.states.set(nodeId, "idle");
          else if (this.states.get(nodeId) === "idle")
            this.states.delete(nodeId);
          continue;
        }
        if (await this.hibernate(record)) slept.push(record.id);
      }
      return slept;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * 这个会话此刻不该睡的理由；空数组就是该睡了。
   *
   * 取事实分两段：库与内存里现成的先取，判得出不该睡就不去问前台——`ps` 是这
   * 一轮里唯一有成本的一步，只有其余判据全过的会话才值得它。
   */
  async blockers(
    record: SessionRecord,
    policy: EcoPolicy,
  ): Promise<HibernationBlocker[]> {
    const nodeId = record.ownerNodeId;
    const nowMs = this.clock();
    const attached = this.manager.attachedSockets(record.id);
    const seen = this.activeAt.get(record.id);
    if (
      seen === undefined ||
      seen.generation !== record.generation ||
      attached > 0
    ) {
      this.activeAt.set(record.id, {
        generation: record.generation,
        atMs: nowMs,
      });
    }
    if (nodeId === null) return ["notAgent"];
    const settings = this.options.settings();
    const node = loadNode(this.database, nodeId);
    const agentId = node?.agentId ?? rowAgent(this.database, record.id);
    const status = getAgentStatus(this.database, nodeId);
    const observed = this.manager.observedActivity(record.id);
    const reportedAt = Date.parse(status?.lastEventAt ?? "");
    const since = Math.max(
      this.activeAt.get(record.id)?.atMs ?? nowMs,
      observed?.lastOutputAt ?? 0,
      Number.isFinite(reportedAt) ? reportedAt : 0,
    );
    const facts = {
      agentId,
      resumable: agentId !== null && canResume(settings, agentId),
      providerSessionId: status?.sessionId,
      remote: record.spec.sshHostId !== undefined,
      state: status?.state,
      stateSource: status?.stateSource,
      attachedSockets: attached,
      inputPending: observed?.pending === true,
      leaseFree: this.manager.driveLease(record.id).state === "free",
      queued:
        pendingFor(this.database, nodeId, Math.floor(nowMs / 1000)).length > 0,
      foregroundIsAgent: true as boolean | undefined,
      backgroundProcess: false,
      scheduled: scheduledFor(this.database, nodeId, nowMs),
      idleForMs: nowMs - since,
      thresholdMs: policy.idleMinutes * 60_000,
    };
    const cheap = hibernationBlockers(facts);
    if (cheap.length > 0 || agentId === null) return cheap;

    // 前台与进程树。问不到就当「不是」：看不清的会话不动。
    const names = expectedProcesses(baseAgent(settings, agentId));
    let foreground;
    try {
      foreground = await this.manager.foreground(record.id);
    } catch {
      foreground = undefined;
    }
    const isAgent =
      foreground === undefined
        ? undefined
        : paneRunsAgent(
            {
              ...(foreground.command === undefined
                ? {}
                : { command: foreground.command }),
              children: [...foreground.children],
            },
            names,
          );
    let background = false;
    if (isAgent === true && foreground?.pid !== undefined) {
      const tree = (this.options.processes ?? processesUnder)(
        foreground.pid,
        names,
      );
      background = hasBackgroundWork(tree.shellChildren, tree.agentDescendants);
    }
    return hibernationBlockers({
      ...facts,
      foregroundIsAgent: isAgent,
      backgroundProcess: background,
    });
  }

  /** 结束一个会话并记成休眠。成功答 `true`。 */
  async hibernate(record: SessionRecord): Promise<boolean> {
    const nodeId = record.ownerNodeId;
    if (nodeId === null) return false;
    // 判完到动手之间隔着一次 `ps`：这期间有人附着了就不动它。
    if (this.manager.attachedSockets(record.id) > 0) return false;
    this.states.set(nodeId, "hibernate-requested");
    try {
      await this.manager.hibernate(record.id);
    } catch (error) {
      // 没确认退出：它还是 running，下一轮再判。
      this.states.delete(nodeId);
      this.log("Eco 休眠没能结束会话，保持运行", {
        nodeId,
        sessionId: record.id,
        error: describe(error),
      });
      return false;
    }
    this.states.set(nodeId, "hibernated");
    this.activeAt.delete(record.id);
    this.log("Eco 休眠：空闲的 Agent 会话已结束，恢复信息留在库里", {
      nodeId,
      sessionId: record.id,
    });
    this.announce(record.workspaceId, record.id, nodeId, "hibernated");
    return true;
  }

  /* --------------------------------- 接回 --------------------------------- */

  /**
   * 把一个休眠的节点接回来：同一个会话 id 起下一代 shell，敲 CLI 的恢复行，等
   * 前台变成这个 Agent。
   *
   * 节点本来就醒着（别的路先叫醒了、或者有人重新起过）时答它活着的那个会话，
   * 不再起第二个。
   */
  wake(nodeId: string, reason: WakeReason): Promise<WakeResult> {
    const running = this.waking.get(nodeId);
    if (running !== undefined) return running;
    const job = this.resume(nodeId, reason).finally(() => {
      this.waking.delete(nodeId);
    });
    this.waking.set(nodeId, job);
    return job;
  }

  /** 这个节点是不是正休眠着（或者正在接回），给投递前的那一问。 */
  sleeping(nodeId: string): boolean {
    return (
      this.waking.has(nodeId) ||
      hibernatedSession(this.database, nodeId) !== undefined
    );
  }

  private async resume(
    nodeId: string,
    reason: WakeReason,
  ): Promise<WakeResult> {
    const hibernated = hibernatedSession(this.database, nodeId);
    if (hibernated === undefined) {
      const live = loadSession(this.database, nodeId);
      const generation =
        live === undefined
          ? undefined
          : this.manager.generation(live.sessionId);
      if (
        live !== undefined &&
        generation !== undefined &&
        this.manager.isAlive(live.sessionId)
      ) {
        return { sessionId: live.sessionId, generation };
      }
      throw new TerminalError(
        409,
        "not_hibernated",
        "This node has no hibernated session",
      );
    }
    const { sessionId, workspaceId } = hibernated;
    const fail = (why: string, error?: unknown): never => {
      this.states.set(nodeId, "failed");
      this.log("Eco 休眠的会话没能接回来", {
        nodeId,
        sessionId,
        reason,
        why,
        ...(error === undefined ? {} : { error: describe(error) }),
      });
      this.announce(workspaceId, sessionId, nodeId, "failed", why);
      throw new TerminalError(
        409,
        "wake_failed",
        error === undefined ? why : `${why}: ${describe(error)}`,
      );
    };

    const node = loadNode(this.database, nodeId);
    if (node === undefined) return fail("nodeGone");
    const agentId = node.agentId ?? hibernated.agentId;
    if (agentId === null) return fail("notAgent");
    const providerSessionId = getAgentStatus(this.database, nodeId)?.sessionId;
    if (providerSessionId === undefined || providerSessionId === "") {
      return fail("noProviderSession");
    }
    const settings = this.options.settings();
    let line: string;
    try {
      line = resumeLine(
        settings,
        agentId,
        node.data,
        providerSessionId,
        this.options.program?.(agentId),
      );
    } catch (error) {
      return fail("launchRefused", error);
    }

    this.states.set(nodeId, "resuming");
    this.announce(workspaceId, sessionId, nodeId, "resuming", reason);
    let revived;
    try {
      revived = await this.manager.revive(
        sessionId,
        this.options.environment(nodeId, agentId),
      );
    } catch (error) {
      return fail("spawnFailed", error);
    }
    // 旧的那条 idle 属于上一代进程。记成 restored，投递门链就把它当 `starting`
    // ——等接回来的 CLI 自己报一条再投（`agent/target-state.ts` 第 2 条规矩）。
    this.database
      .prepare("UPDATE agent_status SET restored = 1 WHERE node_id = ?")
      .run(nodeId);

    const quiet = await this.waitForPrompt(sessionId);
    if (!quiet) return fail("shellGone");
    try {
      await this.manager.input(sessionId, revived.generation, `${line}\r`);
    } catch (error) {
      return fail("writeFailed", error);
    }
    if (!(await this.waitForAgent(sessionId, settings, agentId))) {
      return fail("agentDidNotStart");
    }
    this.states.delete(nodeId);
    this.log("Eco 休眠的会话已接回", { nodeId, sessionId, reason });
    this.announce(workspaceId, sessionId, nodeId, "running", reason);
    this.options.nudge?.(nodeId);
    return { sessionId, generation: revived.generation };
  }

  /** 队里有东西的休眠节点，逐个叫醒。 */
  private async wakeQueued(): Promise<void> {
    const nowSeconds = Math.floor(this.clock() / 1000);
    let targets: string[];
    try {
      targets = targetsWithPending(this.database, nowSeconds);
    } catch {
      return;
    }
    for (const nodeId of targets) {
      if (hibernatedSession(this.database, nodeId) === undefined) continue;
      if (this.states.get(nodeId) === "failed") continue;
      try {
        await this.wake(nodeId, "delivery");
      } catch {
        // 已经记了日志、发了 `failed`；队列项由它自己的 TTL 决定死期。
      }
    }
  }

  /** 与页面的启动时序同一个判据：有输出之后安静一会儿，或者等满冷启动上限。 */
  private async waitForPrompt(sessionId: string): Promise<boolean> {
    const started = this.clock();
    for (;;) {
      const observed = this.manager.observedActivity(sessionId);
      if (observed === undefined) return false;
      const now = this.clock();
      const last = observed.lastOutputAt;
      if (last !== undefined && now - last >= PROMPT_QUIET_MS) return true;
      if (now - started >= PROMPT_COLD_MS) return true;
      await this.delay(POLL_MS);
    }
  }

  private async waitForAgent(
    sessionId: string,
    settings: AgentSettings,
    agentId: string,
  ): Promise<boolean> {
    const names = expectedProcesses(baseAgent(settings, agentId));
    const started = this.clock();
    for (;;) {
      if (!this.manager.isAlive(sessionId)) return false;
      try {
        const foreground = await this.manager.foreground(sessionId);
        if (
          paneRunsAgent(
            {
              ...(foreground.command === undefined
                ? {}
                : { command: foreground.command }),
              children: [...foreground.children],
            },
            names,
          )
        ) {
          return true;
        }
      } catch {
        // 后端一时答不上来，接着等。
      }
      if (this.clock() - started >= AGENT_UP_MS) return false;
      await this.delay(POLL_MS * 2);
    }
  }

  private announce(
    workspaceId: string,
    sessionId: string,
    nodeId: string,
    state: "hibernated" | "resuming" | "running" | "failed",
    reason?: string,
  ): void {
    this.options.publish?.(workspaceId, {
      type: "terminal.hibernation",
      sessionId,
      nodeId,
      state,
      ...(reason === undefined ? {} : { reason }),
    });
  }
}

/* --------------------------------- 恢复行 --------------------------------- */

/**
 * 接回一个会话要敲的那一行：与页面、依赖编排拼的是同一份（程序、权限模式与模
 * 型的旗标、自定义条目的 argv、集成要求的 argv），只是多了 CLI 自己的 resume
 * ——Claude 的 `--resume <id>`、Codex 的 `resume <id>`，由 `agent/launch.ts` 的
 * 注册表决定形状与位置。模型与权限模式读节点**现在**的设置：人在它睡着时改过
 * 模型，醒来就该用新的那个。
 */
export function resumeLine(
  settings: AgentSettings,
  agentId: string,
  data: Record<string, unknown>,
  providerSessionId: string,
  program?: {
    readonly path?: string | undefined;
    readonly args?: readonly string[] | undefined;
  },
): string {
  const agent =
    data.agent !== null && typeof data.agent === "object"
      ? (data.agent as Record<string, unknown>)
      : {};
  const permissionMode = text(agent.permissionMode);
  const model = text(agent.model);
  const plan = planLaunch(settings, {
    agentId,
    resume: providerSessionId,
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(model === undefined ? {} : { model }),
  });
  return [program?.path ?? plan.program, ...plan.args, ...(program?.args ?? [])]
    .map(shellWord)
    .join(" ");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 只在需要时加引号：这一行会出现在人的屏幕上。 */
function shellWord(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/* -------------------------------- 进程树 ---------------------------------- */

/**
 * pane shell 的直接子进程，与其中那个 Agent 的整棵子树（不含它自己）。
 * 一次 `ps`；Windows 上表是空的，于是两样都是空——那边的会话由 session-host
 * 持有，这条判据如实答「没看到后台作业」。
 */
export function processesUnder(
  panePid: number,
  agentNames: readonly string[],
): { shellChildren: string[]; agentDescendants: string[] } {
  const table = processTable();
  const direct = [...table.entries()].filter(
    ([, row]) => row.parent === panePid,
  );
  const agent = direct.find(([, row]) =>
    agentNames.some((name) => {
      const program = programName(row.argv);
      return program === name || row.argv.split(/[\s/\\]+/).includes(name);
    }),
  );
  const descendants: string[] = [];
  if (agent !== undefined) {
    const frontier = [agent[0]];
    for (let index = 0; index < frontier.length; index += 1) {
      const parent = frontier[index] as number;
      for (const [pid, row] of table) {
        if (row.parent === parent && !frontier.includes(pid)) {
          frontier.push(pid);
          descendants.push(row.argv);
        }
      }
    }
  }
  return {
    shellChildren: direct.map(([, row]) => row.argv),
    agentDescendants: descendants,
  };
}

function rowAgent(database: DatabaseSync, sessionId: string): string | null {
  const row = database
    .prepare("SELECT agent_id FROM terminal_sessions WHERE id = ?")
    .get(sessionId) as { agent_id?: string | null } | undefined;
  return row?.agent_id ?? null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
