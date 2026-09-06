import * as React from "react";
import { BaseEdge, useInternalNode, useStore } from "@xyflow/react";
import type { EdgeProps, InternalNode, Node } from "@xyflow/react";
import type { CanvasNode } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import type { Box } from "../../geometry";
import type { LinkFlowEdge } from "../../sync/project";
import {
  arrowHead,
  linkView,
  INTERACTION_WIDTH,
  LABEL_FONT_SIZE,
  LABEL_MIN_ZOOM,
  STROKE_WIDTH,
  STROKE_WIDTH_SELECTED,
} from "./link-visual";

/**
 * 上下文连线（React Flow 计划 F06 / §2.3，归属 B1）。
 *
 * 画的是 v3 那条贝塞尔：两个节点**相对的边的中点**之间的三次曲线，
 * 只走左右两侧（免得从头部上方绕过去挡住标题）。几何在
 * `flow/edges/link-path.ts`，配色与箭头方向在 `link-visual.ts`，
 * 这个文件只负责把两端的矩形取出来再把 SVG 吐出去。
 *
 * **不用把手坐标**（`EdgeProps` 给的 `sourceX/sourceY`）：把手是节点左右
 * 两侧固定的两个点，而这条曲线要根据两端的相对位置自己选边——节点在右边
 * 时从右侧出发、在左边时从左侧出发，跟用户从哪个把手拖出来无关。所以这里
 * 读 `useInternalNode` 的绝对矩形，两端一动就自动重算。
 */

/** 一端的矩形；React Flow 还没量到尺寸时退回投影给的宽高。 */
function boxOf(node: InternalNode<Node> | undefined): Box | null {
  if (!node) return null;
  const width = node.measured.width ?? node.width ?? 0;
  const height = node.measured.height ?? node.height ?? 0;
  if (width <= 0 || height <= 0) return null;
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width,
    height,
  };
}

/** 节点类型（`terminal` / `sticky` / `group` …），决定箭头方向与标签。 */
function typeOf(node: InternalNode<Node> | undefined): string | undefined {
  const data = node?.data as CanvasNode | undefined;
  return data?.type;
}

export function LinkEdge({
  source,
  target,
  selected = false,
  style,
}: EdgeProps<LinkFlowEdge>) {
  const t = useT();
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  // 缩得太小时标签只剩糊成一团的墨点（§2.3）。只订阅缩放这一个数，
  // 平移时不会把每条边都重渲一遍。
  const zoom = useStore((state) => state.transform[2]);

  const sourceBox = boxOf(sourceNode);
  const targetBox = boxOf(targetNode);
  if (!sourceBox || !targetBox) return null;

  const view = linkView(
    sourceBox,
    targetBox,
    typeOf(sourceNode),
    typeOf(targetNode),
  );
  const { curve } = view;
  const width = selected ? STROKE_WIDTH_SELECTED : STROKE_WIDTH;
  const color = selected ? "var(--brand)" : "var(--muted-foreground)";
  const label = zoom >= LABEL_MIN_ZOOM ? t(view.labelKey) : "";

  return (
    <g style={{ color }} data-slot="link-edge">
      <BaseEdge
        path={curve.d}
        interactionWidth={INTERACTION_WIDTH}
        style={{
          ...style,
          stroke: "currentColor",
          strokeWidth: width,
          strokeLinecap: "round",
        }}
      />
      {view.arrowStart ? (
        <path
          d={arrowHead({ x: curve.sourceX, y: curve.sourceY }, curve.c1)}
          fill="none"
          stroke="currentColor"
          strokeWidth={width}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {view.arrowEnd ? (
        <path
          d={arrowHead({ x: curve.targetX, y: curve.targetY }, curve.c2)}
          fill="none"
          stroke="currentColor"
          strokeWidth={width}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {label ? (
        <text
          x={curve.labelX}
          y={curve.labelY}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={LABEL_FONT_SIZE}
          /*
           * 文字用线自己的颜色，不用 `--foreground`：画布纸张色是用户单独
           * 选的（`--canvas-bg` 直接写在 <html> 上），深色主题下也可能是一张
           * 浅色纸，主题文字色在那上面会糊掉。描边当底衬，顺带解决线穿过
           * 文字中间的丑样子。
           */
          style={{
            paintOrder: "stroke",
            stroke: "var(--canvas-bg)",
            strokeWidth: 5,
            strokeLinejoin: "round",
            fill: "currentColor",
            fillOpacity: 0.85,
            userSelect: "none",
          }}
        >
          {label}
        </text>
      ) : null}
    </g>
  );
}

export default React.memo(LinkEdge);
