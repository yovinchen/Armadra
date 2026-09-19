import type { DatabaseSync } from "node:sqlite";
import { rfc3339 } from "../workspaces/support";
import { type SessionState, type Viewport, parseSessionState } from "./model";

/**
 * `browser_sessions` rows: what the core still stores about a browser node,
 * and nothing about what the page contains.
 *
 * Ported from `apps/runtime/src/browser/store.rs`. Under the Electron shell
 * that is two columns — `lease_generation` and `active_tab_url`. The process
 * identity migration 0012 added (`pid`, `pid_started_at`, `cdp_port`) is dead:
 * there is no browser of ours to identify, so nothing here writes those
 * columns and nothing reads them. The table itself is unchanged, because a
 * published migration is not edited.
 */

export interface StoredSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly url: string;
  readonly title: string;
  readonly viewport: Viewport;
  readonly profileDir: string;
  readonly headful: boolean;
  readonly keepAlive: boolean;
  readonly generation: number;
  readonly state: SessionState;
  readonly reasonCode: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * The lease's generation counter, kept across restarts so a pre-restart
   * generation cannot be mistaken for a current one.
   */
  readonly leaseGeneration: number;
  /**
   * Only the active tab's URL survives a restart. The other tabs are not
   * stored, and the node says so rather than pretending they came back.
   */
  readonly activeTabUrl: string;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  node_id: string;
  url: string;
  title: string;
  viewport_width: number;
  viewport_height: number;
  device_scale_factor: number;
  profile_dir: string;
  headful: number;
  keep_alive: number;
  generation: number;
  state: string;
  reason_code: string;
  created_at: string;
  updated_at: string;
  lease_generation: number;
  active_tab_url: string;
}

/** Every column of a stored session, written out once rather than `*`. */
const SELECT =
  "SELECT id, workspace_id, node_id, url, title, viewport_width, " +
  "viewport_height, device_scale_factor, profile_dir, headful, keep_alive, generation, " +
  "state, reason_code, created_at, updated_at, lease_generation, active_tab_url " +
  "FROM browser_sessions";

function fromRow(row: SessionRow): StoredSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    nodeId: row.node_id,
    url: row.url,
    title: row.title,
    viewport: {
      width: Math.max(0, Number(row.viewport_width)),
      height: Math.max(0, Number(row.viewport_height)),
      deviceScaleFactor: Number(row.device_scale_factor),
    },
    profileDir: row.profile_dir,
    headful: Number(row.headful) !== 0,
    keepAlive: Number(row.keep_alive) !== 0,
    generation: Math.max(0, Number(row.generation)),
    state: parseSessionState(row.state),
    reasonCode: row.reason_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    leaseGeneration: Math.max(0, Number(row.lease_generation)),
    activeTabUrl: row.active_tab_url,
  };
}

export function storedSession(
  database: DatabaseSync,
  sessionId: string,
): StoredSession | undefined {
  const row = database.prepare(`${SELECT} WHERE id = ?`).get(sessionId) as
    | SessionRow
    | undefined;
  return row === undefined ? undefined : fromRow(row);
}

export function storedForNode(
  database: DatabaseSync,
  nodeId: string,
): StoredSession | undefined {
  const row = database.prepare(`${SELECT} WHERE node_id = ?`).get(nodeId) as
    | SessionRow
    | undefined;
  return row === undefined ? undefined : fromRow(row);
}

export function storedForWorkspace(
  database: DatabaseSync,
  workspaceId: string,
): StoredSession[] {
  const rows = database
    .prepare(`${SELECT} WHERE workspace_id = ? ORDER BY created_at`)
    .all(workspaceId) as unknown as SessionRow[];
  return rows.map(fromRow);
}

export function storedAll(database: DatabaseSync): StoredSession[] {
  const rows = database
    .prepare(`${SELECT} ORDER BY created_at`)
    .all() as unknown as SessionRow[];
  return rows.map(fromRow);
}

export function insertStored(
  database: DatabaseSync,
  session: StoredSession,
): void {
  database
    .prepare(
      "INSERT INTO browser_sessions (id, workspace_id, node_id, url, title, viewport_width, " +
        "viewport_height, device_scale_factor, profile_dir, headful, keep_alive, generation, " +
        "state, reason_code, created_at, updated_at, lease_generation, active_tab_url) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      session.id,
      session.workspaceId,
      session.nodeId,
      session.url,
      session.title,
      session.viewport.width,
      session.viewport.height,
      session.viewport.deviceScaleFactor,
      session.profileDir,
      session.headful ? 1 : 0,
      session.keepAlive ? 1 : 0,
      session.generation,
      session.state,
      session.reasonCode,
      session.createdAt,
      session.updatedAt,
      session.leaseGeneration,
      session.activeTabUrl,
    );
}

/**
 * Records where the active tab is now.
 *
 * Under the Electron shell the page is a guest in the window, so this column
 * is the only thing about it this side stores. It is also why the column has
 * exactly ONE writer — the node's own `data.url` is what the page draws, and a
 * second writer would be a second truth.
 */
export function persistActiveTabUrl(
  database: DatabaseSync,
  sessionId: string,
  url: string,
): void {
  database
    .prepare(
      "UPDATE browser_sessions SET active_tab_url = ?, updated_at = ? WHERE id = ?",
    )
    .run(url, rfc3339(), sessionId);
}

/**
 * Moves the lease generation forward. It is stored rather than derived so a
 * client that slept through a restart cannot present a generation that has
 * come back around to being current.
 */
export function persistLeaseGeneration(
  database: DatabaseSync,
  sessionId: string,
  generation: number,
): void {
  database
    .prepare("UPDATE browser_sessions SET lease_generation = ? WHERE id = ?")
    .run(generation, sessionId);
}

export function deleteStored(database: DatabaseSync, sessionId: string): void {
  database.prepare("DELETE FROM browser_sessions WHERE id = ?").run(sessionId);
}
