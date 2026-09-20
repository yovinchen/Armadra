import type { DatabaseSync } from "node:sqlite";

/**
 * `agent_send_queue` —— 排在别人终端前面的那一队（设计 `agent-delivery.md` §4.6）。
 *
 * 这个模块只管表。门链在 `control/send.ts`，出队的时机在 `send-pump.ts`；把
 * SQL 单独放在这里的理由只有一条：**容量检查与插入必须是同一条语句**。分成
 * 「先数一数，再插一条」的两步，两个 Agent 同时投同一个目标就会双双通过，而
 * 16 这个上限存在的全部意义就是它不能被突破（§4.6 的容量一行，与
 * `mailbox.ts` 的条件插入同一手法）。
 *
 * 一条 `send` 不管投没投出去都在这张表里留一行：直接投出去的那些落 `done`，
 * 排队的落 `queued`。这不是记账癖——`--key` 的幂等要对**两种**结果都成立，
 * 而「已经投过了」的证据只能来自一张表。出队重跑门链时走的也是同一行，所以
 * 第一条任务与第二条任务真的是同一条路（§8.3 第 4 条）。
 */

/** 五分钟。五分钟前的指令投进去多半已经过时（契约 §5.7 第 9 条）。 */
export const SEND_QUEUE_TTL_SECONDS = 300;

/** 每个目标最多排这么多；满了回 `QUEUE_FULL`。 */
export const SEND_QUEUE_MAX_PER_TARGET = 16;

/** 三条入口，一条队列（§4.6、§5 第 1 条）。 */
export type QueueOrigin = "send" | "mailbox-wake" | "first-task";

export type QueueState =
  | "queued"
  | "delivering"
  | "done"
  | "cancelled"
  | "expired";

/** 还在排的那些状态。容量只数这两个。 */
const PENDING: readonly QueueState[] = ["queued", "delivering"];

export interface QueueItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly origin: QueueOrigin;
  readonly messageKey?: string;
  readonly body: string;
  readonly hops: number;
  /** 来源节点 id 链，最近的一跳在前（§7）。 */
  readonly trail: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly attempts: number;
  readonly state: QueueState;
  /** 上一次没投出去的 code。排队回执里的 `reason` 就是它。 */
  readonly lastReason?: string;
}

interface QueueRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly source_node_id: string;
  readonly target_node_id: string;
  readonly origin: string;
  readonly message_key: string | null;
  readonly body: string;
  readonly hops: number;
  readonly trail: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly attempts: number;
  readonly state: string;
  readonly last_reason: string | null;
}

const COLUMNS =
  "id, workspace_id, source_node_id, target_node_id, origin, message_key, body, " +
  "hops, trail, created_at, expires_at, attempts, state, last_reason";

function itemOf(row: QueueRow): QueueItem {
  let trail: string[] = [];
  try {
    const parsed = JSON.parse(row.trail) as unknown;
    if (Array.isArray(parsed)) {
      trail = parsed.filter(
        (entry): entry is string => typeof entry === "string",
      );
    }
  } catch {
    trail = [];
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    origin: row.origin as QueueOrigin,
    ...(row.message_key === null ? {} : { messageKey: row.message_key }),
    body: row.body,
    hops: Number(row.hops),
    trail,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    attempts: Number(row.attempts),
    state: row.state as QueueState,
    ...(row.last_reason === null ? {} : { lastReason: row.last_reason }),
  };
}

export interface NewQueueItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly origin: QueueOrigin;
  readonly messageKey?: string | undefined;
  readonly body: string;
  readonly hops: number;
  readonly trail: readonly string[];
  readonly now: number;
  /** 直接投出去的那一条一落库就是 `done`；排队的是 `queued`。 */
  readonly state: Extract<QueueState, "queued" | "done">;
  readonly lastReason?: string | undefined;
}

export type InsertOutcome =
  /** 新的一行。 */
  | { readonly kind: "inserted"; readonly item: QueueItem }
  /** 同源、同目标、同 key、同正文的重发：原来那一行原样答回去。 */
  | { readonly kind: "duplicate"; readonly item: QueueItem }
  /** 同 key 不同正文。 */
  | { readonly kind: "conflict"; readonly item: QueueItem }
  /** 目标排满了。 */
  | { readonly kind: "full" };

/**
 * 插入一条，容量检查与插入是同一条语句。
 *
 * `--key` 的幂等在这条语句**之前**回答，理由是幂等的窗口比「还在排队」宽：
 * 一条刚刚投出去的 `done` 行同样要挡住同 key 的重发，否则「重试是安全的」这
 * 句话在直接投递那条路上就不成立（§3.3）。
 */
export function enqueue(
  database: DatabaseSync,
  item: NewQueueItem,
): InsertOutcome {
  if (item.messageKey !== undefined) {
    const existing = findByKey(
      database,
      item.sourceNodeId,
      item.targetNodeId,
      item.messageKey,
      item.now,
    );
    if (existing !== undefined) {
      return existing.body === item.body
        ? { kind: "duplicate", item: existing }
        : { kind: "conflict", item: existing };
    }
  }
  const expiresAt = item.now + SEND_QUEUE_TTL_SECONDS;
  const changes = database
    .prepare(
      `INSERT OR IGNORE INTO agent_send_queue (${COLUMNS}) ` +
        "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ? WHERE " +
        "(SELECT COUNT(*) FROM agent_send_queue WHERE target_node_id = ? " +
        "AND state IN ('queued','delivering') AND expires_at > ?) < ?",
    )
    .run(
      item.id,
      item.workspaceId,
      item.sourceNodeId,
      item.targetNodeId,
      item.origin,
      item.messageKey ?? null,
      item.body,
      item.hops,
      JSON.stringify([...item.trail]),
      item.now,
      expiresAt,
      item.state,
      item.lastReason ?? null,
      item.targetNodeId,
      item.now,
      SEND_QUEUE_MAX_PER_TARGET,
    );
  if (Number(changes.changes) === 0) return { kind: "full" };
  const stored = byId(database, item.id);
  return stored === undefined
    ? { kind: "full" }
    : { kind: "inserted", item: stored };
}

export function byId(
  database: DatabaseSync,
  id: string,
): QueueItem | undefined {
  const row = database
    .prepare(`SELECT ${COLUMNS} FROM agent_send_queue WHERE id = ?`)
    .get(id) as QueueRow | undefined;
  return row === undefined ? undefined : itemOf(row);
}

/** 同源、同目标、同 key 的最近一条，还在幂等窗口里的。 */
export function findByKey(
  database: DatabaseSync,
  sourceNodeId: string,
  targetNodeId: string,
  messageKey: string,
  now: number,
): QueueItem | undefined {
  const row = database
    .prepare(
      `SELECT ${COLUMNS} FROM agent_send_queue WHERE source_node_id = ? ` +
        "AND target_node_id = ? AND message_key = ? AND expires_at > ? " +
        "AND state IN ('queued','delivering','done') ORDER BY created_at DESC LIMIT 1",
    )
    .get(sourceNodeId, targetNodeId, messageKey, now) as QueueRow | undefined;
  return row === undefined ? undefined : itemOf(row);
}

/** 这个目标还排着的那些，最早的在前。 */
export function pendingFor(
  database: DatabaseSync,
  targetNodeId: string,
  now: number,
): QueueItem[] {
  const rows = database
    .prepare(
      `SELECT ${COLUMNS} FROM agent_send_queue WHERE target_node_id = ? ` +
        "AND state IN ('queued','delivering') AND expires_at > ? ORDER BY created_at, id",
    )
    .all(targetNodeId, now) as unknown as QueueRow[];
  return rows.map(itemOf);
}

/** 这个目标排着几条。节点头的「排队 N」用它。 */
export function pendingCountFor(
  database: DatabaseSync,
  targetNodeId: string,
  now: number,
): number {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS total FROM agent_send_queue WHERE target_node_id = ? " +
        "AND state IN ('queued','delivering') AND expires_at > ?",
    )
    .get(targetNodeId, now) as { total: number };
  return Number(row.total);
}

/** 一条排队项在它那个目标的队伍里排第几（从 1 数）。 */
export function positionOf(
  database: DatabaseSync,
  item: QueueItem,
  now: number,
): number {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS before FROM agent_send_queue WHERE target_node_id = ? " +
        "AND state IN ('queued','delivering') AND expires_at > ? " +
        "AND (created_at < ? OR (created_at = ? AND id <= ?))",
    )
    .get(item.targetNodeId, now, item.createdAt, item.createdAt, item.id) as {
    before: number;
  };
  return Math.max(1, Number(row.before));
}

/** 发起者的待投列表（`canvas outbox`）。 */
export function outboxFor(
  database: DatabaseSync,
  sourceNodeId: string,
  targetNodeId: string | undefined,
  limit: number,
  now: number,
): QueueItem[] {
  const rows = database
    .prepare(
      `SELECT ${COLUMNS} FROM agent_send_queue WHERE source_node_id = ? ` +
        "AND state IN ('queued','delivering') AND expires_at > ? " +
        (targetNodeId === undefined ? "" : "AND target_node_id = ? ") +
        "ORDER BY created_at, id LIMIT ?",
    )
    .all(
      ...(targetNodeId === undefined
        ? [sourceNodeId, now, limit]
        : [sourceNodeId, now, targetNodeId, limit]),
    ) as unknown as QueueRow[];
  return rows.map(itemOf);
}

/**
 * `queued → delivering`，一条 SQL。
 *
 * 串行门就是这一条：同一目标同时只有一条 `delivering`，而「有没有别人正在投」
 * 这个问题不能由两次查询回答。返回 `false` 表示这一条已经被别人拿走了、取消
 * 了、或者过期了。
 */
export function claim(
  database: DatabaseSync,
  id: string,
  targetNodeId: string,
  now: number,
): QueueItem | undefined {
  const changes = database
    .prepare(
      "UPDATE agent_send_queue SET state = 'delivering', attempts = attempts + 1 " +
        "WHERE id = ? AND state = 'queued' AND expires_at > ? " +
        "AND NOT EXISTS (SELECT 1 FROM agent_send_queue other " +
        "WHERE other.target_node_id = ? AND other.state = 'delivering')",
    )
    .run(id, now, targetNodeId);
  return Number(changes.changes) === 0 ? undefined : byId(database, id);
}

/** 投出去了 / 被取消了 / 过期了。 */
export function settle(
  database: DatabaseSync,
  id: string,
  state: QueueState,
  reason?: string,
): void {
  database
    .prepare(
      "UPDATE agent_send_queue SET state = ?, last_reason = ? WHERE id = ?",
    )
    .run(state, reason ?? null, id);
}

/** 没投成，退回队列，记下这一次的 code。 */
export function requeue(
  database: DatabaseSync,
  id: string,
  reason: string,
): void {
  database
    .prepare(
      "UPDATE agent_send_queue SET state = 'queued', last_reason = ? " +
        "WHERE id = ? AND state IN ('queued','delivering')",
    )
    .run(reason, id);
}

/**
 * 发起者取消自己的一条。只有还在排的才取消得掉——已经写进 PTY 的那条收不回来，
 * 说「取消了」就是撒谎。
 */
export function cancelOwn(
  database: DatabaseSync,
  sourceNodeId: string,
  id: string,
): boolean {
  const changes = database
    .prepare(
      "UPDATE agent_send_queue SET state = 'cancelled' WHERE id = ? " +
        "AND source_node_id = ? AND state = 'queued'",
    )
    .run(id, sourceNodeId);
  return Number(changes.changes) > 0;
}

/**
 * 过期清扫：排过头的标 `expired`，终态里放够久的删掉。
 *
 * 不轮询队列本身（出队由 `agent.status` 驱动），这一遍只是让表不会无限长，
 * 并让「五分钟前那条指令」有一个明确的死亡时刻而不是永远等着（§4.6）。
 */
export function expireQueue(database: DatabaseSync, now: number): number {
  const expired = database
    .prepare(
      "UPDATE agent_send_queue SET state = 'expired' WHERE expires_at <= ? " +
        "AND state IN ('queued','delivering')",
    )
    .run(now);
  database
    .prepare(
      "DELETE FROM agent_send_queue WHERE state IN ('done','cancelled','expired') " +
        "AND expires_at <= ?",
    )
    .run(now - SEND_QUEUE_TTL_SECONDS);
  return Number(expired.changes);
}

/** 还排着的目标，出队泵扫一遍时问它。 */
export function targetsWithPending(
  database: DatabaseSync,
  now: number,
): string[] {
  const rows = database
    .prepare(
      "SELECT DISTINCT target_node_id FROM agent_send_queue " +
        "WHERE state = 'queued' AND expires_at > ?",
    )
    .all(now) as unknown as { target_node_id: string }[];
  return rows.map((row) => row.target_node_id);
}

export { PENDING as QUEUE_PENDING_STATES };
