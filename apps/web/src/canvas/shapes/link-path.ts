import type { Position } from "@ai-coding-canvas/shared";

import {
  bezierControls,
  edgeGeometry,
  type Box,
  type EdgeGeometry,
} from "../geometry";

/**
 * 上下文链接那条曲线（纯函数，`shapes/LinkShapeUtil.tsx` 与单测共用）。
 *
 * 曲线本身仍然是 `canvas/geometry.ts` 的那一条：两个矩形**相对的边的中点**
 * 之间的三次贝塞尔，`anchor: "horizontal"` 时只走左右两侧（免得从头部上面
 * 绕过去挡住标题）。这里只是把它包成 shape 需要的三种形态：
 *
 *  1. `d`：给 `<path>` 用的字符串；
 *  2. `points`：采样出来的折线，给 `Polyline2d` 做命中测试与选中框；
 *  3. `c1` / `c2`：给 `Path2D.bezierCurveTo` 画指示器。
 *
 * 坐标一律是**页面坐标**：link shape 的 `x/y` 钉死在 0（见 `link-shape.ts`）。
 */

/** 命中测试用的采样密度。24 段在 3 倍缩放下肉眼已经看不出折线。 */
export const CURVE_SAMPLES = 24;

export interface LinkCurve extends EdgeGeometry {
  d: string;
  c1: Position;
  c2: Position;
  /** 曲线 t=0.5 处，标签挂这儿。 */
  labelX: number;
  labelY: number;
}

export function linkCurve(source: Box, target: Box): LinkCurve {
  const geometry = edgeGeometry(source, target, "horizontal");
  const { c1, c2 } = bezierControls(geometry);
  const start = { x: geometry.sourceX, y: geometry.sourceY };
  const end = { x: geometry.targetX, y: geometry.targetY };
  return {
    ...geometry,
    c1,
    c2,
    d: `M ${start.x},${start.y} C ${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`,
    labelX: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
    labelY: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8,
  };
}

/** 三次贝塞尔在 t 处的点。 */
export function pointOnCurve(curve: LinkCurve, t: number): Position {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * curve.sourceX + b * curve.c1.x + c * curve.c2.x + d * curve.targetX,
    y: a * curve.sourceY + b * curve.c1.y + c * curve.c2.y + d * curve.targetY,
  };
}

/** 等参数采样成折线（首尾一定是两个锚点）。 */
export function sampleCurve(
  curve: LinkCurve,
  samples: number = CURVE_SAMPLES,
): Position[] {
  const steps = Math.max(2, Math.floor(samples));
  const points: Position[] = [];
  for (let i = 0; i <= steps; i += 1) {
    points.push(pointOnCurve(curve, i / steps));
  }
  return points;
}
