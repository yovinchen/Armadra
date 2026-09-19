import type { DatabaseSync } from "node:sqlite";
import { badRequest, conflict, rfc3339 } from "../workspaces/support";
import { getBoard } from "./boards";
import type {
  BoardDocument,
  CanvasEdge,
  CanvasNode,
  SaveBoardRequest,
} from "./document-types";
import { forgetNodes } from "./orphans";
import {
  validateDocument,
  validateViewport,
  validateWhiteboard,
} from "./validation";

/**
 * Loading a board's nodes, edges and whiteboard snapshot, and saving them
 * under an optimistic revision check.
 *
 * A port of `apps/runtime/src/db/documents.rs`. Two things in it are contract
 * rather than implementation, and neither may drift:
 *
 *   * **The CAS.** `UPDATE … WHERE id = ? AND updated_at = ?` is the whole of
 *     it. A row count other than 1 is a 409, and the front end answers a 409
 *     by rebasing its unsaved edits onto a fresh load and trying again. The
 *     board's `updated_at` *is* its revision number.
 *   * **A save is a diff, never a rewrite.** `agent_mailbox` is
 *     `ON DELETE CASCADE` on `nodes`, so deleting and re-inserting every row
 *     would drop every message on the board on every autosave — a drag, a
 *     rename or a colour change included.
 */

interface NodeRow {
  id: string;
  board_id: string;
  type: string;
  title: string;
  color: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  collapsed: number;
  expanded_height: number | null;
  parent_id: string | null;
  labels_json: string;
  note: string;
  data_json: string;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  board_id: string;
  source_node_id: string;
  target_node_id: string;
  kind: string;
  created_at: string;
  updated_at: string;
}

export function loadBoard(
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
): BoardDocument {
  const board = getBoard(database, workspaceId, boardId);
  const nodeRows = database
    .prepare(
      "SELECT id, board_id, type, title, color, x, y, width, height, collapsed, expanded_height, " +
        "parent_id, labels_json, note, data_json, created_at, updated_at " +
        "FROM nodes WHERE board_id = ? ORDER BY created_at",
    )
    .all(board.id) as unknown as NodeRow[];
  const edgeRows = database
    .prepare(
      "SELECT id, board_id, source_node_id, target_node_id, kind, created_at, updated_at " +
        "FROM edges WHERE board_id = ? ORDER BY created_at",
    )
    .all(board.id) as unknown as EdgeRow[];
  return {
    board,
    nodes: nodeRows.map(nodeFromRow),
    edges: edgeRows.map((row) => ({
      id: row.id,
      boardId: row.board_id,
      source: row.source_node_id,
      target: row.target_node_id,
      kind: row.kind,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

function nodeFromRow(row: NodeRow): CanvasNode {
  // A label list we cannot decode is a missing chip, not a board that refuses
  // to open — the same reasoning the Rust reader applies.
  let labels: string[] = [];
  try {
    const parsed = JSON.parse(row.labels_json) as unknown;
    if (Array.isArray(parsed)) {
      labels = parsed.filter(
        (entry): entry is string => typeof entry === "string",
      );
    }
  } catch {
    labels = [];
  }
  const node: Record<string, unknown> = {
    id: row.id,
    boardId: row.board_id,
    type: row.type,
    title: row.title,
    color: row.color,
    position: { x: row.x, y: row.y },
    labels,
    note: row.note,
    data: JSON.parse(row.data_json) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.width !== null && row.height !== null) {
    node.size = { width: row.width, height: row.height };
  }
  // `skip_serializing_if = "Option::is_none"` plus `(collapsed != 0).then_some(true)`:
  // a collapsed node carries `true`, an expanded one carries no key at all.
  if (Number(row.collapsed) !== 0) node.collapsed = true;
  if (row.expanded_height !== null) node.expandedHeight = row.expanded_height;
  if (row.parent_id !== null) node.parentId = row.parent_id;
  return orderNode(node);
}

/** Serde emits the struct's field order; a byte diff against Rust wants it. */
function orderNode(node: Record<string, unknown>): CanvasNode {
  const ordered: Record<string, unknown> = {};
  for (const key of [
    "id",
    "boardId",
    "type",
    "title",
    "color",
    "position",
    "size",
    "collapsed",
    "expandedHeight",
    "parentId",
    "labels",
    "note",
    "data",
    "createdAt",
    "updatedAt",
  ]) {
    if (key in node) ordered[key] = node[key];
  }
  return ordered as unknown as CanvasNode;
}

/**
 * The whole document, written under the caller's revision.
 *
 * Everything happens in one `BEGIN IMMEDIATE`: the CAS, the deletes, the
 * orphan cleanup and the upserts. A save that fails part way takes the
 * cleanup back with it — a node that still exists must never be missing its
 * status.
 */
export function saveBoard(
  database: DatabaseSync,
  workspaceId: string,
  boardId: string,
  request: SaveBoardRequest,
): BoardDocument {
  const board = getBoard(database, workspaceId, boardId);
  validateDocument(board.id, request.nodes, request.edges);
  validateViewport(request.viewport);

  const viewportJson = JSON.stringify({
    x: request.viewport.x,
    y: request.viewport.y,
    zoom: request.viewport.zoom,
  });
  let whiteboard = board.whiteboard;
  if (request.whiteboard !== undefined) {
    validateWhiteboard(request.whiteboard);
    whiteboard = request.whiteboard;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const nextUpdatedAt = rfc3339();
    const updated = database
      .prepare(
        "UPDATE boards SET updated_at = ?, viewport_json = ?, whiteboard_json = ? " +
          "WHERE id = ? AND updated_at = ?",
      )
      .run(
        nextUpdatedAt,
        viewportJson,
        whiteboard,
        board.id,
        request.expectedUpdatedAt,
      );
    if (updated.changes !== 1) {
      throw conflict("Board changed since it was loaded; reload before saving");
    }

    const storedEdgeIds = (
      database
        .prepare("SELECT id FROM edges WHERE board_id = ?")
        .all(board.id) as unknown as { id: string }[]
    ).map((row) => row.id);
    const storedNodeIds = (
      database
        .prepare("SELECT id FROM nodes WHERE board_id = ?")
        .all(board.id) as unknown as { id: string }[]
    ).map((row) => row.id);
    const keptEdgeIds = new Set(request.edges.map((edge) => edge.id));
    const keptNodeIds = new Set(request.nodes.map((node) => node.id));

    // Edges first: an edge the document dropped may point at a node it also
    // dropped, and `edges` is `ON DELETE CASCADE` on `nodes` too. Every edge
    // that stays has both endpoints in `request.nodes` (`validateDocument`),
    // so nothing surviving the node deletes is left dangling.
    const deleteEdge = database.prepare("DELETE FROM edges WHERE id = ?");
    for (const id of storedEdgeIds) {
      if (!keptEdgeIds.has(id)) deleteEdge.run(id);
    }
    const droppedNodeIds = storedNodeIds.filter((id) => !keptNodeIds.has(id));
    const deleteNode = database.prepare("DELETE FROM nodes WHERE id = ?");
    for (const id of droppedNodeIds) deleteNode.run(id);
    forgetNodes(database, droppedNodeIds);

    // The `WHERE` guard keeps an id owned by another board from being moved
    // onto this one: a plain INSERT would fail on the primary key, and
    // silently stealing the row would be worse than either.
    const upsertNode = database.prepare(
      "INSERT INTO nodes (id, board_id, type, title, color, x, y, width, height, collapsed, " +
        "expanded_height, parent_id, labels_json, note, data_json, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET " +
        "type = excluded.type, title = excluded.title, color = excluded.color, " +
        "x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height, " +
        "collapsed = excluded.collapsed, expanded_height = excluded.expanded_height, " +
        "parent_id = excluded.parent_id, labels_json = excluded.labels_json, " +
        "note = excluded.note, data_json = excluded.data_json, " +
        "created_at = excluded.created_at, updated_at = excluded.updated_at " +
        "WHERE nodes.board_id = excluded.board_id",
    );
    for (const node of request.nodes) {
      const written = upsertNode.run(
        node.id,
        node.boardId,
        node.type,
        node.title,
        node.color,
        node.position.x,
        node.position.y,
        node.size?.width ?? null,
        node.size?.height ?? null,
        node.collapsed === true ? 1 : 0,
        node.expandedHeight ?? null,
        node.parentId ?? null,
        JSON.stringify(node.labels),
        node.note,
        JSON.stringify(node.data),
        node.createdAt,
        node.updatedAt,
      );
      if (written.changes !== 1) {
        throw badRequest("Board contains a node that belongs to another board");
      }
    }
    const upsertEdge = database.prepare(
      "INSERT INTO edges (id, board_id, source_node_id, target_node_id, kind, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET " +
        "source_node_id = excluded.source_node_id, " +
        "target_node_id = excluded.target_node_id, kind = excluded.kind, " +
        "created_at = excluded.created_at, updated_at = excluded.updated_at " +
        "WHERE edges.board_id = excluded.board_id",
    );
    for (const edge of request.edges) {
      const written = upsertEdge.run(
        edge.id,
        edge.boardId,
        edge.source,
        edge.target,
        edge.kind,
        edge.createdAt,
        edge.updatedAt,
      );
      if (written.changes !== 1) {
        throw badRequest(
          "Board contains an edge that belongs to another board",
        );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return loadBoard(database, workspaceId, boardId);
}

export type { BoardDocument, CanvasEdge, CanvasNode, SaveBoardRequest };
