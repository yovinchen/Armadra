import type { DatabaseSync } from "node:sqlite";
import { getWorkspace } from "../workspaces/table";
import {
  badRequest,
  conflict,
  notFound,
  rfc3339,
  uuidV7,
} from "../workspaces/support";

/**
 * The `boards` table: listing, naming, creating, reordering and deleting the
 * boards of one workspace.
 *
 * A port of the pre-merge implementation. `whiteboard_json` is read and
 * written but never parsed — the core only ever knows its length (see
 * `validation.ts`), which is what lets a client change the snapshot format
 * without a core release.
 */

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

export interface Board {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly viewport: Viewport;
  /** Opaque; `""` means "no whiteboard yet". */
  readonly whiteboard: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface BoardRow {
  id: string;
  workspace_id: string;
  name: string;
  sort_order: number;
  viewport_json: string;
  whiteboard_json: string;
  created_at: string;
  updated_at: string;
}

const SELECT_BOARD =
  "SELECT id, workspace_id, name, sort_order, viewport_json, whiteboard_json, " +
  "created_at, updated_at FROM boards";

/**
 * A viewport that will not parse falls back to the default, for the same
 * reason the Rust reader does it: a camera position is not worth refusing to
 * open a board over.
 */
function fromRow(row: BoardRow): Board {
  let viewport = DEFAULT_VIEWPORT;
  try {
    const parsed = JSON.parse(row.viewport_json) as Partial<Viewport>;
    if (
      typeof parsed.x === "number" &&
      typeof parsed.y === "number" &&
      typeof parsed.zoom === "number"
    ) {
      viewport = { x: parsed.x, y: parsed.y, zoom: parsed.zoom };
    }
  } catch {
    viewport = DEFAULT_VIEWPORT;
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    sortOrder: Number(row.sort_order),
    viewport,
    whiteboard: row.whiteboard_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listBoards(
  database: DatabaseSync,
  workspaceId: string,
): readonly Board[] {
  // The workspace read is the 404: a board list for an id nobody registered is
  // "no such workspace", not an empty list.
  getWorkspace(database, workspaceId);
  const rows = database
    .prepare(
      `${SELECT_BOARD} WHERE workspace_id = ? ORDER BY sort_order, created_at`,
    )
    .all(workspaceId) as unknown as BoardRow[];
  return rows.map(fromRow);
}

export function getBoard(
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
): Board {
  const row = database
    .prepare(`${SELECT_BOARD} WHERE id = ? AND workspace_id = ?`)
    .get(boardId, workspaceId) as BoardRow | undefined;
  if (row === undefined) throw notFound("Board was not found");
  return fromRow(row);
}

export function validateBoardName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || [...trimmed].length > 80) {
    throw badRequest("Board name is invalid");
  }
  return trimmed;
}

export function createBoard(
  database: DatabaseSync,
  workspaceId: string,
  name: string,
): Board {
  getWorkspace(database, workspaceId);
  const validated = validateBoardName(name);
  const id = uuidV7();
  const now = rfc3339();
  const next = database
    .prepare(
      "SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM boards WHERE workspace_id = ?",
    )
    .get(workspaceId) as { next: number };
  database
    .prepare(
      "INSERT INTO boards (id, workspace_id, name, sort_order, viewport_json, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      workspaceId,
      validated,
      Number(next.next),
      JSON.stringify(DEFAULT_VIEWPORT),
      now,
      now,
    );
  return getBoard(database, workspaceId, id);
}

export function updateBoard(
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
  patch: {
    readonly name?: string | undefined;
    readonly sortOrder?: number | undefined;
  },
): Board {
  const current = getBoard(database, workspaceId, boardId);
  const name =
    patch.name === undefined ? current.name : validateBoardName(patch.name);
  let sortOrder = current.sortOrder;
  if (patch.sortOrder !== undefined) {
    if (
      !Number.isInteger(patch.sortOrder) ||
      patch.sortOrder < 0 ||
      patch.sortOrder > 10_000
    ) {
      throw badRequest("Board order is out of range");
    }
    sortOrder = patch.sortOrder;
  }
  database
    .prepare(
      "UPDATE boards SET name = ?, sort_order = ? WHERE id = ? AND workspace_id = ?",
    )
    .run(name, sortOrder, boardId, workspaceId);
  return getBoard(database, workspaceId, boardId);
}

/**
 * A workspace always keeps at least one board: the canvas has no empty state,
 * and deleting the last one would leave a workspace that cannot be opened.
 */
export function deleteBoard(
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
): void {
  getBoard(database, workspaceId, boardId);
  const total = database
    .prepare("SELECT COUNT(*) AS total FROM boards WHERE workspace_id = ?")
    .get(workspaceId) as { total: number };
  if (Number(total.total) <= 1) {
    throw conflict("A workspace must keep at least one board");
  }
  database
    .prepare("DELETE FROM boards WHERE id = ? AND workspace_id = ?")
    .run(boardId, workspaceId);
}
