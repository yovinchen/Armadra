import {
  useCallback,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ViewportPortal, useReactFlow } from "@xyflow/react";
import type { Position, Stroke } from "@ai-coding-canvas/shared";
import { useCanvasStore } from "../store/canvas-store";

/** Pen width in world units (plan §2: `Stroke.width` defaults to 3). */
export const STROKE_WIDTH = 3;

const NO_STROKES: Stroke[] = [];

export interface LiveStroke {
  color: string;
  points: Position[];
}

function toPath(points: Position[]): string {
  return points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`,
    )
    .join(" ");
}

/**
 * Freehand annotations (SPEC §6). Points are world coordinates, so rendering
 * inside `<ViewportPortal>` makes them pan and zoom with the graph for free.
 */
export function StrokeLayer({ live }: { live?: LiveStroke | null }) {
  const strokes =
    useCanvasStore((state) => state.document?.strokes) ?? NO_STROKES;
  if (strokes.length === 0 && !live) return null;

  return (
    <ViewportPortal>
      <svg className="canvas-strokes" aria-hidden="true">
        {strokes.map((stroke) => (
          <path
            key={stroke.id}
            d={toPath(stroke.points)}
            fill="none"
            stroke={stroke.color}
            strokeWidth={stroke.width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {live && live.points.length > 1 && (
          <path
            d={toPath(live.points)}
            fill="none"
            stroke={live.color}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </ViewportPortal>
  );
}

/**
 * Pen-mode pointer capture. Only mounted while `tool === "pen"`, which is also
 * when the pane stops panning and nodes stop dragging (CanvasWorkspace).
 */
export function PenCapture({
  onLive,
}: {
  onLive: (stroke: LiveStroke | null) => void;
}) {
  const penColor = useCanvasStore((state) => state.penColor);
  const addStroke = useCanvasStore((state) => state.addStroke);
  const { screenToFlowPosition } = useReactFlow();
  const points = useRef<Position[]>([]);
  const drawing = useRef(false);

  const finish = useCallback(() => {
    if (!drawing.current) return;
    drawing.current = false;
    const collected = points.current;
    points.current = [];
    onLive(null);
    // A tap is not a stroke; the runtime also rejects degenerate paths.
    if (collected.length < 2) return;
    addStroke({
      id: crypto.randomUUID(),
      color: penColor,
      width: STROKE_WIDTH,
      points: collected,
    });
  }, [addStroke, onLive, penColor]);

  const at = (event: ReactPointerEvent<HTMLDivElement>) =>
    screenToFlowPosition({ x: event.clientX, y: event.clientY });

  return (
    <div
      className="canvas-pen-capture"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Capture is an optimisation: without it the stroke simply ends
          // when the pointer leaves the overlay.
        }
        drawing.current = true;
        points.current = [at(event)];
        onLive({ color: penColor, points: points.current });
      }}
      onPointerMove={(event) => {
        if (!drawing.current) return;
        points.current = [...points.current, at(event)];
        onLive({ color: penColor, points: points.current });
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
    />
  );
}
