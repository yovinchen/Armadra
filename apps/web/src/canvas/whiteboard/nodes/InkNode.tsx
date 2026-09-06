import * as React from "react";
import type { Node, NodeProps } from "@xyflow/react";

import { inkPath } from "../ink";
import {
  colorHex,
  HIGHLIGHT_OPACITY,
  HIGHLIGHT_SCALE,
  strokeWidth,
} from "../palette";
import { useCanvasScheme } from "../scheme";
import type { InkItem } from "../model";
import { ItemFrame } from "./ItemFrame";

/**
 * 墨迹与高亮（React Flow 计划 F22，归属 whiteboard）。
 *
 * 点集是相对对象原点的，所以 SVG 的 `viewBox` 就是 `0 0 w h`，缩放对象时
 * 点集本身被 `store.resizeItem` 缩过——不是靠 CSS transform 拉伸，那会把
 * 线宽也一起拉扁。
 *
 * 轮廓由 `perfect-freehand` 生成后当**填充路径**画（不是描边），所以线宽
 * 随压力变化。高亮笔粗四倍、半透明、`multiply` 混合：压在文字上仍然读得
 * 出下面的字。
 */

export type InkFlowNode = Node<InkItem, "wb.ink">;

export function InkNode({ data, selected = false }: NodeProps<InkFlowNode>) {
  const scheme = useCanvasScheme();
  const base = strokeWidth(data.style.size);
  const size = data.highlight ? base * HIGHLIGHT_SCALE : base;
  const d = React.useMemo(
    () => inkPath(data.points, { size, highlight: data.highlight }),
    [data.highlight, data.points, size],
  );

  return (
    <ItemFrame item={data} selected={selected}>
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${Math.max(data.w, 1)} ${Math.max(data.h, 1)}`}
        preserveAspectRatio="none"
        style={{
          display: "block",
          overflow: "visible",
          opacity: data.highlight ? HIGHLIGHT_OPACITY : 1,
          mixBlendMode: data.highlight ? "multiply" : undefined,
        }}
        aria-hidden
      >
        <path d={d} fill={colorHex(data.style.color, scheme)} />
      </svg>
    </ItemFrame>
  );
}

export default React.memo(InkNode);
