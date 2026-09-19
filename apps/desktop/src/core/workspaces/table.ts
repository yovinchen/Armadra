import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { canonicalDirectory } from "./roots";
import {
  badRequest,
  conflict,
  internalError,
  isHexColor,
  notFound,
  rfc3339,
  uuidV7,
} from "./support";

/**
 * The `workspaces` table, and the default board every workspace is created
 * with.
 *
 * A port of `apps/runtime/src/db/workspaces.rs`, query for query. What is
 * **not** ported is the write-ownership gate around each of them: it asked
 * whether this process or the Go Host owned the canvas domain, and with one
 * process there is no second answer. The `write_ownership` table goes with it
 * (TypeScript core design §6).
 */

export const DEFAULT_WORKSPACE_COLOR = "#5B5BD6";
export const DEFAULT_BOARD_NAME = "Default";
export const DEFAULT_WORKSPACE_NAME = "Default";

export interface WorkspacePermissions {
  readonly read: boolean;
  readonly write: boolean;
  readonly execute: boolean;
}

/** `WorkspacePermissions::default()` — readable and writable, not executable. */
export const DEFAULT_PERMISSIONS: WorkspacePermissions = {
  read: true,
  write: true,
  execute: false,
};

export interface Workspace {
  readonly id: string;
  readonly name: string;
  /** A path on `executionHostId`, not necessarily on this machine. */
  readonly rootPath: string;
  readonly color: string;
  readonly permissions: WorkspacePermissions;
  /** Omitted entirely for a local workspace, exactly as serde does. */
  readonly executionHostId?: string;
  readonly lastOpenedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BoardBrief {
  readonly id: string;
  readonly name: string;
  readonly nodeCount: number;
}

export type WorkspaceSummary = Workspace & {
  readonly boards: readonly BoardBrief[];
};

interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string;
  color: string;
  permissions_json: string;
  execution_host_id: string;
  last_opened_at: string;
  created_at: string;
  updated_at: string;
}

const SELECT_WORKSPACE =
  "SELECT id, name, root_path, color, permissions_json, execution_host_id, " +
  "COALESCE(last_opened_at, updated_at) AS last_opened_at, created_at, updated_at " +
  "FROM workspaces";

/**
 * A stored row as the wire sees it.
 *
 * `permissions_json` that will not parse falls back to the default rather than
 * failing the read: a workspace whose permission blob was corrupted is still a
 * workspace, and refusing to list it would hide the one row a person needs to
 * fix or remove.
 */
function fromRow(row: WorkspaceRow): Workspace {
  let permissions = DEFAULT_PERMISSIONS;
  try {
    const parsed = JSON.parse(
      row.permissions_json,
    ) as Partial<WorkspacePermissions>;
    permissions = {
      read: parsed.read ?? DEFAULT_PERMISSIONS.read,
      write: parsed.write ?? DEFAULT_PERMISSIONS.write,
      execute: parsed.execute ?? DEFAULT_PERMISSIONS.execute,
    };
    if (
      typeof parsed.read !== "boolean" ||
      typeof parsed.write !== "boolean" ||
      typeof parsed.execute !== "boolean"
    ) {
      permissions = DEFAULT_PERMISSIONS;
    }
  } catch {
    permissions = DEFAULT_PERMISSIONS;
  }
  const workspace: Workspace = {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    color: row.color,
    permissions,
    lastOpenedAt: row.last_opened_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  // `skip_serializing_if = "String::is_empty"`: a local workspace has no key
  // at all, and the shared schema defaults it back to `""`.
  return row.execution_host_id === ""
    ? workspace
    : { ...workspace, executionHostId: row.execution_host_id };
}

/** `#RRGGBB`, upper-cased, or the palette default when nothing was asked for. */
export function normalizeColor(color: string | undefined): string {
  if (color === undefined) return DEFAULT_WORKSPACE_COLOR;
  const trimmed = color.trim();
  if (!isHexColor(trimmed)) {
    throw badRequest("Workspace color must be a #RRGGBB value");
  }
  return trimmed.toUpperCase();
}

export function validWorkspaceName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || [...trimmed].length > 120) {
    throw badRequest("Workspace name is invalid");
  }
  return trimmed;
}

function permissionsJson(permissions: WorkspacePermissions): string {
  // Key order matters for nothing but a byte-for-byte diff against the Rust
  // rows, and costs nothing to keep.
  return JSON.stringify({
    read: permissions.read,
    write: permissions.write,
    execute: permissions.execute,
  });
}

/**
 * Insert a workspace and its default board in one transaction.
 *
 * `ON CONFLICT(root_path) DO NOTHING` plus a re-read is how authorising the
 * same directory twice hands back the workspace that is already there instead
 * of failing: the root is the identity.
 */
export function createWorkspace(
  database: DatabaseSync,
  input: {
    readonly name: string;
    readonly rootPath: string;
    readonly color?: string | undefined;
    readonly permissions?: WorkspacePermissions | undefined;
  },
): Workspace {
  const id = uuidV7();
  const boardId = uuidV7();
  const now = rfc3339();
  const color = normalizeColor(input.color);
  const permissions = input.permissions ?? DEFAULT_PERMISSIONS;

  database.exec("BEGIN IMMEDIATE");
  try {
    const inserted = database
      .prepare(
        "INSERT INTO workspaces (id, name, root_path, color, permissions_json, last_opened_at, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(root_path) DO NOTHING",
      )
      .run(
        id,
        input.name,
        input.rootPath,
        color,
        permissionsJson(permissions),
        now,
        now,
        now,
      );
    if (inserted.changes === 0) {
      database.exec("ROLLBACK");
      return getWorkspaceByRoot(database, input.rootPath);
    }
    insertDefaultBoard(database, boardId, id, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return {
    id,
    name: input.name,
    rootPath: input.rootPath,
    color,
    permissions,
    lastOpenedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A workspace whose files live on an SSH execution host (H02). The root is a
 * path on *that* host; nothing here touches the local filesystem.
 *
 * `root_path` is globally unique, so a remote root spelling the same path as a
 * row on another host is a conflict rather than a silent hand-back: they are
 * different places.
 */
export function createRemoteWorkspace(
  database: DatabaseSync,
  input: {
    readonly name: string;
    readonly executionHostId: string;
    readonly rootPath: string;
    readonly permissions?: WorkspacePermissions | undefined;
  },
): Workspace {
  if (input.executionHostId === "") {
    throw badRequest("A remote workspace requires an execution host");
  }
  const id = uuidV7();
  const boardId = uuidV7();
  const now = rfc3339();
  const color = normalizeColor(undefined);
  const permissions = input.permissions ?? DEFAULT_PERMISSIONS;

  database.exec("BEGIN IMMEDIATE");
  try {
    const inserted = database
      .prepare(
        "INSERT INTO workspaces (id, name, root_path, color, permissions_json, execution_host_id, last_opened_at, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(root_path) DO NOTHING",
      )
      .run(
        id,
        input.name,
        input.rootPath,
        color,
        permissionsJson(permissions),
        input.executionHostId,
        now,
        now,
        now,
      );
    if (inserted.changes === 0) {
      database.exec("ROLLBACK");
      const existing = getWorkspaceByRoot(database, input.rootPath);
      if ((existing.executionHostId ?? "") === input.executionHostId) {
        return existing;
      }
      throw conflict(
        "Another workspace already uses this path on a different execution host",
      );
    }
    insertDefaultBoard(database, boardId, id, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return {
    id,
    name: input.name,
    rootPath: input.rootPath,
    color,
    permissions,
    executionHostId: input.executionHostId,
    lastOpenedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function insertDefaultBoard(
  database: DatabaseSync,
  boardId: string,
  workspaceId: string,
  now: string,
): void {
  database
    .prepare(
      "INSERT INTO boards (id, workspace_id, name, sort_order, viewport_json, created_at, updated_at) " +
        "VALUES (?, ?, ?, 0, ?, ?, ?)",
    )
    .run(
      boardId,
      workspaceId,
      DEFAULT_BOARD_NAME,
      JSON.stringify({ x: 0, y: 0, zoom: 1 }),
      now,
      now,
    );
}

/**
 * The project a fresh installation opens into.
 *
 * Created once, when the table is empty: a first launch must not land on an
 * empty shell that asks for a folder before anything can be tried. Rows that
 * exist, whatever they are, mean the user has already chosen — and nothing is
 * added behind their back.
 */
export function ensureDefaultWorkspace(
  database: DatabaseSync,
  dataDir: string,
): Workspace | undefined {
  const existing = database
    .prepare("SELECT COUNT(*) AS total FROM workspaces")
    .get() as { total: number };
  if (Number(existing.total) > 0) return undefined;
  const root = join(dataDir, "workspaces", "default");
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    throw internalError(
      `could not create the default workspace at ${root}: ${String(error)}`,
    );
  }
  return createWorkspace(database, {
    name: DEFAULT_WORKSPACE_NAME,
    rootPath: canonicalDirectory(root),
    permissions: { read: true, write: true, execute: true },
  });
}

/** Every workspace, most recently opened first, each with its board briefs. */
export function listWorkspaces(
  database: DatabaseSync,
): readonly WorkspaceSummary[] {
  const rows = database
    .prepare(
      `${SELECT_WORKSPACE} ORDER BY COALESCE(last_opened_at, updated_at) DESC, created_at DESC`,
    )
    .all() as unknown as WorkspaceRow[];
  const briefs = database
    .prepare(
      "SELECT b.workspace_id AS workspace_id, b.id AS id, b.name AS name, " +
        "(SELECT COUNT(*) FROM nodes n WHERE n.board_id = b.id) AS node_count " +
        "FROM boards b ORDER BY b.sort_order, b.created_at",
    )
    .all() as unknown as {
    workspace_id: string;
    id: string;
    name: string;
    node_count: number;
  }[];
  const byWorkspace = new Map<string, BoardBrief[]>();
  for (const brief of briefs) {
    const list = byWorkspace.get(brief.workspace_id) ?? [];
    list.push({
      id: brief.id,
      name: brief.name,
      nodeCount: Number(brief.node_count),
    });
    byWorkspace.set(brief.workspace_id, list);
  }
  return rows.map((row) => ({
    ...fromRow(row),
    boards: byWorkspace.get(row.id) ?? [],
  }));
}

export function getWorkspace(database: DatabaseSync, id: string): Workspace {
  const row = database.prepare(`${SELECT_WORKSPACE} WHERE id = ?`).get(id) as
    | WorkspaceRow
    | undefined;
  if (row === undefined) throw notFound("Workspace was not found");
  return fromRow(row);
}

export function getWorkspaceByRoot(
  database: DatabaseSync,
  rootPath: string,
): Workspace {
  const row = database
    .prepare(`${SELECT_WORKSPACE} WHERE root_path = ?`)
    .get(rootPath) as WorkspaceRow | undefined;
  if (row === undefined) throw notFound("Workspace was not found");
  return fromRow(row);
}

export interface WorkspacePatch {
  readonly name?: string | undefined;
  readonly color?: string | undefined;
  readonly permissions?: WorkspacePermissions | undefined;
}

/** Patch the fields the request supplied and leave the rest alone. */
export function updateWorkspace(
  database: DatabaseSync,
  id: string,
  patch: WorkspacePatch,
): Workspace {
  const current = getWorkspace(database, id);
  const name =
    patch.name === undefined ? current.name : validWorkspaceName(patch.name);
  const color =
    patch.color === undefined ? current.color : normalizeColor(patch.color);
  const permissions = patch.permissions ?? current.permissions;
  const now = rfc3339();
  database
    .prepare(
      "UPDATE workspaces SET name = ?, color = ?, permissions_json = ?, updated_at = ? WHERE id = ?",
    )
    .run(name, color, permissionsJson(permissions), now, id);
  return getWorkspace(database, id);
}

/**
 * Point a workspace at a different execution host and root.
 *
 * Deliberately separate from [`updateWorkspace`]: name, colour and permissions
 * are preferences, while this changes *which machine the project is on*.
 */
export function rebindWorkspaceExecution(
  database: DatabaseSync,
  id: string,
  executionHostId: string,
  rootPath: string,
): Workspace {
  if (rootPath.trim() === "") throw badRequest("Workspace root is required");
  const now = rfc3339();
  const result = database
    .prepare(
      "UPDATE workspaces SET execution_host_id = ?, root_path = ?, updated_at = ? WHERE id = ?",
    )
    .run(executionHostId, rootPath, now, id);
  if (result.changes === 0) throw notFound("Workspace was not found");
  return getWorkspace(database, id);
}

/**
 * 从列表移除: the row and everything the schema hangs off it — boards → nodes
 * and edges, terminal sessions → logs, agent status, approvals, context links,
 * deliveries — go through `ON DELETE CASCADE`.
 *
 * Nothing under `root_path` is read, moved or deleted: this removes the entry,
 * not the project.
 */
export function deleteWorkspace(database: DatabaseSync, id: string): void {
  const result = database
    .prepare("DELETE FROM workspaces WHERE id = ?")
    .run(id);
  if (result.changes === 0) throw notFound("Workspace was not found");
}

/** `POST …/open` — stamp `last_opened_at` and hand the row back. */
export function touchWorkspaceOpened(
  database: DatabaseSync,
  id: string,
): Workspace {
  const now = rfc3339();
  const result = database
    .prepare("UPDATE workspaces SET last_opened_at = ? WHERE id = ?")
    .run(now, id);
  if (result.changes === 0) throw notFound("Workspace was not found");
  return getWorkspace(database, id);
}
