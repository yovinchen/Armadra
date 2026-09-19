import type { DatabaseSync } from "node:sqlite";
import {
  type BackendKind,
  type SessionKey,
  type TerminalBackend,
  sessionKey as asSessionKey,
} from "./backend";

/**
 * Reconciliation and reclamation — contract §15.2 and §15.6.
 *
 * A tmux session (and a Windows session-host session) outlives the core, which
 * means the database and the backend can disagree: rows for sessions that died
 * while the app was closed, and `armadra-*` sessions whose row was deleted.
 * {@link reconcile} settles that once at start-up; {@link gcCandidates} is the
 * policy the ten-minute sweep runs.
 *
 * Everything here that can be a pure function is one. `gcCandidates` in
 * particular takes rows and a clock rather than a database, because the whole
 * value of the reclaim policy is in the four conditions it applies, and those
 * are worth asserting without a tmux server and without waiting a day.
 */

/** Contract §15.6: "every 10 minutes". */
export const SWEEP_INTERVAL_MS = 600_000;
/** Contract §15.6: "at most 8 per round" — a sweep must never look like a purge. */
export const MAX_DESTROYS_PER_SWEEP = 8;
/** How often the persistent backend is polled for sessions that ended quietly. */
export const LIVENESS_INTERVAL_MS = 3_000;
/** How often unattached sessions are checked against the dormancy setting. */
export const DORMANCY_INTERVAL_MS = 5_000;

/**
 * The backends whose sessions outlive the core, as `backend_kind` spells them.
 *
 * A row of any other kind describes a process that died with whoever wrote it
 * and is settled by {@link failNonPersistentRows} at start-up rather than
 * reconciled here. Written out as a literal because it goes into SQL; keep it
 * in step with `persistent()` in `backend.ts`.
 */
export const PERSISTENT_KINDS = "('tmux', 'sessionHost')";

/** One detached session as the reclaim policy sees it. */
export interface GcRow {
  readonly sessionId: string;
  readonly sessionKey: string;
  readonly backendRef: string | null;
  readonly attachState: string;
  /** `last_output_at`, or the creation time when nothing was ever written. */
  readonly lastActivity: number;
  /** The owning node is still on a board. */
  readonly nodePresent: boolean;
  /** The workspace still exists. */
  readonly workspaceOpen: boolean;
}

/**
 * Pure policy: which detached sessions may be destroyed right now.
 *
 * A session is reclaimable when it is detached, has been quiet for longer than
 * the grace period, and nothing can reach it any more (its node is gone or its
 * workspace is gone). `live` sessions are never candidates however old they
 * are — somebody is looking at them.
 */
export function gcCandidates(
  rows: readonly GcRow[],
  now: number,
  graceMinutes: number,
): string[] {
  const grace = graceMinutes * 60_000;
  return (
    rows
      .filter((row) => row.attachState === "detached")
      .filter((row) => now - row.lastActivity > grace)
      .filter((row) => !row.nodePresent || !row.workspaceOpen)
      // Oldest first, so a backlog drains deterministically over several rounds.
      .sort((left, right) => left.lastActivity - right.lastActivity)
      .slice(0, MAX_DESTROYS_PER_SWEEP)
      .map((row) => row.sessionId)
  );
}

/**
 * Every session row of a persistent backend that is still supposed to be
 * attachable.
 *
 * **Direct rows are not selected, and that is the `live-work` gate.** A direct
 * session is a process this core owns and a person may be working in; it has
 * no handle anything could reclaim, and the only lever that ever touches it is
 * an explicit terminate. Widening this query to all kinds would let a sweep
 * kill somebody's running build because their node happened to be removed from
 * a board — so the filter is the gate, and it is asserted by a test rather
 * than left to this comment.
 */
export function attachableRows(database: DatabaseSync): GcRow[] {
  const rows = database
    .prepare(
      `SELECT s.id AS id, s.session_key AS session_key, s.backend_ref AS backend_ref,
              s.attach_state AS attach_state, s.last_output_at AS last_output_at,
              s.created_at AS created_at,
              EXISTS(SELECT 1 FROM nodes n WHERE n.id = s.owner_node_id) AS node_present,
              EXISTS(SELECT 1 FROM workspaces w WHERE w.id = s.workspace_id) AS workspace_open
         FROM terminal_sessions s
        WHERE s.backend_kind IN ${PERSISTENT_KINDS} AND s.attach_state <> 'exited'`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    sessionId: String(row.id),
    sessionKey: String(row.session_key),
    backendRef: (row.backend_ref as string | null) ?? null,
    attachState: String(row.attach_state),
    lastActivity: parseTime(
      (row.last_output_at as string | null) ?? String(row.created_at),
    ),
    nodePresent: Number(row.node_present) !== 0,
    workspaceOpen: Number(row.workspace_open) !== 0,
  }));
}

/**
 * An unparseable timestamp becomes the beginning of time rather than "now".
 *
 * The direction matters: a row whose `created_at` this build cannot read would
 * otherwise look brand new for ever and never be reclaimed at all. Old is the
 * recoverable mistake — the other three conditions still have to hold before
 * anything is destroyed.
 */
function parseTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/* ------------------------------ reconciliation ----------------------------- */

export interface ReconcileReport {
  /** Rows whose backend session is still there: re-attachable. */
  readonly detached: number;
  /** Rows whose backend session is gone: the process died while we were away. */
  readonly exited: number;
  /** `armadra-*` sessions with no row at all. */
  readonly orphansDestroyed: number;
}

export const EMPTY_REPORT: ReconcileReport = {
  detached: 0,
  exited: 0,
  orphansDestroyed: 0,
};

export function mergeReports(
  left: ReconcileReport,
  right: ReconcileReport,
): ReconcileReport {
  return {
    detached: left.detached + right.detached,
    exited: left.exited + right.exited,
    orphansDestroyed: left.orphansDestroyed + right.orphansDestroyed,
  };
}

export interface Adopted {
  readonly key: SessionKey;
  readonly reference: string;
  readonly generation: number;
}

/**
 * Start-up recovery for the backends whose sessions do **not** survive the
 * core.
 *
 * A direct PTY died with the process that wrote the row, and no amount of
 * looking will bring it back, so the row stops claiming to be running before
 * anything else reads it. `failed` rather than `exited` on purpose: nobody
 * observed an exit code, and saying `exited` would invent one.
 *
 * The Rust Runtime does this inside the migration transaction
 * (`apps/runtime/src/db/mod.rs`); here it belongs to the terminal domain,
 * which is the note R0 left in `db/open.ts`.
 */
export function failNonPersistentRows(
  database: DatabaseSync,
  now: string = new Date().toISOString(),
): number {
  const result = database
    .prepare(
      `UPDATE terminal_sessions
          SET status = 'failed', attach_state = 'exited', ended_at = ?
        WHERE status = 'running' AND backend_kind NOT IN ${PERSISTENT_KINDS}`,
    )
    .run(now);
  return Number(result.changes ?? 0);
}

/**
 * Start-up reconciliation of contract §15.2, for one persistent backend.
 *
 * Returns the keys that are still alive so the manager can re-adopt them into
 * its in-memory map, and the counts for the log line.
 */
export async function reconcile(
  database: DatabaseSync,
  backend: TerminalBackend,
  kind: BackendKind,
  now: string = new Date().toISOString(),
): Promise<{ report: ReconcileReport; adopted: Adopted[] }> {
  const alive = new Set(
    (await backend.list()).map((reference) => reference.name),
  );

  const rows = database
    .prepare(
      `SELECT id, session_key, backend_ref, generation FROM terminal_sessions
        WHERE backend_kind = ? AND (status = 'running' OR attach_state <> 'exited')`,
    )
    .all(kind) as Record<string, unknown>[];

  const revive = database.prepare(
    "UPDATE terminal_sessions SET attach_state = 'detached', status = 'running' WHERE id = ?",
  );
  const bury = database.prepare(
    `UPDATE terminal_sessions
        SET attach_state = 'exited',
            status = CASE WHEN status = 'running' THEN 'exited' ELSE status END,
            ended_at = COALESCE(ended_at, ?)
      WHERE id = ?`,
  );

  const adopted: Adopted[] = [];
  const known = new Set<string>();
  let detached = 0;
  let exited = 0;
  for (const row of rows) {
    const id = String(row.id);
    const reference = (row.backend_ref as string | null) ?? "";
    known.add(reference);
    if (alive.has(reference)) {
      revive.run(id);
      adopted.push({
        key: asSessionKey(String(row.session_key)),
        reference,
        generation: Math.max(0, Number(row.generation ?? 0)),
      });
      detached += 1;
      continue;
    }
    bury.run(now, id);
    exited += 1;
  }

  // Whatever the backend still holds that no row points at. Destroying it is
  // the only way it will ever go: nothing else knows its name.
  let orphansDestroyed = 0;
  for (const name of alive) {
    if (known.has(name)) continue;
    try {
      await backend.destroyByReference(name);
      orphansDestroyed += 1;
    } catch {
      // A session that refuses to die is reported by the next round rather
      // than stopping this one; the other rows still have to be settled.
    }
  }

  return { report: { detached, exited, orphansDestroyed }, adopted };
}
