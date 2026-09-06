import * as React from "react";
import type { Node, NodeProps } from "@xyflow/react";

import { geoPath } from "../geometry";
import {
  colorHex,
  dashArray,
  fillOpacity,
  fontSize,
  strokeWidth,
} from "../palette";
import { useCanvasScheme } from "../scheme";
import type { ShapeItem } from "../model";
import { ItemFrame } from "./ItemFrame";
import { InlineText } from "./InlineText";

/**
 * 六种几何形（React Flow 计划 F23，归属 whiteboard）。
 *
 * 路径由 `whiteboard/geometry.geoPath` 算，SVG 与导出的 PNG 用同一份 `d`。
 * 描边画在 `viewBox` 内，所以线宽会随对象缩放——这是刻意的：把一个矩形
 * 拉大，用户预期它整体变大，而不是边框保持 3.5px 不变。
 *
 * 双击进标签编辑（纯文本，居中）。标签是形状的一部分，不是另一条对象：
 * 引用一个形状时文字取的就是它。
 */

export type ShapeFlowNode = Node<ShapeItem, "wb.shape">;

export function ShapeNode({
  id,
  data,
  selected = false,
}: NodeProps<ShapeFlowNode>) {
  const scheme = useCanvasScheme();
  const color = colorHex(data.style.color, scheme);
  const width = strokeWidth(data.style.size);
  const w = Math.max(data.w, 1);
  const h = Math.max(data.h, 1);
  const d = React.useMemo(() => geoPath(data.geo, w, h), [data.geo, h, w]);
  const opacity = fillOpacity(data.style.fill);

  return (
    <ItemFrame item={data} selected={selected}>
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        style={{ display: "block", overflow: "visible" }}
        aria-hidden
      >
        <path
          d={d}
          fill={opacity > 0 ? color : "none"}
          fillOpacity={opacity > 0 ? opacity : undefined}
          stroke={color}
          strokeWidth={width}
          strokeDasharray={dashArray(data.style.dash, width)}
          strokeLinejoin="round"
        />
      </svg>
      <InlineText
        itemId={id}
        text={data.label ?? ""}
        field="label"
        color={color}
        fontSize={fontSize(data.style.size)}
        align="center"
        placeholderHidden
      />
    </ItemFrame>
  );
}

export default React.memo(ShapeNode);
