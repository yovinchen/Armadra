import type { DatabaseSync } from "node:sqlite";
import { getWorkspace } from "../workspaces/table";
import { rfc3339 } from "../workspaces/support";
import { loadNode } from "./nodes";
import { pendingFor, positionOf } from "./send-queue";
import { displayName } from "./control/send";
import type { CollabContext } from "./service";

/**
 * `GET /api/workspaces/{id}/deliveries` — the delivery record panel.
 *
 * Ported from the pre-merge implementation, and **written into again** since
 * `send` landed: the verb that types a peer's message into a terminal is back
 * (设计 `agent-delivery.md` §3.4 最后一段), so this table is the delivery
 * record once more rather than a history that only ever gets shorter. `post`
 * still writes nothing here — a mailbox entry is not a delivery, it is a row
 * its recipient may never read.
 *
 * Rows never contain the message body, only how many characters it had, so
 * this is safe to render verbatim.
 */

export interface AgentDelivery {
  readonly traceId: string;
  readonly workspaceId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly outcome: string;
  readonly receipt: string | null;
  readonly bodyChars: number;
  readonly createdAt: string;
}

interface DeliveryRow {
  readonly trace_id: string;
  readonly workspace_id: string;
  readonly source_node_id: string;
  readonly target_node_id: string;
  readonly outcome: string;
  readonly receipt: string | null;
  readonly body_chars: number;
  readonly created_at: string;
}

export function listDeliveries(
  context: CollabContext,
  workspaceId: string,
  limit: number,
): AgentDelivery[] {
  // The workspace is read first so an unknown id is a 404 rather than an empty
  // list, which is what the Rust route does and what the panel distinguishes.
  getWorkspace(context.database, workspaceId);
  const bounded = Math.min(500, Math.max(1, limit));
  const rows = context.database
    .prepare(
      "SELECT trace_id, workspace_id, source_node_id, target_node_id, outcome, receipt, body_chars, created_at " +
        "FROM agent_deliveries WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(workspaceId, bounded) as unknown as DeliveryRow[];
  return rows.map((row) => ({
    traceId: row.trace_id,
    workspaceId: row.workspace_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    outcome: row.outcome,
    receipt: row.receipt,
    bodyChars: Number(row.body_chars),
    createdAt: row.created_at,
  }));
}

export interface NewDelivery {
  readonly traceId: string;
  readonly workspaceId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly outcome: string;
  /** 队列项 id，或者别的什么让这一行能被追回去的东西。 */
  readonly receipt?: string | undefined;
  readonly bodyChars: number;
}

/**
 * 记一次投递、一次排队或者一次拒绝。
 *
 * 永不抛：这张表是**记录**，而一条投递已经发生的事实不该因为记不下来而被回滚
 * （`board-log.ts` 的同一条规矩）。写不进去时那一次仍然有 board-log 那一行。
 */
export function recordDelivery(
  database: DatabaseSync,
  delivery: NewDelivery,
): void {
  try {
    database
      .prepare(
        "INSERT OR REPLACE INTO agent_deliveries (trace_id, workspace_id, source_node_id, " +
          "target_node_id, outcome, receipt, body_chars, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        delivery.traceId,
        delivery.workspaceId,
        delivery.sourceNodeId,
        delivery.targetNodeId,
        delivery.outcome,
        delivery.receipt ?? null,
        delivery.bodyChars,
        rfc3339(),
      );
  } catch {
    // 见上：记录写不进去不是投递失败。
  }
}

/* --------------------------- 排在目标前面的那些 --------------------------- */

/**
 * 同一条路径上的第二个切片：`?node=` 给的是那个**目标节点**还排着的队
 * （`agent_send_queue`），而不是已经发生过的投递记录。
 *
 * 为什么不新开一条路径：两个答案是同一个问题的两半——「这条边上发生过什么」
 * 与「这条边上还压着什么」，而节点头的「排队 N」要的正是后者。设计 §4.6 的
 * 可见性一行把它写给了目标那一侧的人：排在别人终端前面的东西，被排队的那个
 * 人要能看见，并且能删掉（等于拒收）。
 *
 * 与 `outbox` 的分工是**谁在看**：`outbox` 按发起者切，这里按目标切。两个切片
 * 都不带正文——列表是「有什么排着」，不是「排着的东西说了什么」。
 */
export interface QueuedDelivery {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceNodeId: string;
  /** 发起者的名字（handle），没起名退回标题，再退回 id。 */
  readonly sourceName: string;
  readonly targetNodeId: string;
  readonly origin: string;
  readonly queuedAt: number;
  readonly expiresAt: number;
  readonly position: number;
  readonly bodyChars: number;
  readonly attempts: number;
  /** 上一次没投出去的 code。页面按码取文案，不显示 core 的中文句子。 */
  readonly reason?: string;
}

export function listQueued(
  context: CollabContext,
  workspaceId: string,
  targetNodeId: string,
  now: number,
): QueuedDelivery[] {
  getWorkspace(context.database, workspaceId);
  return pendingFor(context.database, targetNodeId, now)
    .filter((item) => item.workspaceId === workspaceId)
    .map((item) => ({
      id: item.id,
      workspaceId: item.workspaceId,
      sourceNodeId: item.sourceNodeId,
      sourceName: displayName(
        loadNode(context.database, item.sourceNodeId),
        item.sourceNodeId,
      ),
      targetNodeId: item.targetNodeId,
      origin: item.origin,
      queuedAt: item.createdAt,
      expiresAt: item.expiresAt,
      position: positionOf(context.database, item, now),
      bodyChars: [...item.body].length,
      attempts: item.attempts,
      ...(item.lastReason === undefined ? {} : { reason: item.lastReason }),
    }));
}

/**
 * 目标那一侧的人删掉一条排队项——等于拒收（设计 §4.6 的取消一行：人对自己的
 * 终端有最终决定权）。
 *
 * 只删还在排的那些。已经写进 PTY 的那条收不回来，对它说「取消了」就是撒谎，
 * 所以 `delivering` 不在条件里——与 `cancelOwn` 同一条规矩，只是这里按工作空间
 * 而不是按发起者收窄：按下这个按钮的是人，他管的是自己的那块画布。
 */
export function cancelQueued(
  context: CollabContext,
  workspaceId: string,
  id: string,
): boolean {
  getWorkspace(context.database, workspaceId);
  const changes = context.database
    .prepare(
      "UPDATE agent_send_queue SET state = 'cancelled' WHERE id = ? " +
        "AND workspace_id = ? AND state = 'queued'",
    )
    .run(id, workspaceId);
  return Number(changes.changes) > 0;
}
