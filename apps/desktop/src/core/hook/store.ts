import type { DatabaseSync } from "node:sqlite";

/**
 * The `agent_status` and `agent_approvals` tables, as the hook surface reads
 * and writes them.
 *
 * Same columns, same values and the same closed vocabularies as
 * `apps/runtime/src/db/agent_status.rs`: both implementations open the same
 * database file during the changeover, so a row written by one has to be a row
 * the other recognises.
 */

export const AGENT_STATES = ["working", "waiting", "blocked", "done"] as const;

/**
 * Which channel a state was learned through (协作通道 §3.2). The vocabulary is
 * closed for the same reason the states are: a value nobody recognises would
 * be read as "not a report" by every gate and as a label by the header, which
 * is two different answers to one question.
 */
export const AGENT_STATE_SOURCES = ["hook", "extension", "observed"] as const;

/**
 * Which transport a provider reports on. Derived from the provider, never
 * parsed out of a payload: an extension and a forked client post identical
 * bodies, so a body that could name its own channel could name the strongest
 * one.
 */
export function stateSourceFor(provider: string): string | undefined {
  switch (provider) {
    case "claude":
    case "codex":
    case "copilot":
      return "hook";
    // Pi, Oh My Pi and opencode report from a module inside the CLI's own
    // process (协作通道 §3.1 channel B). Same socket, same bearer, same node
    // token: a different transport, not a different authority.
    case "pi":
    case "omp":
    case "opencode":
      return "extension";
    default:
      return undefined;
  }
}

export interface AgentStatusRow {
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
  /**
   * Not a column: the reducer attaches the event's message (or the stale
   * sweep's marker) to the copy it publishes. A row read back from SQLite
   * never carries one.
   */
  lastMessage?: string;
}

export interface AgentStatusPatch {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly state: string | undefined;
  readonly stateSource: string | undefined;
  readonly unread: boolean;
  readonly sessionId: string | undefined;
  readonly pendingId: string | undefined;
  readonly verified: boolean;
  readonly transcriptPath: string | undefined;
  readonly sessionPhase: string | undefined;
  readonly errored: boolean | undefined;
  readonly interrupted: boolean | undefined;
  /**
   * When the hook report that produced this state arrived. `undefined` for
   * writes that are not hook reports (the read receipt, the stale sweep),
   * which then keep whatever the row already had.
   */
  readonly lastEventAt: string | undefined;
}

const SELECT =
  "SELECT node_id, workspace_id, agent_id, state, state_source, unread, session_id, " +
  "pending_id, verified, restored, updated_at, transcript_path, last_event_at, " +
  "session_phase, errored, interrupted FROM agent_status ";

type Row = Record<string, unknown>;

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalBool(value: unknown): boolean | undefined {
  return value === null || value === undefined ? undefined : Number(value) !== 0;
}

function statusFromRow(row: Row): AgentStatusRow {
  return {
    nodeId: String(row.node_id),
    workspaceId: String(row.workspace_id),
    agentId: String(row.agent_id),
    ...(optionalText(row.state) === undefined
      ? {}
      : { state: optionalText(row.state) as string }),
    ...(optionalText(row.state_source) === undefined
      ? {}
      : { stateSource: optionalText(row.state_source) as string }),
    unread: Number(row.unread) !== 0,
    ...(optionalText(row.session_id) === undefined
      ? {}
      : { sessionId: optionalText(row.session_id) as string }),
    ...(optionalText(row.pending_id) === undefined
      ? {}
      : { pendingId: optionalText(row.pending_id) as string }),
    verified: Number(row.verified) !== 0,
    restored: Number(row.restored) !== 0,
    updatedAt: String(row.updated_at),
    ...(optionalText(row.transcript_path) === undefined
      ? {}
      : { transcriptPath: optionalText(row.transcript_path) as string }),
    ...(optionalText(row.last_event_at) === undefined
      ? {}
      : { lastEventAt: optionalText(row.last_event_at) as string }),
    ...(optionalText(row.session_phase) === undefined
      ? {}
      : { sessionPhase: optionalText(row.session_phase) as string }),
    ...(optionalBool(row.errored) === undefined
      ? {}
      : { errored: optionalBool(row.errored) as boolean }),
    ...(optionalBool(row.interrupted) === undefined
      ? {}
      : { interrupted: optionalBool(row.interrupted) as boolean }),
  };
}

export function getAgentStatus(
  database: DatabaseSync,
  nodeId: string,
): AgentStatusRow | undefined {
  const row = database
    .prepare(`${SELECT}WHERE node_id = ?`)
    .get(nodeId) as Row | undefined;
  return row === undefined ? undefined : statusFromRow(row);
}

/**
 * Writes the reduced state for one node. A row written by this process is
 * never `restored`; the flag is only set by {@link markAgentStatusRestored} at
 * start-up so the UI can tell a stale `done` from a fresh one.
 */
export function upsertAgentStatus(
  database: DatabaseSync,
  patch: AgentStatusPatch,
  now: string = new Date().toISOString(),
): AgentStatusRow {
  if (
    patch.state !== undefined &&
    !(AGENT_STATES as readonly string[]).includes(patch.state)
  ) {
    throw new Error("Unknown agent state");
  }
  if (
    patch.stateSource !== undefined &&
    !(AGENT_STATE_SOURCES as readonly string[]).includes(patch.stateSource)
  ) {
    throw new Error("Unknown agent state source");
  }
  database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, state_source, unread, session_id, pending_id, " +
        "verified, restored, updated_at, transcript_path, last_event_at, session_phase, errored, interrupted) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(node_id) DO UPDATE SET workspace_id = excluded.workspace_id, agent_id = excluded.agent_id, " +
        "state = excluded.state, state_source = excluded.state_source, unread = excluded.unread, session_id = excluded.session_id, " +
        "pending_id = excluded.pending_id, verified = excluded.verified, restored = 0, updated_at = excluded.updated_at, " +
        "transcript_path = excluded.transcript_path, session_phase = excluded.session_phase, " +
        "errored = excluded.errored, interrupted = excluded.interrupted, " +
        "last_event_at = COALESCE(excluded.last_event_at, agent_status.last_event_at)",
    )
    .run(
      patch.nodeId,
      patch.workspaceId,
      patch.agentId,
      patch.state ?? null,
      patch.stateSource ?? null,
      patch.unread ? 1 : 0,
      patch.sessionId ?? null,
      patch.pendingId ?? null,
      patch.verified ? 1 : 0,
      now,
      patch.transcriptPath ?? null,
      patch.lastEventAt ?? null,
      patch.sessionPhase ?? null,
      patch.errored === undefined ? null : patch.errored ? 1 : 0,
      patch.interrupted === undefined ? null : patch.interrupted ? 1 : 0,
    );
  const written = getAgentStatus(database, patch.nodeId);
  if (written === undefined) {
    throw new Error("Agent status disappeared after writing it");
  }
  return written;
}

/** Called once at start-up: nothing that survived a restart is live knowledge. */
export function markAgentStatusRestored(database: DatabaseSync): number {
  return Number(
    database.prepare("UPDATE agent_status SET restored = 1").run().changes,
  );
}

/**
 * Which workspace a hook report belongs to. A hook only knows its node id, so
 * the terminal session that owns the node is the primary answer; a node that
 * has no session yet (or whose session was recycled away) is still resolvable
 * through the board it lives on.
 */
export interface NodeOwner {
  readonly workspaceId: string;
  /** The agent the session was created with, when there was one. */
  readonly agentId?: string;
}

export function findNodeOwner(
  database: DatabaseSync,
  nodeId: string,
): NodeOwner | undefined {
  const session = database
    .prepare(
      "SELECT workspace_id, agent_id FROM terminal_sessions " +
        "WHERE owner_node_id = ? ORDER BY generation DESC, created_at DESC LIMIT 1",
    )
    .get(nodeId) as Row | undefined;
  if (session !== undefined) {
    const agentId = optionalText(session.agent_id);
    return {
      workspaceId: String(session.workspace_id),
      ...(agentId === undefined ? {} : { agentId }),
    };
  }
  const node = database
    .prepare(
      "SELECT b.workspace_id AS workspace_id FROM nodes n " +
        "JOIN boards b ON b.id = n.board_id WHERE n.id = ?",
    )
    .get(nodeId) as Row | undefined;
  return node === undefined
    ? undefined
    : { workspaceId: String(node.workspace_id) };
}

/**
 * One node a sweep has to close out. Ordered oldest first so a burst is capped
 * fairly.
 */
export interface StaleAgent {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly agentId: string;
}

function staleRows(rows: readonly Row[]): StaleAgent[] {
  return rows.map((row) => ({
    nodeId: String(row.node_id),
    workspaceId: String(row.workspace_id),
    agentId: String(row.agent_id),
  }));
}

export function staleWorkingAgents(
  database: DatabaseSync,
  olderThan: string,
  limit: number,
): StaleAgent[] {
  return staleRows(
    database
      .prepare(
        "SELECT node_id, workspace_id, agent_id FROM agent_status a " +
          "WHERE a.state = 'working' AND COALESCE(a.last_event_at, a.updated_at) < ? " +
          // Neither `agent_status` nor `terminal_sessions` keys on `nodes`, so
          // both outlive a node the user deleted. Closing one out would put a
          // frame on the socket for something that is no longer on the canvas.
          "AND EXISTS (SELECT 1 FROM nodes n WHERE n.id = a.node_id) " +
          "ORDER BY COALESCE(a.last_event_at, a.updated_at) ASC LIMIT ?",
      )
      .all(olderThan, Math.min(500, Math.max(1, limit))) as Row[],
  );
}

/**
 * Nodes whose agent is still shown as live but whose terminal is gone.
 *
 * A hook only reports while its CLI runs, so a terminal that dies mid-turn —
 * killed by the user, or reaped with its pane — leaves the row saying
 * `working` forever. `SessionEnd` cannot cover it: it does not fire on
 * SIGKILL.
 *
 * `endedBefore` is a grace cutoff: a session that has only just ended may
 * still have a final `Stop` in flight, and a synthetic close would race it.
 */
export function agentsWithDeadTerminals(
  database: DatabaseSync,
  endedBefore: string,
  limit: number,
): StaleAgent[] {
  return staleRows(
    database
      .prepare(
        "SELECT a.node_id AS node_id, a.workspace_id AS workspace_id, a.agent_id AS agent_id " +
          "FROM agent_status a " +
          "WHERE a.state IS NOT NULL AND a.state <> 'done' " +
          // A node with no session at all is not ours to close: the CLI may be
          // running in a terminal the user opened, exporting ARMADRA_NODE_ID.
          "AND EXISTS (SELECT 1 FROM terminal_sessions t WHERE t.owner_node_id = a.node_id) " +
          // Same reason as the silence sweep: a deleted node is nobody's to close.
          "AND EXISTS (SELECT 1 FROM nodes n WHERE n.id = a.node_id) " +
          "AND NOT EXISTS ( " +
          "SELECT 1 FROM terminal_sessions t WHERE t.owner_node_id = a.node_id " +
          "AND (t.status = 'running' OR COALESCE(t.ended_at, '') >= ?) " +
          ") " +
          "ORDER BY a.updated_at ASC LIMIT ?",
      )
      .all(endedBefore, Math.min(500, Math.max(1, limit))) as Row[],
  );
}

/* -------------------------------- approvals ------------------------------- */

export interface AgentApproval {
  readonly id: string;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly request: unknown;
  readonly answer?: string;
  readonly answeredBy?: string;
  readonly createdAt: string;
  readonly answeredAt?: string;
}

function approvalFromRow(row: Row): AgentApproval {
  let request: unknown = null;
  try {
    request = JSON.parse(String(row.request_json));
  } catch {
    // A row we cannot parse still describes a request that was made; the
    // audit record is better than nothing.
    request = String(row.request_json);
  }
  const answer = optionalText(row.answer);
  const answeredBy = optionalText(row.answered_by);
  const answeredAt = optionalText(row.answered_at);
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    workspaceId: String(row.workspace_id),
    request,
    ...(answer === undefined ? {} : { answer }),
    ...(answeredBy === undefined ? {} : { answeredBy }),
    createdAt: String(row.created_at),
    ...(answeredAt === undefined ? {} : { answeredAt }),
  };
}

export function getApproval(
  database: DatabaseSync,
  pendingId: string,
): AgentApproval | undefined {
  const row = database
    .prepare(
      "SELECT id, node_id, workspace_id, request_json, answer, answered_by, created_at, answered_at " +
        "FROM agent_approvals WHERE id = ?",
    )
    .get(pendingId) as Row | undefined;
  return row === undefined ? undefined : approvalFromRow(row);
}

export function insertApproval(
  database: DatabaseSync,
  pendingId: string,
  nodeId: string,
  workspaceId: string,
  request: unknown,
  now: string = new Date().toISOString(),
): AgentApproval {
  database
    .prepare(
      "INSERT INTO agent_approvals (id, node_id, workspace_id, request_json, created_at) " +
        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    )
    .run(
      pendingId,
      nodeId,
      workspaceId,
      JSON.stringify(request ?? null),
      now,
    );
  const written = getApproval(database, pendingId);
  if (written === undefined) {
    throw new Error("Approval request was not found");
  }
  return written;
}

/** Why an answer could not be recorded, in the shape the routes report. */
export type AnswerRefusal =
  | "bad_request"
  | "not_found"
  | "conflict";

export type AnswerResult =
  | { readonly ok: true; readonly approval: AgentApproval }
  | { readonly ok: false; readonly reason: AnswerRefusal; readonly message: string };

/**
 * Records the user's decision. Answering twice is a conflict, not a silent
 * overwrite: the first answer is the one the CLI already acted on.
 */
export function answerApproval(
  database: DatabaseSync,
  pendingId: string,
  answer: string,
  answeredBy: string | undefined,
  now: string = new Date().toISOString(),
): AnswerResult {
  if (answer !== "allow" && answer !== "deny") {
    return {
      ok: false,
      reason: "bad_request",
      message: "Approval decision must be allow or deny",
    };
  }
  const existing = getApproval(database, pendingId);
  if (existing === undefined) {
    return {
      ok: false,
      reason: "not_found",
      message: "Approval request was not found",
    };
  }
  if (existing.answer !== undefined) {
    return {
      ok: false,
      reason: "conflict",
      message: "Approval request was already answered",
    };
  }
  database
    .prepare(
      "UPDATE agent_approvals SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ? AND answer IS NULL",
    )
    .run(answer, answeredBy ?? null, now, pendingId);
  const written = getApproval(database, pendingId);
  if (written === undefined) {
    return {
      ok: false,
      reason: "not_found",
      message: "Approval request was not found",
    };
  }
  return { ok: true, approval: written };
}
