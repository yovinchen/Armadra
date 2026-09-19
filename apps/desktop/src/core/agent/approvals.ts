import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { baseAgent } from "./registry";
import { agentIdOf, loadNode, loadSession } from "../collab/nodes";
import type { CollabContext } from "../collab/service";
import { conflict, badRequest, notFound, rfc3339 } from "../workspaces/support";
import { getAgentStatus } from "./status";

/**
 * Permission answers — the round trip closed by an answer file, and the CAS
 * that makes it singular.
 *
 * Ported from `apps/runtime/src/collab/approvals.rs` and
 * `apps/runtime/src/db/approvals.rs`, with the cross-device rule the Go Host
 * added on top (`apps/host/internal/agenthost/approvals.go`).
 *
 * **The order is the design.** A CLI that asks for permission stops: it is
 * blocked on a read of a file this process will write. Everything here exists
 * so the answer can be given from somewhere other than this machine — a phone,
 * a second laptop — and given exactly once. So the decision is recorded
 * *first*, under a revision CAS, and only then is the machine told:
 *
 *   * Recording first is what makes "answered exactly once" true. Two devices
 *     that both read a pending approval both try to write revision 1, and the
 *     second is refused before any file is touched. Asking the machine first
 *     would let both writes land and leave the record describing whichever
 *     returned last.
 *   * A failure after the record is honest rather than lost. Somebody did
 *     answer; what failed is that the machine did not hear, and that is a
 *     state a person can act on.
 *
 * Every attempt — the winner and the loser — is written to
 * `agent_approval_audit`. Keeping only the winner would throw away the whole
 * value of the mutual exclusion: which device asked, in which order, and what
 * the loser was told.
 */

/** Pending files older than this are the remains of a client that went away. */
export const ORPHAN_MINUTES = 10;
/** `ARMADRA_PERM_WAIT_SECS` for a CLI that supports hook replies. */
export const PERM_WAIT_SECONDS = 45;

export const DECISIONS = ["allow", "deny"] as const;

export type ApprovalRoute = "file" | "keys" | "none";

export interface AgentApproval {
  readonly id: string;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly request: unknown;
  readonly answer: string | null;
  readonly answeredBy: string | null;
  readonly createdAt: string;
  readonly answeredAt: string | null;
  /** The CAS column. 0 means nothing has answered it yet. */
  readonly revision: number;
}

interface ApprovalRow {
  readonly id: string;
  readonly node_id: string;
  readonly workspace_id: string;
  readonly request_json: string;
  readonly answer: string | null;
  readonly answered_by: string | null;
  readonly created_at: string;
  readonly answered_at: string | null;
  readonly revision: number;
}

const SELECT =
  "SELECT id, node_id, workspace_id, request_json, answer, answered_by, " +
  "created_at, answered_at, revision FROM agent_approvals ";

function approvalOf(row: ApprovalRow): AgentApproval {
  let request: unknown = null;
  try {
    request = JSON.parse(row.request_json);
  } catch {
    request = null;
  }
  return {
    id: row.id,
    nodeId: row.node_id,
    workspaceId: row.workspace_id,
    request,
    answer: row.answer,
    answeredBy: row.answered_by,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    revision: Number(row.revision),
  };
}

export function getApproval(
  context: CollabContext,
  pendingId: string,
): AgentApproval {
  const row = context.database
    .prepare(`${SELECT}WHERE id = ?`)
    .get(pendingId) as ApprovalRow | undefined;
  if (row === undefined) throw notFound("Approval request was not found");
  return approvalOf(row);
}

export function insertApproval(
  context: CollabContext,
  options: {
    readonly pendingId: string;
    readonly nodeId: string;
    readonly workspaceId: string;
    readonly request: unknown;
    readonly sessionId?: string;
    readonly generation?: number;
  },
): AgentApproval {
  context.database
    .prepare(
      "INSERT INTO agent_approvals (id, node_id, workspace_id, request_json, created_at, session_id, generation) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    )
    .run(
      options.pendingId,
      options.nodeId,
      options.workspaceId,
      JSON.stringify(options.request ?? null),
      rfc3339(),
      options.sessionId ?? null,
      options.generation ?? 0,
    );
  return getApproval(context, options.pendingId);
}

export interface AnswerRequest {
  readonly decision: string;
  /** Who answered. The local user is `user`; a peer device is its principal. */
  readonly answeredBy?: string;
  /**
   * The revision the caller read. `undefined` means "whatever is current",
   * which is what a single-device answer means — the CAS still refuses a
   * second answer, because an answered row is not open to being answered.
   */
  readonly expectedRevision?: number;
}

export interface AnswerResult {
  readonly approval: AgentApproval;
  readonly route: ApprovalRoute;
}

/**
 * Records the user's decision and gets it back to the waiting CLI.
 *
 * Two routes out. When the hook client wrote `<data>/pending/<id>.json` and is
 * polling, an answer file is the deterministic path: the CLI receives the
 * decision through its own hook protocol. Otherwise the answer is typed into
 * the PTY the way a human would press the key, which depends on the prompt
 * still being on screen and is therefore reported as `route: "keys"`.
 */
export async function answerApproval(
  context: CollabContext,
  pendingId: string,
  request: AnswerRequest,
): Promise<AnswerResult> {
  if (!validPendingId(pendingId)) {
    throw badRequest("Approval id is invalid");
  }
  const decision = request.decision;
  const answeredBy = request.answeredBy ?? "user";
  if (!(DECISIONS as readonly string[]).includes(decision)) {
    // Audited even though nothing could have been written: a device sending a
    // decision this build does not know is worth seeing in the trail.
    const existing = getApproval(context, pendingId);
    audit(context, existing, {
      decision,
      answeredBy,
      expectedRevision: request.expectedRevision ?? existing.revision,
      accepted: false,
      route: "",
      refusal: "decision_invalid",
    });
    throw badRequest("Approval decision must be allow or deny");
  }

  const existing = getApproval(context, pendingId);
  const expected = request.expectedRevision ?? existing.revision;

  // A question somebody has already decided is not one to decide again.
  // Reloading would not produce a state in which answering is right, so this
  // is its own refusal rather than a revision conflict.
  if (existing.answer !== null) {
    audit(context, existing, {
      decision,
      answeredBy,
      expectedRevision: expected,
      accepted: false,
      route: "",
      refusal: "already_answered",
    });
    throw conflict("Approval request was already answered");
  }

  const next = existing.revision + 1;
  const updated = context.database
    .prepare(
      "UPDATE agent_approvals SET answer = ?, answered_by = ?, answered_at = ?, revision = ? " +
        "WHERE id = ? AND answer IS NULL AND revision = ?",
    )
    .run(decision, answeredBy, rfc3339(), next, pendingId, expected);
  if (Number(updated.changes) === 0) {
    // Somebody else got there between the read and the write. This is the
    // whole point of the column: the loser never touches a file.
    audit(context, existing, {
      decision,
      answeredBy,
      expectedRevision: expected,
      accepted: false,
      route: "",
      refusal: "revision_conflict",
    });
    throw conflict("Approval request was already answered");
  }

  const approval = getApproval(context, pendingId);

  // The decision is recorded. Telling the machine is a separate step, and its
  // failure is reported as itself: the answer stands, and what could not
  // happen is the CLI hearing it.
  let route: ApprovalRoute = "none";
  if (writeAnswerFile(pendingDir(context), pendingId, decision)) {
    route = "file";
  } else if (await typeIntoPty(context, approval, decision)) {
    route = "keys";
  }

  audit(context, approval, {
    decision,
    answeredBy,
    expectedRevision: expected,
    applied: next,
    accepted: true,
    route,
    refusal: "",
  });

  context.publish(approval.workspaceId, {
    type: "agent.approval",
    nodeId: approval.nodeId,
    pendingId: approval.id,
    // Resolution reuses the event: `request.resolved` tells a client this is
    // the answer rather than a new question.
    request: resolvedPayload(approval, decision, route),
  });
  return { approval, route };
}

function resolvedPayload(
  approval: AgentApproval,
  decision: string,
  route: ApprovalRoute,
): Record<string, unknown> {
  return { ...approval, resolved: true, decision, answer: decision, route };
}

/* ---------------------------------- audit --------------------------------- */

export interface AuditEntry {
  readonly decision: string;
  readonly answeredBy: string;
  readonly expectedRevision: number;
  readonly applied?: number;
  readonly accepted: boolean;
  readonly route: string;
  readonly refusal: string;
}

function audit(
  context: CollabContext,
  approval: AgentApproval,
  entry: AuditEntry,
): void {
  context.database
    .prepare(
      "INSERT INTO agent_approval_audit (approval_id, node_id, workspace_id, decision, answered_by, " +
        "expected_revision, applied_revision, accepted, route, refusal, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      approval.id,
      approval.nodeId,
      approval.workspaceId,
      entry.decision,
      entry.answeredBy,
      entry.expectedRevision,
      entry.applied ?? null,
      entry.accepted ? 1 : 0,
      entry.route,
      entry.refusal,
      rfc3339(),
    );
}

export interface AuditRow {
  readonly approvalId: string;
  readonly decision: string;
  readonly answeredBy: string;
  readonly expectedRevision: number;
  readonly appliedRevision: number | null;
  readonly accepted: boolean;
  readonly route: string;
  readonly refusal: string;
  readonly createdAt: string;
}

/** The trail for one approval, oldest first. */
export function approvalAudit(
  context: CollabContext,
  pendingId: string,
): AuditRow[] {
  const rows = context.database
    .prepare(
      "SELECT approval_id, decision, answered_by, expected_revision, applied_revision, " +
        "accepted, route, refusal, created_at FROM agent_approval_audit " +
        "WHERE approval_id = ? ORDER BY id",
    )
    .all(pendingId) as {
    approval_id: string;
    decision: string;
    answered_by: string;
    expected_revision: number;
    applied_revision: number | null;
    accepted: number;
    route: string;
    refusal: string;
    created_at: string;
  }[];
  return rows.map((row) => ({
    approvalId: row.approval_id,
    decision: row.decision,
    answeredBy: row.answered_by,
    expectedRevision: Number(row.expected_revision),
    appliedRevision:
      row.applied_revision === null ? null : Number(row.applied_revision),
    accepted: row.accepted !== 0,
    route: row.route,
    refusal: row.refusal,
    createdAt: row.created_at,
  }));
}

/* --------------------------------- delivery -------------------------------- */

export function pendingDir(context: CollabContext): string {
  return join(context.dataDir, "pending");
}

/**
 * Writes `<pending>/<id>.answer` atomically, 0600. `false` means there was no
 * pending request file, so nobody is polling for the answer.
 */
export function writeAnswerFile(
  directory: string,
  pendingId: string,
  decision: string,
): boolean {
  if (!validPendingId(pendingId)) {
    throw badRequest("Approval id is invalid");
  }
  if (!existsSync(join(directory, `${pendingId}.json`))) return false;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${pendingId}.answer`);
  const temporary = join(directory, `.${pendingId}.answer.tmp`);
  writeFileSync(temporary, decision, { mode: 0o600 });
  renameSync(temporary, target);
  return true;
}

/**
 * The fallback: the keys a human would press.
 *
 * Every CLI in the registry is covered, not only the one with a numbered menu.
 * A provider this build has never heard of falls back to `y` / `n`, which is
 * what every prompt but Claude's asks for — answering nothing at all would
 * leave the CLI blocked on a question the user has already decided.
 */
async function typeIntoPty(
  context: CollabContext,
  approval: AgentApproval,
  decision: string,
): Promise<boolean> {
  const session = loadSession(context.database, approval.nodeId);
  if (session === undefined || context.terminals === undefined) return false;
  const node = loadNode(context.database, approval.nodeId);
  const agentId =
    node?.agentId ??
    getAgentStatus(context.database, approval.nodeId)?.agentId ??
    "claude";
  const generation = context.terminals.generation(session.sessionId);
  if (generation === undefined) return false;
  const keys = answerKeys(baseAgent(context.settings, agentId), decision);
  try {
    await context.terminals.write(session.sessionId, generation, keys);
    return true;
  } catch {
    return false;
  }
}

/**
 * The keystrokes each CLI reads as allow / deny.
 *
 * Claude's permission prompt is a numbered menu: `1` is yes and `3` is "no,
 * and tell it what to do instead". Codex, opencode, Pi, Oh My Pi and Copilot
 * all take a y/n answer, which is also the fallback for a `custom:` entry
 * whose base is unknown — a guess that does nothing is better than silence
 * only because the CLI is blocked either way, and `n` is the safe guess.
 */
export function answerKeys(agentId: string, decision: string): string {
  const allow = decision === "allow";
  switch (agentId) {
    case "claude":
      return allow ? "1\r" : "3\r";
    case "codex":
    case "opencode":
    case "pi":
    case "omp":
    case "copilot":
      return allow ? "y\r" : "n\r";
    default:
      return allow ? "y\r" : "n\r";
  }
}

/**
 * `<nodeId>-<epochMs>-<pid>`; anything that could escape the directory or name
 * a file we did not write is refused before it reaches the filesystem.
 */
export function validPendingId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9_.-]+$/.test(value) &&
    !value.includes("..")
  );
}

/* ---------------------------------- sweep --------------------------------- */

/**
 * Deletes pending request and answer files older than {@link ORPHAN_MINUTES}.
 *
 * A client that was killed mid-wait leaves both files behind, and they contain
 * the tool call the agent wanted to make. Returns how many files went away.
 */
export function sweepOrphans(directory: string, olderThanMs: number): number {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ours = [".json", ".answer", ".tmp"].some((extension) =>
      entry.name.endsWith(extension),
    );
    if (!ours) continue;
    const path = join(directory, entry.name);
    let stale = false;
    try {
      stale = now - statSync(path).mtimeMs > olderThanMs;
    } catch {
      stale = false;
    }
    if (!stale) continue;
    try {
      rmSync(path);
      removed += 1;
    } catch {
      // Something else removed it first; that is the outcome we wanted.
    }
  }
  return removed;
}

/**
 * Whether a node has a permission question open.
 *
 * The other half of the safety gate `agent/status.isAwaitingHuman` answers:
 * the status row says the CLI is blocked, this says *what on*. Exported for
 * the terminal domain, which refuses a write into a pane that is waiting on a
 * human — a write would answer the question with whatever it happened to be.
 */
export function hasOpenApproval(
  context: CollabContext,
  nodeId: string,
): boolean {
  const row = context.database
    .prepare(
      "SELECT 1 AS found FROM agent_approvals WHERE node_id = ? AND answer IS NULL LIMIT 1",
    )
    .get(nodeId);
  return row !== undefined;
}

export { agentIdOf };
