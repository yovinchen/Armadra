import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useStore,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import type { CanvasEdgeType } from "@ai-coding-canvas/shared";
import { EDGE_META } from "../nodes";
import { usePreferences } from "../preferences/Preferences";
import { useCanvasStore } from "../store/canvas-store";

export interface SemanticEdgeData extends Record<string, unknown> {
  semanticType: CanvasEdgeType;
  label?: string;
}

export type SemanticFlowEdge = Edge<SemanticEdgeData, "semantic">;

const ARROW = "aicc-edge-arrow";
const ARROW_ACCENT = "aicc-edge-arrow-accent";
/** Label pills never shrink past this, so the semantics stay readable. */
const MIN_LABEL_SCALE = 0.75;

/** Both arrow heads, defined once per canvas instead of once per edge. */
export function SemanticEdgeMarkers() {
  return (
    <svg className="semantic-marker-defs" aria-hidden="true">
      <defs>
        {[
          [ARROW, "var(--faint)"],
          [ARROW_ACCENT, "var(--accent)"],
        ].map(([id, fill]) => (
          <marker
            key={id}
            id={id}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill={fill} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

/**
 * Semantic edge v2 (SPEC §4): bezier + arrow head, dashed for link/ref,
 * highlighted while either end is the selected node, midpoint pill that keeps
 * its legibility as the canvas zooms out.
 */
export const SemanticEdge = memo(function SemanticEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<SemanticFlowEdge>) {
  const { t } = usePreferences();
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const zoom = useStore((state) => state.transform[2]);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const semanticType = data?.semanticType ?? "link";
  const meta = EDGE_META[semanticType];
  const highlighted =
    Boolean(selectedNodeId) &&
    (selectedNodeId === source || selectedNodeId === target);
  const scale = Math.max(MIN_LABEL_SCALE, Math.min(1, zoom));

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#${highlighted ? ARROW_ACCENT : ARROW})`}
        className={[
          "semantic-edge",
          `semantic-edge--${semanticType}`,
          meta.dashed ? "semantic-edge--dashed" : "",
          highlighted ? "is-highlighted" : "",
          selected ? "is-selected" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      />
      <EdgeLabelRenderer>
        <span
          className={`semantic-edge-label${highlighted ? " is-highlighted" : ""}`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(${scale})`,
          }}
        >
          <span className="semantic-edge-glyph" aria-hidden="true">
            {meta.glyph}
          </span>
          {data?.label ?? t(meta.label)}
          <span className="semantic-edge-arrow" aria-hidden="true">
            →
          </span>
        </span>
      </EdgeLabelRenderer>
    </>
  );
});
