import type { DatabaseSync } from "node:sqlite";
import { Refusal } from "./refusals";

/**
 * Resolving what a collaboration verb is allowed to touch.
 *
 * Ported from the lookup half of the pre-merge implementation. Everything
 * here re-derives the answer from the database rather than from the request:
 * the caller is a CLI acting on text it read somewhere, so "which node is
 * this?" and "may it reach that one?" are questions the board answers, never
 * questions the body does.
 */

/** One canvas node, resolved far enough to authorize against it. */
export interface NodeRef {
  readonly id: string;
  readonly boardId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly nodeType: string;
  /** `data.agent.id` for a terminal node running an agent. */
  readonly agentId: string | null;
  readonly data: Record<string, unknown>;
}

interface NodeRow {
  readonly id: string;
  readonly board_id: string;
  readonly workspace_id: string;
  readonly title: string;
  readonly type: string;
  readonly data_json: string;
}

export function loadNode(
  database: DatabaseSync,
  nodeId: string,
): NodeRef | undefined {
  const row = database
    .prepare(
      "SELECT n.id AS id, n.board_id AS board_id, n.title AS title, n.type AS type, " +
        "n.data_json AS data_json, b.workspace_id AS workspace_id " +
        "FROM nodes n JOIN boards b ON b.id = n.board_id WHERE n.id = ?",
    )
    .get(nodeId) as NodeRow | undefined;
  if (row === undefined) return undefined;
  return nodeRefOf(row);
}

function nodeRefOf(row: NodeRow): NodeRef {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.data_json) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  return {
    id: row.id,
    boardId: row.board_id,
    workspaceId: row.workspace_id,
    title: row.title,
    nodeType: row.type,
    agentId: agentIdOf(data),
    data,
  };
}

/** `data.agent.id`, when the node data really says so. */
export function agentIdOf(data: Record<string, unknown>): string | null {
  const agent = data.agent;
  if (agent === null || typeof agent !== "object" || Array.isArray(agent)) {
    return null;
  }
  const id = (agent as Record<string, unknown>).id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** The terminal session a node is running, or its newest dead one. */
export interface SessionRef {
  readonly sessionId: string;
  readonly generation: number;
  readonly status: string;
}

export function loadSession(
  database: DatabaseSync,
  nodeId: string,
): SessionRef | undefined {
  const row = database
    .prepare(
      // A running session wins over a newer dead one. A node can own more
      // than one row — an old tmux pane adopted after a restart sits beside
      // the session the node opened meanwhile — and ordering by age alone
      // handed `context terminal` a session whose process was gone, which
      // reads as "that node has no terminal" about a node that plainly has.
      "SELECT id, generation, status FROM terminal_sessions WHERE owner_node_id = ? " +
        "ORDER BY (status = 'running') DESC, generation DESC, created_at DESC " +
        "LIMIT 1",
    )
    .get(nodeId) as
    | { id: string; generation: number; status: string }
    | undefined;
  if (row === undefined) return undefined;
  return {
    sessionId: row.id,
    generation: Math.max(0, Number(row.generation)),
    status: row.status,
  };
}

export function workspaceRoot(
  database: DatabaseSync,
  workspaceId: string,
): string | undefined {
  const row = database
    .prepare("SELECT root_path FROM workspaces WHERE id = ?")
    .get(workspaceId) as { root_path: string } | undefined;
  return row?.root_path;
}

/* --------------------------------- caller --------------------------------- */

/**
 * How much the hook surface believes the caller.
 *
 * `verified` means the request carried a node token this core minted for
 * exactly this node. `legacy` is a caller with no token at all — old client,
 * or a terminal that outlived the data directory — and may run only the
 * read-only verbs. `forged` is a token this core minted for somebody else and
 * is refused outright.
 */
export type Verdict = "verified" | "legacy" | "forged";

/** Who is calling, and how much we believe them. */
export interface Caller {
  readonly node: NodeRef;
  readonly verdict: Verdict;
}

export function isVerified(caller: Caller): boolean {
  return caller.verdict === "verified";
}

/** Everything except the read-only verbs needs a token this core minted. */
export function requireVerified(caller: Caller, verb: string): void {
  if (isVerified(caller)) return;
  throw Refusal.forbidden(
    `\`${verb}\` 需要本运行时签发的节点令牌；这个终端没有，已拒绝。`,
  );
}

/**
 * `<nodeId>` as the hook surface is allowed to spell it.
 *
 * The same character class the Rust `hook::auth::valid_node_id` enforces: the
 * id reaches the filesystem as a token file name, so anything that could
 * escape a directory or name a file we did not write is refused before it gets
 * anywhere near one.
 */
export function validNodeId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9_.-]+$/.test(value) &&
    !value.includes("..")
  );
}
