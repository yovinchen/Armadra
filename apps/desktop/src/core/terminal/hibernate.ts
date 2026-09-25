import type { DatabaseSync } from "node:sqlite";

/**
 * Eco 模式的会话休眠：判据与状态，纯函数（终端宿主设计 §7.2）。
 *
 * 与 §7.1 的视图回收、`dormantAfterSeconds` 的投递节奏都不是一回事：那两条从不
 * 碰进程，这一条**结束进程**来还内存，之后用 CLI 自己的 resume 把同一段对话接
 * 回来。所以它只在「结束掉也能原样接回来」的时候做，判据全在
 * {@link hibernationBlockers}，任何一条不满足就不休眠——宁可多占几百兆，也不能
 * 让一个人回来时发现自己的会话没了。
 *
 * 状态机：
 *
 * ```
 * running → idle → hibernate-requested → hibernated → resuming → running
 *                          ↓                               ↓
 *                       running（退出没被确认）          failed（手动处理）
 * ```
 *
 * `idle` 只是「判据都满足、阈值还没到」；`hibernated` 只在后端确认进程已经结束
 * 之后才写（设计 §7.2「收到确认退出前不能标记 hibernated」）。
 *
 * 持久化不另开一张表：休眠就是那一行 `terminal_sessions` 以
 * `termination_intent = 'hibernate'` 结束。恢复要的其余几样都已经在库里——行上的
 * cwd、shell、Agent，`agent_status.session_id` 那个 provider 会话 id，节点数据里
 * 的权限模式与模型。进程不在时没有任何东西会改写那个会话 id，所以不需要快照。
 */

export const HIBERNATION_STATES = [
  "running",
  "idle",
  "hibernate-requested",
  "hibernated",
  "resuming",
  "failed",
] as const;

export type HibernationState = (typeof HIBERNATION_STATES)[number];

/** 行上那个标记。`recycle` 写的是 `'recycle'`，这里是第三种结束方式。 */
export const HIBERNATE_INTENT = "hibernate";

/** 阈值默认 30 分钟，可调 5 分钟到 24 小时。 */
export const DEFAULT_ECO_IDLE_MINUTES = 30;
export const MIN_ECO_IDLE_MINUTES = 5;
export const MAX_ECO_IDLE_MINUTES = 1_440;

/** 巡检间隔。阈值以分钟计，一分钟一次足够，也不会让 `ps` 成为负担。 */
export const HIBERNATE_INTERVAL_MS = 60_000;

/**
 * 有计划在这么久之内要跑，就不休眠：冷启动授权了也不该在它到期前一分钟把会话
 * 杀掉再拉起来。
 */
export const SCHEDULE_GUARD_MS = 10 * 60_000;

export interface EcoPolicy {
  readonly enabled: boolean;
  readonly idleMinutes: number;
}

/** 设置文档里的两个键，已经过 schema 归一化；读不出来就是默认值。 */
export function ecoPolicy(read: (path: string) => unknown): EcoPolicy {
  const enabled = read("terminal.ecoMode");
  const minutes = read("terminal.ecoIdleMinutes");
  return {
    enabled: typeof enabled === "boolean" ? enabled : true,
    idleMinutes:
      typeof minutes === "number" &&
      minutes >= MIN_ECO_IDLE_MINUTES &&
      minutes <= MAX_ECO_IDLE_MINUTES
        ? minutes
        : DEFAULT_ECO_IDLE_MINUTES,
  };
}

/**
 * 不休眠的理由。一个会话可以同时有好几条，巡检只关心是不是空的；列全是为了
 * 用例与日志能说清楚「为什么这个没睡」。
 */
export type HibernationBlocker =
  /** 节点上不是 Agent：普通 shell 里跑着什么，没人能替它接回来。 */
  | "notAgent"
  /** 这个 CLI（或关掉了 `resume` 能力的自定义条目）不能续接。 */
  | "noResume"
  /** 还没报过 provider 会话 id，续接无从谈起。 */
  | "noProviderSession"
  /** SSH 会话：进程在另一台机器上，释放的也不是这台的内存。 */
  | "remote"
  | "working"
  | "awaitingApproval"
  /** 状态不是一条真上报的 idle / done：不知道它在做什么就不动它。 */
  | "unknownState"
  /** 有人正看着（有 socket 附着）。 */
  | "attached"
  /** 输入行上有人打了一半。 */
  | "inputPending"
  /** 驱动租约在谁手里（人抢占、接管，或 Agent 在投递）。 */
  | "leaseHeld"
  /** 投递队列里有它的东西。 */
  | "deliveryQueued"
  /** 前台已经不是这个 Agent 了（退回了 shell，或跑着别的程序）。 */
  | "notAgentPane"
  /** 除了 Agent 还有别的进程：shell 里另开的作业，或 Agent 起在后台的命令。 */
  | "backgroundProcess"
  /** 有计划要投给它。 */
  | "scheduled"
  /** 还没闲够阈值。 */
  | "recentlyActive";

export interface HibernationFacts {
  readonly agentId: string | null;
  readonly resumable: boolean;
  readonly providerSessionId: string | undefined;
  readonly remote: boolean;
  /** `agent_status.state` / `state_source`。 */
  readonly state: string | undefined;
  readonly stateSource: string | undefined;
  readonly attachedSockets: number;
  readonly inputPending: boolean;
  readonly leaseFree: boolean;
  readonly queued: boolean;
  /** `undefined`：问不到前台（后端不答），按「不是」处理。 */
  readonly foregroundIsAgent: boolean | undefined;
  readonly backgroundProcess: boolean;
  readonly scheduled: boolean;
  readonly idleForMs: number;
  readonly thresholdMs: number;
}

const QUIET_STATES = new Set(["idle", "done", "error"]);

/**
 * 判据（设计 §7.2）：成功空闲、无审批、无投递、无人驱动、无半截输入、无后台
 * 进程、无计划即将运行，而且这个 CLI 真能续接。
 *
 * 前台检查排在最后，调用方可以在前面的判据已经不过时省掉那一次 `ps`。
 */
export function hibernationBlockers(
  facts: HibernationFacts,
): HibernationBlocker[] {
  const blockers: HibernationBlocker[] = [];
  if (facts.agentId === null) blockers.push("notAgent");
  else if (!facts.resumable) blockers.push("noResume");
  if (facts.providerSessionId === undefined || facts.providerSessionId === "") {
    blockers.push("noProviderSession");
  }
  if (facts.remote) blockers.push("remote");
  if (facts.state === "working") blockers.push("working");
  else if (facts.state === "blocked" || facts.state === "waiting") {
    blockers.push("awaitingApproval");
  } else if (
    facts.state === undefined ||
    !QUIET_STATES.has(facts.state) ||
    (facts.stateSource !== "hook" && facts.stateSource !== "extension")
  ) {
    // `observed` 或空的来源不算：那条通道上「在等人」这件事根本观测不到。
    blockers.push("unknownState");
  }
  if (facts.attachedSockets > 0) blockers.push("attached");
  if (facts.inputPending) blockers.push("inputPending");
  if (!facts.leaseFree) blockers.push("leaseHeld");
  if (facts.queued) blockers.push("deliveryQueued");
  if (facts.scheduled) blockers.push("scheduled");
  if (facts.idleForMs < facts.thresholdMs) blockers.push("recentlyActive");
  if (facts.foregroundIsAgent !== true) blockers.push("notAgentPane");
  if (facts.backgroundProcess) blockers.push("backgroundProcess");
  return blockers;
}

/**
 * 「只差时间」：除了 `recentlyActive` 之外什么都不挡。状态机里的 `idle`。
 */
export function onlyWaitingForTime(
  blockers: readonly HibernationBlocker[],
): boolean {
  return blockers.length === 1 && blockers[0] === "recentlyActive";
}

/* ------------------------------ 后台进程判定 ------------------------------ */

const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "nu",
  "pwsh",
  "powershell",
  "cmd",
]);

/** argv 的第一个词的文件名；`-zsh` 这种登录 shell 的写法去掉前导的 `-`。 */
export function programName(argv: string): string {
  const first = argv.trim().split(/\s+/)[0] ?? "";
  const base = first.split(/[/\\]/).pop() ?? "";
  const bare = base.startsWith("-") ? base.slice(1) : base;
  return bare.endsWith(".exe") ? bare.slice(0, -4) : bare;
}

export function isShell(argv: string): boolean {
  return SHELLS.has(programName(argv));
}

/**
 * pane 里除了 Agent 还有没有别的活儿。
 *
 * `shellChildren` 是 pane 那个 shell 的**直接**子进程，`agentDescendants` 是
 * Agent 进程下面的整棵树。两条规则：
 *
 *   1. shell 下面不止 Agent 一个：人在同一个 shell 里 `&` 起过别的作业，结束会
 *      话会一起结束它。
 *   2. Agent 下面挂着一个 shell：CLI 执行命令都是起一个 `sh -c`，空闲时还留着的
 *      那个就是它放到后台的命令（开发服务器、watch）。MCP 服务器这类常驻子进程
 *      不是 shell，不算。
 */
export function hasBackgroundWork(
  shellChildren: readonly string[],
  agentDescendants: readonly string[],
): boolean {
  if (shellChildren.length > 1) return true;
  return agentDescendants.some(isShell);
}

/* ------------------------------ 计划的目标 -------------------------------- */

const ACTIVE_PLAN = "AUTOMATION_PLAN_STATE_ACTIVE";
const LAUNCH_FROZEN = "AUTOMATION_COLD_START_POLICY_LAUNCH_FROZEN";

/**
 * 有没有一个激活的计划以这个节点为目标，而且它会因为休眠而落空。
 *
 * 没授权冷启动的计划遇到休眠的节点只会被跳过（设计 §7.2「未启用则记录
 * skipped/target-unavailable」），所以它们在就不休眠；授权了的只在
 * {@link SCHEDULE_GUARD_MS} 之内要到期时才挡——它到期时会自己把会话接回来。
 *
 * 读的是计划的 JSON 载荷。只有旧二进制载荷的计划读不出目标，不在此列：那些
 * 计划在 0020 之后本来就要重新授权。
 */
export function scheduledFor(
  database: DatabaseSync,
  nodeId: string,
  nowMs: number,
): boolean {
  let rows: { payload_json: string | null; next_due_at_ms: number }[];
  try {
    rows = database
      .prepare(
        "SELECT payload_json, next_due_at_ms FROM automation_plans " +
          "WHERE payload_json IS NOT NULL AND instr(payload_json, ?) > 0",
      )
      .all(nodeId) as typeof rows;
  } catch {
    return false;
  }
  for (const row of rows) {
    let plan: Record<string, unknown>;
    try {
      plan = JSON.parse(row.payload_json ?? "") as Record<string, unknown>;
    } catch {
      continue;
    }
    if (plan.state !== ACTIVE_PLAN) continue;
    const config = plan.config as Record<string, unknown> | undefined;
    const target = config?.target as Record<string, unknown> | undefined;
    if (target?.nodeId !== nodeId) continue;
    if (target.coldStartPolicy !== LAUNCH_FROZEN) return true;
    const due = Number(row.next_due_at_ms);
    if (due > 0 && due - nowMs <= SCHEDULE_GUARD_MS) return true;
  }
  return false;
}

/* ------------------------------- 库里的状态 ------------------------------- */

export interface HibernatedSession {
  readonly sessionId: string;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly agentId: string | null;
  readonly endedAt: string | null;
}

/**
 * 这个节点现在是不是休眠着：它**最新**的那一行以休眠结束。
 *
 * 排序与 `loadSession` 同一条——活着的行优先。节点之后被人重新起了一个会话（或
 * 依赖编排、冷启动替它起了），活着的那行排在前面，休眠自然就被取代了，不需要
 * 谁回头去擦那个标记。
 */
export function hibernatedSession(
  database: DatabaseSync,
  nodeId: string,
): HibernatedSession | undefined {
  const row = database
    .prepare(
      "SELECT id, workspace_id, agent_id, status, termination_intent, ended_at " +
        "FROM terminal_sessions WHERE owner_node_id = ? " +
        "ORDER BY (status = 'running') DESC, generation DESC, created_at DESC LIMIT 1",
    )
    .get(nodeId) as Record<string, unknown> | undefined;
  if (row === undefined) return undefined;
  if (row.status === "running" || row.termination_intent !== HIBERNATE_INTENT) {
    return undefined;
  }
  return {
    sessionId: String(row.id),
    nodeId,
    workspaceId: String(row.workspace_id),
    agentId: (row.agent_id as string | null) ?? null,
    endedAt: (row.ended_at as string | null) ?? null,
  };
}

/** 一个工作空间里所有休眠着的节点，给页面挂载时一次读全。 */
export function hibernatedSessions(
  database: DatabaseSync,
  workspaceId: string,
): HibernatedSession[] {
  const rows = database
    .prepare(
      "SELECT DISTINCT owner_node_id FROM terminal_sessions " +
        "WHERE workspace_id = ? AND owner_node_id IS NOT NULL AND termination_intent = ?",
    )
    .all(workspaceId, HIBERNATE_INTENT) as { owner_node_id: string }[];
  const found: HibernatedSession[] = [];
  for (const row of rows) {
    const session = hibernatedSession(database, row.owner_node_id);
    if (session !== undefined) found.push(session);
  }
  return found;
}

/** 这一行是不是以休眠结束的（`GET /api/terminals/{id}` 的 `hibernation` 字段）。 */
export function rowHibernated(row: Record<string, unknown>): boolean {
  return (
    row.status !== "running" && row.termination_intent === HIBERNATE_INTENT
  );
}

/* ------------------------------- 恢复入口 --------------------------------- */

export interface WakeResult {
  readonly sessionId: string;
  readonly generation: number;
}

export type HibernationWaker = (
  nodeId: string,
  reason: WakeReason,
) => Promise<WakeResult>;

/** 谁把它叫醒的：写进日志与事件，页面据此决定要不要提示。 */
export type WakeReason = "focus" | "delivery" | "schedule";

/**
 * 终端域交出来的唤醒入口。
 *
 * 与 `schedule/cold-start.ts` 的启动器同一种接缝：调度域与协作域都排在终端域
 * 之前装配，反过来 import 管理器就是一个环。没有终端域的装配里它缺席。
 */
let waker: HibernationWaker | undefined;

export function setHibernationWaker(next: HibernationWaker | undefined): void {
  waker = next;
}

export function hibernationWaker(): HibernationWaker | undefined {
  return waker;
}
