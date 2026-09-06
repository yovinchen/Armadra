import * as React from "react";
import type { ConnectionLineComponentProps, Node } from "@xyflow/react";

import type { Box } from "../../geometry";
import { linkCurve } from "./link-path";
import { STROKE_WIDTH } from "./link-visual";

/**
 * 拖线时的预览（React Flow 计划 §2.5 第三条，归属 B1）。
 *
 * 必须和落成后的 `LinkEdge` 是**同一条曲线**：起点是起笔节点朝向指针那
 * 一侧的边中点，控制点由 `link-path.linkCurve` 给。默认的直线预览会在松手
 * 那一刻突然弹成贝塞尔，看起来像连错了地方（ui-refinement「连线预览与持久
 * 化链接使用同一组边缘端口与 Bézier 几何」）。
 *
 * 指针还没落到任何节点上时，把指针本身当成一个零尺寸的矩形喂进去：
 * `facingSides` 于是按左右方向选边，和真的落上去时选的是同一侧。
 */

/** 落到合法目标上时预览线变成品牌色，否则维持中性灰。 */
const VALID_COLOR = "var(--brand)";
const NEUTRAL_COLOR = "var(--muted-foreground)";
const INVALID_COLOR = "var(--danger)";

function boxOf(node: {
  measured: { width?: number; height?: number };
  width?: number | null;
  height?: number | null;
  internals: { positionAbsolute: { x: number; y: number } };
}): Box {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width: node.measured.width ?? node.width ?? 0,
    height: node.measured.height ?? node.height ?? 0,
  };
}

export function ConnectionLine({
  fromNode,
  toNode,
  toX,
  toY,
  connectionStatus,
}: ConnectionLineComponentProps<Node>) {
  const from = boxOf(fromNode);
  // 悬停在目标上时用目标的真实矩形，画的就是落成之后那条线。
  const to: Box = toNode
    ? boxOf(toNode)
    : { x: toX, y: toY, width: 0, height: 0 };
  const curve = linkCurve(from, to);
  const color =
    connectionStatus === "valid"
      ? VALID_COLOR
      : connectionStatus === "invalid"
        ? INVALID_COLOR
        : NEUTRAL_COLOR;

  return (
    <g data-slot="connection-line">
      <path
        d={curve.d}
        fill="none"
        stroke={color}
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        // 还没落到目标上时用虚线：一眼能看出这条线还没连上东西。
        {...(toNode ? {} : { strokeDasharray: "6 4" })}
      />
      <circle cx={curve.targetX} cy={curve.targetY} r={3} fill={color} />
    </g>
  );
}

export default React.memo(ConnectionLine);
