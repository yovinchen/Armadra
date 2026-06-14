import { EDGE_TYPES } from "@ai-coding-canvas/shared";
import type { CanvasEdgeType, CanvasNodeType } from "@ai-coding-canvas/shared";

const REF_SOURCES: CanvasNodeType[] = [
  "file",
  "context",
  "note",
  "browser",
  "image",
  "log",
];

/**
 * The semantic the canvas suggests for a freshly drawn connection.
 * See docs/redesign-plan.md §4.
 */
export function recommendedEdgeType(
  source: CanvasNodeType,
  target: CanvasNodeType,
): CanvasEdgeType {
  if (source === "task" && target === "agent") return "dispatch";
  if (REF_SOURCES.includes(source) && target === "agent") return "ref";
  if (source === "agent" && target === "diff") return "produce";
  if (source === "diff" && target === "file") return "write";
  if (
    (source === "agent" || source === "terminal") &&
    (target === "terminal" || target === "agent")
  ) {
    return "trigger";
  }
  return "link";
}

/**
 * The picker never blocks a connection: every semantic stays reachable, the
 * recommended one is simply listed first so the ⏎/1 hotkey lands on it.
 */
export function legalEdgeTypes(
  source: CanvasNodeType,
  target: CanvasNodeType,
): CanvasEdgeType[] {
  const recommended = recommendedEdgeType(source, target);
  return [recommended, ...EDGE_TYPES.filter((type) => type !== recommended)];
}
