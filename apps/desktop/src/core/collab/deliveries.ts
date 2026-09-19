import { getWorkspace } from "../workspaces/table";
import type { CollabContext } from "./service";

/**
 * `GET /api/workspaces/{id}/deliveries` — the delivery record panel.
 *
 * Ported from `apps/runtime/src/db/deliveries.rs`. **Deprecated as a
 * collaboration record.** The verbs that typed a peer's message into a
 * terminal are gone, and nothing in this core inserts here any more: a peer's
 * message lives in `agent_mailbox` until its recipient reads it.
 *
 * The table and this reader stay because published rows keep meaning what they
 * meant — a Host wrote some of them, and the panel is a history. Rows never
 * contain the message body, only how many characters it had, so this is safe
 * to render verbatim.
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
