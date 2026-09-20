import type { DatabaseSync } from "node:sqlite";
import { badRequest } from "../workspaces/support";
import type { CanvasNode } from "./document-types";

/**
 * Agent 的名字（`handle`）：形状、`node_handles` 表，以及它与文档的对账。
 *
 * 名字与标题分工不同（`docs/design/agent-delivery.md` §2）：标题是给人看的散
 * 文，自动命名会改写它；名字是 Agent 之间互相称呼用的稳定短名，一块画布内唯
 * 一，只有显式改名才会变。
 *
 * # 一张表，一个写入点
 *
 * `node_handles` 是唯一来源：解析一个名字（`collab/addressing.ts::loadHandles`）
 * 只读这张表，`PRIMARY KEY (board_id, handle)` 就是「画布内唯一」本身，不再是
 * 某个动词自己做的一次读-判-写。
 *
 * `node.data.handle` 留着，但它是**渲染副本**：页面据此画节点头的徽标，不必为
 * 一个徽标再查一次库。副本不会与表漂移，因为两者只有一个写入点——
 * {@link syncHandles} 在 `saveBoard` 的那一个事务里，按刚写进 `nodes` 的文档把
 * 表对一遍。板文档是整份保存的（`saveBoard` 会删掉文档不再提及的节点），所以对
 * 账可以是「删掉这块画布的全部行，按文档重建」，而不是一串增量判断。
 */

/**
 * The longest a handle may be. Short on purpose: a handle exists so an agent
 * can type a peer's name without quoting a title.
 */
export const MAX_HANDLE_CHARS = 24;

/**
 * Normalizes `raw` into a handle, or `undefined` when it is not one.
 *
 * 1–{@link MAX_HANDLE_CHARS} ASCII characters, starting with a letter or a
 * digit and continuing with letters, digits, `-` or `_`. Case is folded, so
 * `Review` and `review` are the same handle and neither can shadow the other.
 */
export function normalizeHandle(raw: string): string | undefined {
  const handle = raw.trim().toLowerCase();
  if (handle.length === 0 || handle.length > MAX_HANDLE_CHARS) return undefined;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(handle)) return undefined;
  return handle;
}

/**
 * `node.data.handle`, re-validated rather than trusted: a board written by an
 * older client — or by hand — must not be able to register a handle the rename
 * verb would have refused.
 */
export function handleOf(data: Record<string, unknown>): string | undefined {
  const raw = data.handle;
  return typeof raw === "string" ? normalizeHandle(raw) : undefined;
}

/** {@link handleOf} for a node whose `data` may not be an object at all. */
export function handleOfNode(node: {
  readonly data: unknown;
}): string | undefined {
  const data = node.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  return handleOf(data as Record<string, unknown>);
}

/* -------------------------------- reading -------------------------------- */

/** node id → handle, for the ids asked about. Ids with no name are absent. */
export function handlesFor(
  database: DatabaseSync,
  nodeIds: readonly string[],
): Map<string, string> {
  const handles = new Map<string, string>();
  if (nodeIds.length === 0) return handles;
  // Only the placeholder count varies; every id is still bound.
  const placeholders = nodeIds.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT node_id, handle FROM node_handles WHERE node_id IN (${placeholders})`,
    )
    .all(...nodeIds) as unknown as { node_id: string; handle: string }[];
  for (const row of rows) handles.set(row.node_id, row.handle);
  return handles;
}

/** One node's name, or `undefined` when it has none. */
export function handleForNode(
  database: DatabaseSync,
  nodeId: string,
): string | undefined {
  const row = database
    .prepare("SELECT handle FROM node_handles WHERE node_id = ?")
    .get(nodeId) as unknown as { handle: string } | undefined;
  return row?.handle;
}

/** Who on this board already answers to `handle`, if anybody does. */
export function nodeNamed(
  database: DatabaseSync,
  boardId: string,
  handle: string,
): { readonly id: string; readonly title: string } | undefined {
  const row = database
    .prepare(
      "SELECT h.node_id AS id, COALESCE(n.title, '') AS title FROM node_handles h " +
        "LEFT JOIN nodes n ON n.id = h.node_id WHERE h.board_id = ? AND h.handle = ?",
    )
    .get(boardId, handle) as unknown as
    | { id: string; title: string }
    | undefined;
  return row;
}

/* ------------------------------- reconciling ------------------------------ */

/**
 * Rebuilds this board's rows from the document just written, inside the
 * caller's transaction.
 *
 * Three rules from the design live here:
 *
 *   * a name is released when its node is renamed away or **deleted** — the
 *     board's rows are dropped and only the document's nodes get one back;
 *   * moving a node to another board carries its name with it, so the node's
 *     own row is dropped first as well (its old board is not this one);
 *   * a collision is **refused**, never silently rewritten: the caller is told
 *     which name and who holds it.
 */
export function syncHandles(
  database: DatabaseSync,
  boardId: string,
  nodes: readonly CanvasNode[],
): void {
  const byBoard = database.prepare(
    "DELETE FROM node_handles WHERE board_id = ?",
  );
  byBoard.run(boardId);
  // A node arriving from another board still holds a row filed under that
  // board; without this the insert below would hit `node_id UNIQUE` and read
  // as a collision with a name nobody on this board is using.
  const byNode = database.prepare("DELETE FROM node_handles WHERE node_id = ?");
  const insert = database.prepare(
    "INSERT INTO node_handles (board_id, handle, node_id, updated_at) VALUES (?, ?, ?, ?)",
  );
  const taken = new Map<string, string>();
  for (const node of nodes) {
    const handle = handleOfNode(node);
    if (handle === undefined) {
      byNode.run(node.id);
      continue;
    }
    const first = taken.get(handle);
    if (first !== undefined) {
      throw collision(database, boardId, handle, first);
    }
    byNode.run(node.id);
    try {
      insert.run(boardId, handle, node.id, node.updatedAt);
    } catch {
      throw collision(database, boardId, handle, undefined);
    }
    taken.set(handle, node.id);
  }
}

function collision(
  database: DatabaseSync,
  boardId: string,
  handle: string,
  holderId: string | undefined,
): Error {
  const title =
    holderId === undefined
      ? nodeNamed(database, boardId, handle)?.title
      : (
          database
            .prepare("SELECT title FROM nodes WHERE id = ?")
            .get(holderId) as unknown as { title: string } | undefined
        )?.title;
  return badRequest(
    title === undefined || title === ""
      ? `名字「${handle}」在这块画布上已经被占用了，请换一个。`
      : `名字「${handle}」已经属于「${title}」，请换一个。`,
  );
}
