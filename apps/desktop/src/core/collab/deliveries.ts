import type { DatabaseSync } from "node:sqlite";
import { getWorkspace } from "../workspaces/table";
import { rfc3339 } from "../workspaces/support";
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
