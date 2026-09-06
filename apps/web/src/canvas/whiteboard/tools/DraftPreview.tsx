import { ViewportPortal } from "@xyflow/react";

import { geoPath } from "../geometry";
import { inkPath } from "../ink";
import {
  colorHex,
  dashArray,
  fillOpacity,
  HIGHLIGHT_OPACITY,
  HIGHLIGHT_SCALE,
  strokeWidth,
} from "../palette";
import { useCanvasScheme } from "../scheme";
import { draftRect, type Draft } from "./draft";

/**
 * 进行中的图形（React Flow 计划 §2.4，归属 whiteboard）。
 *
 * 画在 `<ViewportPortal>` 里：那一层已经替我们做完相机变换，所以坐标直接
 * 用画布坐标，缩放平移都不用管。松手之后这一层消失，真正的节点接上——
 * 两边用同一份路径函数，所以不会出现「画的时候一条线、落成后另一条线」。
 */

export function DraftPreview({ draft }: { draft: Draft | null }) {
  const scheme = useCanvasScheme();
  if (!draft) return null;
  return (
    <ViewportPortal>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          pointerEvents: "none",
          // 进行中的图形压在所有节点之上，否则会被刚画到一半的地方挡住。
          zIndex: 10_000,
        }}
      >
        <svg
          width={1}
          height={1}
          style={{ overflow: "visible", display: "block" }}
          aria-hidden
        >
          <DraftShape draft={draft} scheme={scheme} />
        </svg>
      </div>
    </ViewportPortal>
  );
}

function DraftShape({
  draft,
  scheme,
}: {
  draft: Draft;
  scheme: "light" | "dark";
}) {
  if (draft.kind === "frame") {
    const rect = draftRect(draft);
    return (
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        fill="none"
        stroke="var(--brand)"
        strokeWidth={1.5}
        strokeDasharray="6 4"
      />
    );
  }

  const color = colorHex(draft.style.color, scheme);
  const width = strokeWidth(draft.style.size);

  if (draft.kind === "ink") {
    const size = draft.highlight ? width * HIGHLIGHT_SCALE : width;
    return (
      <path
        d={inkPath(draft.points, {
          size,
          last: false,
          highlight: draft.highlight,
        })}
        fill={color}
        opacity={draft.highlight ? HIGHLIGHT_OPACITY : 1}
      />
    );
  }

  if (draft.kind === "line") {
    return (
      <line
        x1={draft.origin.x}
        y1={draft.origin.y}
        x2={draft.current.x}
        y2={draft.current.y}
        stroke={color}
        strokeWidth={width}
        strokeDasharray={dashArray(draft.style.dash, width)}
        strokeLinecap="round"
      />
    );
  }

  const rect = draftRect(draft);
  const opacity = fillOpacity(draft.style.fill);
  return (
    <g transform={`translate(${rect.x} ${rect.y})`}>
      <path
        d={geoPath(draft.geo, rect.w, rect.h)}
        fill={opacity > 0 ? color : "none"}
        fillOpacity={opacity > 0 ? opacity : undefined}
        stroke={color}
        strokeWidth={width}
        strokeDasharray={dashArray(draft.style.dash, width)}
        strokeLinejoin="round"
      />
    </g>
  );
}
