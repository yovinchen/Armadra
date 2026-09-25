import type { DatabaseSync } from "node:sqlite";
import { uuidV7 } from "../workspaces/support";

/**
 * 依赖编排的两张表（迁移 0027）。
 *
 * 这里只有读写，没有判断：「这一次上报算不算上游那一轮结束」在
 * `evaluate.ts`，「条件满足之后做什么」在 `service.ts`。拆开是为了让判定可以
 * 用字面量逐条测，而不必每条用例都起一个数据库。
 */

/** `current`：上游手上这一轮；`next`：上游下一次成功结束。 */
export const DEPENDENCY_CONDITIONS = ["current", "next"] as const;
export type DependencyCondition = (typeof DEPENDENCY_CONDITIONS)[number];

export type DependencyState =
  | "waiting"
  | "satisfied"
  | "failed"
  | "missing"
  | "expired"
  | "cancelled";

export type LaunchState = "waiting" | "launched" | "failed";

/** 缺省等多久。一天：一轮再长也不该让一个节点悬着过夜还没人发现。 */
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
/** `--ttl` 的上限（分钟）：一周。 */
export const MAX_TTL_MINUTES = 7 * 24 * 60;

export interface DependencyRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly downstreamNodeId: string;
  readonly upstreamNodeId: string;
  readonly condition: DependencyCondition;
  readonly baselineState: string | null;
  readonly baselineEventAt: string | null;
  readonly observedBusy: boolean;
  readonly state: DependencyState;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly resolvedAt: number | null;
}

export interface LaunchRow {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly boardId: string;
  readonly taskBody: string | null;
  readonly taskSourceNodeId: string | null;
  readonly taskHops: number;
  readonly taskTrail: readonly string[];
  readonly state: LaunchState;
  readonly reason: string | null;
  readonly attempts: number;
  readonly sessionId: string | null;
  readonly taskQueueId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly launchedAt: number | null;
}

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function dependencyOf(row: Row): DependencyRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    downstreamNodeId: String(row.downstream_node_id),
    upstreamNodeId: String(row.upstream_node_id),
    condition: String(row.condition) as DependencyCondition,
    baselineState: text(row.baseline_state),
    baselineEventAt: text(row.baseline_event_at),
    observedBusy: Number(row.observed_busy) !== 0,
    state: String(row.state) as DependencyState,
    reason: text(row.reason),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    expiresAt: Number(row.expires_at),
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
  };
}

function trailOf(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]")) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function launchOf(row: Row): LaunchRow {
  return {
    nodeId: String(row.node_id),
    workspaceId: String(row.workspace_id),
    boardId: String(row.board_id),
    taskBody: text(row.task_body),
    taskSourceNodeId: text(row.task_source_node_id),
    taskHops: Number(row.task_hops),
    taskTrail: trailOf(row.task_trail),
    state: String(row.state) as LaunchState,
    reason: text(row.reason),
    attempts: Number(row.attempts),
    sessionId: text(row.session_id),
    taskQueueId: text(row.task_queue_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    launchedAt: row.launched_at === null ? null : Number(row.launched_at),
  };
}

/* ---------------------------------- 写入 ---------------------------------- */

export interface NewLaunch {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly boardId: string;
  readonly task?:
    | {
        readonly body: string;
        readonly sourceNodeId: string;
        readonly hops: number;
        readonly trail: readonly string[];
      }
    | undefined;
  readonly now: number;
}

export interface NewDependency {
  readonly upstreamNodeId: string;
  readonly condition: DependencyCondition;
  readonly baselineState: string | null;
  readonly baselineEventAt: string | null;
  readonly observedBusy: boolean;
  /** 创建时就已经成立（`current` 且上游已经干净地结束）。 */
  readonly satisfied: boolean;
  readonly expiresAt: number;
}

/**
 * 一次启动与它的全部边，同一个事务。
 *
 * 同一个下游再来一次（旧 `pendingLaunch` 迁入时页面重试）不重复插：启动行已
 * 在就不动它，边按 (下游, 上游) 唯一。
 */
export function insertLaunch(
  database: DatabaseSync,
  launch: NewLaunch,
  edges: readonly NewDependency[],
): { readonly launch: LaunchRow; readonly dependencies: DependencyRow[] } {
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        "INSERT OR IGNORE INTO agent_dependency_launches (node_id, workspace_id, board_id, " +
          "task_body, task_source_node_id, task_hops, task_trail, state, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)",
      )
      .run(
        launch.nodeId,
        launch.workspaceId,
        launch.boardId,
        launch.task?.body ?? null,
        launch.task?.sourceNodeId ?? null,
        launch.task?.hops ?? 0,
        JSON.stringify([...(launch.task?.trail ?? [])]),
        launch.now,
        launch.now,
      );
    const insert = database.prepare(
      "INSERT OR IGNORE INTO agent_dependencies (id, workspace_id, downstream_node_id, " +
        "upstream_node_id, condition, baseline_state, baseline_event_at, observed_busy, state, " +
        "created_at, updated_at, expires_at, resolved_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const edge of edges) {
      insert.run(
        uuidV7(),
        launch.workspaceId,
        launch.nodeId,
        edge.upstreamNodeId,
        edge.condition,
        edge.baselineState,
        edge.baselineEventAt,
        edge.observedBusy ? 1 : 0,
        edge.satisfied ? "satisfied" : "waiting",
        launch.now,
        launch.now,
        edge.expiresAt,
        edge.satisfied ? launch.now : null,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return {
    launch: launchFor(database, launch.nodeId) as LaunchRow,
    dependencies: dependenciesOf(database, launch.nodeId),
  };
}

/**
 * 把一条还在等的边改成终态。条件写在 `WHERE` 里：两条路径（事件与扫描）同时
 * 判到同一条边，只有先到的那一次算数。
 */
export function resolveDependency(
  database: DatabaseSync,
  id: string,
  state: Exclude<DependencyState, "waiting">,
  reason: string | null,
  now: number,
  from: readonly DependencyState[] = ["waiting"],
): boolean {
  const marks = from.map(() => "?").join(", ");
  const changes = database
    .prepare(
      "UPDATE agent_dependencies SET state = ?, reason = ?, updated_at = ?, resolved_at = ? " +
        `WHERE id = ? AND state IN (${marks})`,
    )
    .run(state, reason, now, now, id, ...from);
  return Number(changes.changes) > 0;
}

/** 基准之后见过上游忙：之后的第一次 done 就是这一轮的结束。 */
export function markObservedBusy(
  database: DatabaseSync,
  id: string,
  now: number,
): void {
  database
    .prepare(
      "UPDATE agent_dependencies SET observed_busy = 1, updated_at = ? " +
        "WHERE id = ? AND state = 'waiting' AND observed_busy = 0",
    )
    .run(now, id);
}

/**
 * `next` 等的是**成功**的那一次：失败的一轮不放行，也不能在下一次评估里再被
 * 当成「基准之后的结束」读一遍，所以基准挪到这一次。
 */
export function rebaseline(
  database: DatabaseSync,
  id: string,
  state: string | null,
  eventAt: string | null,
  reason: string,
  now: number,
): void {
  database
    .prepare(
      "UPDATE agent_dependencies SET baseline_state = ?, baseline_event_at = ?, " +
        "observed_busy = 0, reason = ?, updated_at = ? WHERE id = ? AND state = 'waiting'",
    )
    .run(state, eventAt, reason, now, id);
}

export function markLaunched(
  database: DatabaseSync,
  nodeId: string,
  sessionId: string,
  taskQueueId: string | null,
  now: number,
): void {
  database
    .prepare(
      "UPDATE agent_dependency_launches SET state = 'launched', reason = NULL, session_id = ?, " +
        "task_queue_id = ?, launched_at = ?, updated_at = ? WHERE node_id = ?",
    )
    .run(sessionId, taskQueueId, now, now, nodeId);
}

export function noteLaunchAttempt(
  database: DatabaseSync,
  nodeId: string,
  reason: string | null,
  failed: boolean,
  now: number,
): LaunchRow | undefined {
  database
    .prepare(
      "UPDATE agent_dependency_launches SET attempts = attempts + 1, reason = ?, " +
        "state = CASE WHEN ? THEN 'failed' ELSE state END, updated_at = ? " +
        "WHERE node_id = ? AND state = 'waiting'",
    )
    .run(reason, failed ? 1 : 0, now, nodeId);
  return launchFor(database, nodeId);
}

/** 下游节点已经不在了：它的启动与边一起删。 */
export function forgetLaunch(database: DatabaseSync, nodeId: string): void {
  database
    .prepare("DELETE FROM agent_dependency_launches WHERE node_id = ?")
    .run(nodeId);
}

/* ---------------------------------- 读取 ---------------------------------- */

export function launchFor(
  database: DatabaseSync,
  nodeId: string,
): LaunchRow | undefined {
  const row = database
    .prepare("SELECT * FROM agent_dependency_launches WHERE node_id = ?")
    .get(nodeId) as Row | undefined;
  return row === undefined ? undefined : launchOf(row);
}

export function dependencyById(
  database: DatabaseSync,
  id: string,
): DependencyRow | undefined {
  const row = database
    .prepare("SELECT * FROM agent_dependencies WHERE id = ?")
    .get(id) as Row | undefined;
  return row === undefined ? undefined : dependencyOf(row);
}

export function dependenciesOf(
  database: DatabaseSync,
  downstreamNodeId: string,
): DependencyRow[] {
  return (
    database
      .prepare(
        "SELECT * FROM agent_dependencies WHERE downstream_node_id = ? ORDER BY created_at, id",
      )
      .all(downstreamNodeId) as Row[]
  ).map(dependencyOf);
}

/** 等着 `upstreamNodeId` 的那些边。 */
export function waitingOn(
  database: DatabaseSync,
  upstreamNodeId: string,
): DependencyRow[] {
  return (
    database
      .prepare(
        "SELECT * FROM agent_dependencies WHERE upstream_node_id = ? AND state = 'waiting'",
      )
      .all(upstreamNodeId) as Row[]
  ).map(dependencyOf);
}

/** 全部还在等的边；扫描与重启恢复用。 */
export function allWaiting(database: DatabaseSync): DependencyRow[] {
  return (
    database
      .prepare("SELECT * FROM agent_dependencies WHERE state = 'waiting'")
      .all() as Row[]
  ).map(dependencyOf);
}

/** 还没启动的那些下游。 */
export function pendingLaunches(database: DatabaseSync): LaunchRow[] {
  return (
    database
      .prepare(
        "SELECT * FROM agent_dependency_launches WHERE state = 'waiting' ORDER BY created_at",
      )
      .all() as Row[]
  ).map(launchOf);
}

export interface WorkspaceListing {
  readonly launch: LaunchRow;
  readonly dependencies: DependencyRow[];
}

/**
 * 一个工作空间里的依赖，按下游分组。缺省只给**还没了结**的：没启动的下游，
 * 或者启动失败的；已经启动的那些只是历史。
 */
export function listForWorkspace(
  database: DatabaseSync,
  workspaceId: string,
  options: { readonly nodeId?: string; readonly all?: boolean } = {},
): WorkspaceListing[] {
  const clauses = ["workspace_id = ?"];
  const params: string[] = [workspaceId];
  if (options.nodeId !== undefined) {
    clauses.push("node_id = ?");
    params.push(options.nodeId);
  }
  if (options.all !== true) clauses.push("state != 'launched'");
  const launches = (
    database
      .prepare(
        `SELECT * FROM agent_dependency_launches WHERE ${clauses.join(" AND ")} ORDER BY created_at`,
      )
      .all(...params) as Row[]
  ).map(launchOf);
  return launches.map((launch) => ({
    launch,
    dependencies: dependenciesOf(database, launch.nodeId),
  }));
}

/** `downstream` 等着的全部上游（只看还在等的边），查环用。 */
export function upstreamsOf(
  database: DatabaseSync,
  downstreamNodeId: string,
): string[] {
  return (
    database
      .prepare(
        "SELECT upstream_node_id FROM agent_dependencies WHERE downstream_node_id = ? " +
          "AND state = 'waiting'",
      )
      .all(downstreamNodeId) as { upstream_node_id: string }[]
  ).map((row) => row.upstream_node_id);
}
