import * as React from "react";
import { BaseEdge, useInternalNode, useStore } from "@xyflow/react";
import type { EdgeProps, InternalNode, Node } from "@xyflow/react";
import type { CanvasEdgeRole, CanvasNode } from "@armadra/shared";

import { useDeliveryEdge, type DeliveryMark } from "@/agent/delivery-store";
import { useT } from "@/app/preferences-store";
import { displayNameOf } from "@/canvas/supervision";
import { formatRelativeTime } from "@/lib/format";
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

/** 一端在提示里的称呼：名字优先，其次标题。 */
function nameOf(
  node: InternalNode<Node> | undefined,
  fallback: string,
): string {
  return displayNameOf(node?.data as CanvasNode | undefined, fallback);
}

/**
 * 边上那句悬停提示：最近一次投递的结果与时刻。
 *
 * 结果码原样按码取文案（`i18n/errors.ts` 的码表），拒绝的那一条多说一句为什么
 * ——`refused` 单独看等于什么都没说。没有投递过就没有这句话。
 */
export function deliveryTooltip(
  mark: DeliveryMark | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | null {
  if (mark === undefined) return null;
  const outcome = t(`delivery.outcome.${mark.outcome}`);
  const line = t("delivery.edge.last", {
    outcome,
    time: formatRelativeTime(mark.at),
  });
  return mark.code === undefined
    ? line
    : `${line} · ${t(`error.delivery.${mark.code}`)}`;
}

/**
 * 主从边的那句提示：「主 @a → 从 @b」。
 *
 * 箭头已经说了方向，这句话说的是**谁是谁**：一条线两端的圆角矩形长得一样，
 * 而「planner 盯着 codex-1」与反过来是两件事。对等边没有这句话。
 */
export function supervisionTooltip(
  role: CanvasEdgeRole | undefined,
  supervisor: string,
  subordinate: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | null {
  if (role !== "supervises") return null;
  return t("edge.role.supervises", { supervisor, subordinate });
}

export function LinkEdge({
  source,
  target,
  selected = false,
  style,
  data,
}: EdgeProps<LinkFlowEdge>) {
  const t = useT();
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  // 缩得太小时标签只剩糊成一团的墨点（§2.3）。只订阅缩放这一个数，
  // 平移时不会把每条边都重渲一遍。
  const zoom = useStore((state) => state.transform[2]);
  // 这条边上最近一次投递（设计 §10）。两个方向取较新的那一次：画布上的一条线
  // 是无向的，投递不是。
  const { mark, flashing } = useDeliveryEdge(source, target);
  // 主从边多一句「主 @a → 从 @b」。两句话叠在同一个 `<title>` 里：一条边只有
  // 一处可以停下鼠标。
  const role = data?.role;
  const supervision = supervisionTooltip(
    role,
    nameOf(sourceNode, source),
    nameOf(targetNode, target),
    t,
  );
  const tooltip =
    [supervision, deliveryTooltip(mark, t)].filter(Boolean).join("\n") || null;

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
  // 主从边一律用品牌色并且**只画一个箭头**（指向从）：它是画布上唯一一条有
  // 方向的关系，读者要能在不悬停的情况下看出方向。对等边照旧按两端的类型决定
  // 箭头，颜色也照旧中性——大多数边都是对等的，全画成高亮就等于没有高亮。
  const supervises = role === "supervises";
  const color =
    flashing || selected || supervises
      ? "var(--brand)"
      : "var(--muted-foreground)";
  const arrowStart = supervises ? false : view.arrowStart;
  const arrowEnd = supervises ? true : view.arrowEnd;
  const label = zoom >= LABEL_MIN_ZOOM ? t(view.labelKey) : "";

  return (
    <g
      style={{ color }}
      data-slot="link-edge"
      data-delivery={flashing ? "true" : undefined}
      data-role={supervises ? "supervises" : undefined}
    >
      {/*
        最近一次投递（设计 §10）。原生 `<title>` 而不是一个浮层：一条边不该
        因为要说一句话就变成一个可聚焦的控件，而这句话只在鼠标停下来时有用。
        正文不在这里——记录里从来就没有正文。
      */}
      {tooltip === null ? null : <title>{tooltip}</title>}
      <BaseEdge
        path={curve.d}
        interactionWidth={INTERACTION_WIDTH}
        style={{
          ...style,
          stroke: "currentColor",
          strokeWidth: flashing ? width + 1 : width,
          strokeLinecap: "round",
        }}
      />
      {/*
        投递的那一下：一段沿着同一条曲线流向目标的虚线，两秒后自己停。
        动效由 `prefers-reduced-motion` 统一压掉（tokens.css），压掉之后线仍然
        是高亮的——「刚刚发生过一件事」这个事实不该只由动画承担。
      */}
      {flashing ? (
        <path
          className="anim-delivery-flow"
          d={curve.d}
          fill="none"
          stroke="currentColor"
          strokeWidth={width + 1}
          strokeLinecap="round"
          strokeDasharray="6 10"
          pointerEvents="none"
        />
      ) : null}
      {arrowStart ? (
        <path
          d={arrowHead({ x: curve.sourceX, y: curve.sourceY }, curve.c1)}
          fill="none"
          stroke="currentColor"
          strokeWidth={width}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {arrowEnd ? (
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
