import type { Position } from "@armadra/shared";

import type { Box } from "../../geometry";
import { edgeArrowheads, edgeLabelKey } from "../../sync/project";
import { linkCurve, type LinkCurve } from "./link-path";

/**
 * 一条上下文连线画成什么样（纯函数，`LinkEdge.tsx` 与单测共用）。
 *
 * 从旧引擎的 `shapes/LinkShapeUtil.tsx` 搬过来的那一半：曲线、箭头方向、
 * 标签键、线宽。另一半（`ShapeUtil` 的 `getGeometry` / `getIndicatorPath` /
 * 一堆 `hideXxx`）在 React Flow 里没有对应物——边的命中区由 `BaseEdge` 的
 * `interactionWidth` 给，选中框就是线本身变粗。
 */

/** 线宽：常态 2，选中 3.5（旧画布契约 §3.3）。 */
export const STROKE_WIDTH = 2;
export const STROKE_WIDTH_SELECTED = 3.5;

/** 边的命中区宽度（画布单位）。默认 20 在触屏上偏窄。 */
export const INTERACTION_WIDTH = 24;

/** 箭头长度（画布单位，跟着相机缩放）与张角。 */
export const ARROW_SIZE = 11;
const ARROW_SPREAD = 0.45;

/** 标签字号与「小于这个缩放就不画」的阈值（§2.3）。 */
export const LABEL_FONT_SIZE = 11;
export const LABEL_MIN_ZOOM = 0.5;

export interface LinkView {
  curve: LinkCurve;
  labelKey: string;
  arrowStart: boolean;
  arrowEnd: boolean;
}

/**
 * 两端的矩形与节点类型 → 画一条线需要的全部信息。
 *
 * 箭头与标签只看**类型**，不看用户从哪一头拖出来（§21）：内容 → 终端单向，
 * 终端 ↔ 终端双向，内容 ↔ 内容无箭头。分组的类型是 `"group"`，落在
 * 「内容」那一类里。
 */
export function linkView(
  source: Box,
  target: Box,
  sourceType?: string,
  targetType?: string,
): LinkView {
  const heads = edgeArrowheads(sourceType, targetType);
  return {
    curve: linkCurve(source, target),
    labelKey: edgeLabelKey(sourceType, targetType),
    arrowStart: heads.start === "arrow",
    arrowEnd: heads.end === "arrow",
  };
}

/**
 * 端点处的一个「V」形箭头，沿曲线切线画。
 *
 * 不用 SVG `marker`：一条边一个 marker id，30 条线就是 30 个 `<defs>`，
 * 而且 marker 不跟着 `currentColor` 走，选中变色时还要再复制一份。
 */
export function arrowHead(tip: Position, from: Position): string {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return "";
  const ux = dx / length;
  const uy = dy / length;
  const barb = (sign: number): Position => {
    const cos = Math.cos(ARROW_SPREAD);
    const sin = Math.sin(ARROW_SPREAD) * sign;
    return {
      x: tip.x - ARROW_SIZE * (ux * cos - uy * sin),
      y: tip.y - ARROW_SIZE * (uy * cos + ux * sin),
    };
  };
  const a = barb(1);
  const b = barb(-1);
  return `M ${a.x},${a.y} L ${tip.x},${tip.y} L ${b.x},${b.y}`;
}
