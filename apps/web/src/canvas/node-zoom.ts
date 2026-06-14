import type { CanvasNodeType, NodeZoom, Size } from "@ai-coding-canvas/shared";
import { DEFAULT_NODE_SIZES } from "../store/canvas-store";

/** Summary card size from SPEC §3 / plan §6. */
export const MINI_SIZE: Size = { width: 240, height: 52 };

export interface ZoomableNode {
  zoom: NodeZoom;
}

export interface SizedNode extends ZoomableNode {
  type: CanvasNodeType;
  size?: Size;
}

/**
 * Tri-state zoom (SPEC §3):
 * - `focus` always wins — a focused node stays focused at any viewport zoom;
 * - a node pinned to `mini` stays mini;
 * - everything else collapses to `mini` once the viewport drops below the
 *   summary threshold (default 60%).
 */
export function effectiveZoom(
  node: ZoomableNode,
  viewportZoom: number,
  threshold: number,
): NodeZoom {
  if (node.zoom === "focus") return "focus";
  if (node.zoom === "mini") return "mini";
  return viewportZoom < threshold ? "mini" : "normal";
}

/** The node's own size, falling back to the per-type default (plan §6). */
export function nodeSize(node: SizedNode): Size {
  return node.size ?? DEFAULT_NODE_SIZES[node.type];
}

/**
 * The box React Flow must use so edges attach to the card that is actually
 * painted. `focus` keeps its normal box: the focused card is an overlay and
 * the graph geometry underneath must not jump.
 */
export function effectiveSize(
  node: SizedNode,
  viewportZoom: number,
  threshold: number,
): Size {
  return effectiveZoom(node, viewportZoom, threshold) === "mini"
    ? MINI_SIZE
    : nodeSize(node);
}
