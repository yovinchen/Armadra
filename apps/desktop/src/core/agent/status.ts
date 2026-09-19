import type { DatabaseSync } from "node:sqlite";
import { rfc3339 } from "../workspaces/support";

/**
 * The `agent_status` table: the reduced per-node agent state and its read
 * receipt.
 *
 * Ported from `apps/runtime/src/db/agent_status.rs`, reads first. The Hook
 * surface writes this row on every report; this domain reads it (the `list`
 * verb, the transcript, the title suggestion, the handoff cutoff) and owns the
 * one write a person makes: clearing the unread badge.
 *
 * Three fields are easy to misread and are spelled out here once:
 *
 *   * `state_source` is which *channel* the state was learned through, derived
 *     by the writer from the provider and never from the payload.
 *   * `last_event_at` is when the report arrived; `updated_at` also moves on a
 *     read receipt and on the stale sweep, so the two are not interchangeable.
 *   * `errored` / `interrupted` are three-valued. `null` is "no verdict yet",
 *     which is a different statement from `false` = "finished cleanly".
 */

/** The `state` values the column accepts. Closed, like the source vocabulary. */
export const AGENT_STATES = [
  "idle",
  "working",
  "waiting",
  "blocked",
  "done",
  "error",
] as const;

export interface AgentStatus {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly state?: string;
  readonly stateSource?: string;
  readonly unread: boolean;
  readonly sessionId?: string;
  readonly pendingId?: string;
  readonly verified: boolean;
  readonly restored: boolean;
  readonly updatedAt: string;
  readonly transcriptPath?: string;
  readonly lastEventAt?: string;
  readonly sessionPhase?: string;
  readonly errored?: boolean;
  readonly interrupted?: boolean;
}

interface StatusRow {
  readonly node_id: string;
  readonly workspace_id: string;
  readonly agent_id: string;
  readonly state: string | null;
  readonly state_source: string | null;
  readonly unread: number;
  readonly session_id: string | null;
  readonly pending_id: string | null;
  readonly verified: number;
  readonly restored: number;
  readonly updated_at: string;
  readonly transcript_path: string | null;
  readonly last_event_at: string | null;
  readonly session_phase: string | null;
  readonly errored: number | null;
  readonly interrupted: number | null;
}

const SELECT =
  "SELECT node_id, workspace_id, agent_id, state, state_source, unread, session_id, " +
  "pending_id, verified, restored, updated_at, transcript_path, last_event_at, " +
  "session_phase, errored, interrupted FROM agent_status ";

/**
 * An absent optional field is **omitted**, not null: the Rust row marks every
 * one of them `skip_serializing_if = "Option::is_none"` and the shared zod
 * schema is written against that.
 */
function statusOf(row: StatusRow): AgentStatus {
  const optional = <T>(key: string, value: T | null) =>
    value === null ? {} : { [key]: value };
  return {
    nodeId: row.node_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    ...optional("state", row.state),
    ...optional("stateSource", row.state_source),
    unread: row.unread !== 0,
    ...optional("sessionId", row.session_id),
    ...optional("pendingId", row.pending_id),
    verified: row.verified !== 0,
    restored: row.restored !== 0,
    updatedAt: row.updated_at,
    ...optional("transcriptPath", row.transcript_path),
    ...optional("lastEventAt", row.last_event_at),
    ...optional("sessionPhase", row.session_phase),
    ...(row.errored === null ? {} : { errored: row.errored !== 0 }),
    ...(row.interrupted === null ? {} : { interrupted: row.interrupted !== 0 }),
  } as AgentStatus;
}

export function getAgentStatus(
  database: DatabaseSync,
  nodeId: string,
): AgentStatus | undefined {
  const row = database.prepare(`${SELECT}WHERE node_id = ?`).get(nodeId) as
    | StatusRow
    | undefined;
  return row === undefined ? undefined : statusOf(row);
}

export interface ReadReceipt {
  readonly status: AgentStatus;
  /** The badge really was on. A no-op read is answered, never broadcast. */
  readonly cleared: boolean;
}

/**
 * Clears the unread badge a finished turn raised.
 *
 * A focused client fires this whenever a turn ends while the node is on
 * screen, so most calls arrive for a node that is already read. Those are
 * answered normally but report `cleared: false`: re-announcing an unchanged
 * row would put one pointless frame on every workspace socket per finished
 * turn.
 */
export function markAgentStatusRead(
  database: DatabaseSync,
  nodeId: string,
): ReadReceipt | undefined {
  const before = getAgentStatus(database, nodeId);
  if (before === undefined) return undefined;
  if (!before.unread) return { status: before, cleared: false };
  database
    .prepare(
      "UPDATE agent_status SET unread = 0, updated_at = ? WHERE node_id = ?",
    )
    .run(rfc3339(), nodeId);
  const after = getAgentStatus(database, nodeId);
  return { status: after ?? before, cleared: true };
}

/**
 * Whether this node is waiting on a human.
 *
 * The judgement the terminal domain's safety gate asks for: a node that is
 * `blocked` or `waiting` has a CLI stopped on a question, and writing into its
 * pane would answer that question with whatever the write happened to be. The
 * gate itself lives in the terminal domain — this is the interface it calls,
 * so there is one definition of "waiting on a human" rather than two.
 *
 * A node nothing has ever reported for is **not** blocked: "we do not know" is
 * not evidence of a prompt, and treating it as one would make every terminal
 * unwritable until its first report arrived.
 */
export function isAwaitingHuman(
  database: DatabaseSync,
  nodeId: string,
): boolean {
  const status = getAgentStatus(database, nodeId);
  if (status === undefined) return false;
  return status.state === "blocked" || status.state === "waiting";
}
