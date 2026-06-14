import { useCallback } from "react";
import { useReactFlow } from "@xyflow/react";
import type { Position } from "@ai-coding-canvas/shared";
import { useCanvasStore } from "../store/canvas-store";
import { effectiveSize } from "./node-zoom";

export interface ArrangeNode {
  id: string;
  /** Effective width — mini nodes must report the 240×52 summary box. */
  width: number;
  height: number;
}

export interface ArrangeEdge {
  source: string;
  target: string;
}

/** Layout constants from SPEC §6 / the prototype's `autoArrange`. */
export const ROW_GAP = 40;
export const COLUMN_GAP = 120;
export const MAX_DEPTH = 50;

/**
 * Topological column layout: sources on the left, one column per BFS depth,
 * nodes stacked vertically inside a column, unconnected nodes in a trailing
 * column. Pure so the layout stays testable (plan §7, B1).
 */
export function autoArrange(
  nodes: ArrangeNode[],
  edges: ArrangeEdge[],
): Record<string, Position> {
  if (nodes.length === 0) return {};
  const known = new Set(nodes.map((node) => node.id));
  const links = edges.filter(
    (edge) => known.has(edge.source) && known.has(edge.target),
  );

  const incoming = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  for (const edge of links) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }

  const outgoing = new Map<string, string[]>();
  for (const edge of links) {
    const list = outgoing.get(edge.source);
    if (list) list.push(edge.target);
    else outgoing.set(edge.source, [edge.target]);
  }

  // Depth by BFS from the source-only roots. The `>= depth` guard keeps
  // cycles from looping forever; MAX_DEPTH caps pathological chains.
  const depth = new Map<string, number>();
  const visit = (id: string, level: number) => {
    if (level > MAX_DEPTH) return;
    const seen = depth.get(id);
    if (seen !== undefined && seen >= level) return;
    depth.set(id, level);
    for (const next of outgoing.get(id) ?? []) visit(next, level + 1);
  };
  for (const node of nodes) {
    if (incoming.get(node.id) === 0 && outgoing.has(node.id)) visit(node.id, 0);
  }

  const deepest = Math.max(-1, ...depth.values());
  const orphanColumn = deepest + 1;
  const columns = new Map<number, ArrangeNode[]>();
  for (const node of nodes) {
    const level = depth.get(node.id) ?? orphanColumn;
    const column = columns.get(level);
    if (column) column.push(node);
    else columns.set(level, [node]);
  }

  const positions: Record<string, Position> = {};
  let x = 0;
  for (const level of [...columns.keys()].sort((a, b) => a - b)) {
    let y = 0;
    let width = 0;
    for (const node of columns.get(level) ?? []) {
      positions[node.id] = { x, y };
      y += node.height + ROW_GAP;
      width = Math.max(width, node.width);
    }
    x += width + COLUMN_GAP;
  }
  return positions;
}

/**
 * Toolbar「⊞ 一键整理」and ⌘⇧L: lay the board out, drop any focus mode and
 * fit the result once React has painted the new positions.
 */
export function useAutoArrange(): () => void {
  const { getZoom, fitView } = useReactFlow();
  return useCallback(() => {
    const store = useCanvasStore.getState();
    const document = store.document;
    if (!document || document.nodes.length === 0) return;
    const zoom = getZoom();
    const threshold = store.summaryThreshold;

    const positions = autoArrange(
      document.nodes.map((node) => {
        const size = effectiveSize(
          { ...node, zoom: node.zoom === "focus" ? "normal" : node.zoom },
          zoom,
          threshold,
        );
        return { id: node.id, width: size.width, height: size.height };
      }),
      document.edges.map((edge) => ({
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
      })),
    );

    for (const node of document.nodes) {
      if (node.zoom === "focus") store.setNodeZoom(node.id, "normal");
    }
    store.arrangeNodes(positions);
    store.setTool("select");
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void fitView({ padding: 0.1, maxZoom: 1.5 });
      });
    });
  }, [fitView, getZoom]);
}
