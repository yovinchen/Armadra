import type { CanvasNodeData } from "@ai-coding-canvas/shared";

/**
 * Props every node body receives from `canvas/NodeCard.tsx` (plan §5).
 * `focused` is true while the node occupies the whole viewport (`zoom: "focus"`).
 */
export interface NodeContentProps {
  id: string;
  data: CanvasNodeData;
  focused: boolean;
}

/** Narrow the discriminated union to a single node kind. */
export type OfKind<K extends CanvasNodeData["kind"]> = Extract<
  CanvasNodeData,
  { kind: K }
>;
