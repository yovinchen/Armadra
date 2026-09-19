import type { DatabaseSync } from "node:sqlite";
import { badRequest, isUuid, rfc3339 } from "../workspaces/support";

/**
 * The `context_links` table: the link document a node reads its collaborators
 * from.
 *
 * The canvas pushes each node's document whenever an edge changes, and the
 * context-link verbs authorise against exactly this list — which is why the
 * bounds below are enforced here rather than trusted from whatever the canvas
 * serialised. A `shape` link carries its own readable payload, is stored
 * verbatim and is later handed to an agent.
 */

const LINK_STATUSES = ["pending", "ready", "error"] as const;

export interface ContextLinkContent {
  readonly status?: string;
  readonly sourceShapeId?: string;
  readonly shapeType?: string;
  readonly textTruncated?: boolean;
  readonly text?: string;
  /** Workspace-relative path, resolved inside the workspace before use. */
  readonly pngPath?: string;
}

export interface ContextLink {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly content?: ContextLinkContent;
}

export interface ContextLinkDocument {
  readonly nodeId: string;
  readonly links: readonly ContextLink[];
  readonly updatedAt: string;
}

export function putContextLinks(
  database: DatabaseSync,
  workspaceId: string,
  nodeId: string,
  links: readonly ContextLink[],
): ContextLinkDocument {
  if (links.length > 64) {
    throw badRequest("A node cannot link more than 64 other nodes");
  }
  for (const link of links) {
    const content = link.content;
    if (content !== undefined && content !== null) {
      if (
        (content.status !== undefined &&
          !(LINK_STATUSES as readonly string[]).includes(content.status)) ||
        (content.sourceShapeId !== undefined &&
          content.sourceShapeId.length > 160) ||
        (content.shapeType !== undefined && content.shapeType.length > 40)
      ) {
        throw badRequest("Invalid whiteboard reference metadata");
      }
    }
    if (!isUuid(link.id) || link.title.length > 160 || link.kind.length > 40) {
      throw badRequest("Context link is invalid");
    }
    if (content !== undefined && content !== null) {
      if (
        (content.text !== undefined &&
          Buffer.byteLength(content.text, "utf8") > 20_000) ||
        (content.pngPath !== undefined &&
          Buffer.byteLength(content.pngPath, "utf8") > 4_096)
      ) {
        throw badRequest("Context link content is too large");
      }
    }
  }
  const now = rfc3339();
  database
    .prepare(
      "INSERT INTO context_links (node_id, workspace_id, links_json, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(node_id) DO UPDATE SET workspace_id = excluded.workspace_id, " +
        "links_json = excluded.links_json, updated_at = excluded.updated_at",
    )
    .run(nodeId, workspaceId, JSON.stringify(links), now);
  return getContextLinks(database, nodeId);
}

/**
 * A node with no stored document answers an empty one stamped *now*, exactly
 * as the Rust reader does: "nothing linked" is a valid answer, not a 404.
 */
export function getContextLinks(
  database: DatabaseSync,
  nodeId: string,
): ContextLinkDocument {
  const row = database
    .prepare(
      "SELECT node_id, links_json, updated_at FROM context_links WHERE node_id = ?",
    )
    .get(nodeId) as
    | { node_id: string; links_json: string; updated_at: string }
    | undefined;
  if (row === undefined) {
    return { nodeId, links: [], updatedAt: rfc3339() };
  }
  let links: ContextLink[] = [];
  try {
    const parsed = JSON.parse(row.links_json) as unknown;
    if (Array.isArray(parsed)) links = parsed as ContextLink[];
  } catch {
    links = [];
  }
  return { nodeId: row.node_id, links, updatedAt: row.updated_at };
}

/** The request body, with the same defaults serde applies. */
export function parseContextLinks(
  body: Record<string, unknown>,
): ContextLink[] {
  const raw = body.links;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest("links must be an array");
  return raw.map((entry) => {
    if (entry === null || typeof entry !== "object") {
      throw badRequest("Context link is invalid");
    }
    const link = entry as Record<string, unknown>;
    if (
      typeof link.id !== "string" ||
      typeof link.title !== "string" ||
      typeof link.kind !== "string"
    ) {
      throw badRequest("Context link is invalid");
    }
    const parsed: ContextLink = {
      id: link.id,
      title: link.title,
      kind: link.kind,
    };
    if (link.content === undefined || link.content === null) return parsed;
    if (typeof link.content !== "object") {
      throw badRequest("Context link is invalid");
    }
    return { ...parsed, content: link.content as ContextLinkContent };
  });
}
