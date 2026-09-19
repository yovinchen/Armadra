import { rfc3339, uuidV7 } from "../workspaces/support";
import type { CanvasEdge, CanvasNode } from "./document-types";

/** The node and edge builders the document and validation tests reuse. */

export const DEFAULT_NODE_COLOR = "#0a84ff";

export function stickyNode(boardId: string): CanvasNode {
  const now = rfc3339();
  return {
    id: uuidV7(),
    boardId,
    type: "sticky",
    title: "Sticky",
    color: DEFAULT_NODE_COLOR,
    position: { x: 0, y: 0 },
    size: { width: 240, height: 200 },
    labels: [],
    note: "",
    data: { kind: "sticky", content: "hello" },
    createdAt: now,
    updatedAt: now,
  };
}

export function linkEdge(
  boardId: string,
  source: string,
  target: string,
): CanvasEdge {
  const now = rfc3339();
  return {
    id: uuidV7(),
    boardId,
    source,
    target,
    kind: "link",
    createdAt: now,
    updatedAt: now,
  };
}
