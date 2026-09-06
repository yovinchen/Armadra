import { getStroke } from "perfect-freehand";

import { MAX_INK_POINTS, type InkPoint } from "./model";

/**
 * 墨迹几何（React Flow 计划 §2.4 / F22，归属 whiteboard）。
 *
 * 一条墨迹存的是采样点 `[x, y, 压力]`（相对对象原点），画出来的是
 * `perfect-freehand` 生成的**轮廓多边形**——所以线宽随压力变化，而且
 * 缩放对象时只要缩点集，轮廓自然跟着走。
 *
 * 全是纯函数：没有 DOM，没有 store。`raster.ts` 与 SVG 节点用同一份轮廓，
 * 导出的 PNG 与屏幕上看到的是同一条线。
 */

/** 简化容差（画布单位）。§3.1 要求落成时压到 0.35px 以内。 */
export const SIMPLIFY_TOLERANCE = 0.35;

export interface StrokeOptions {
  /** 基础线宽（`palette.strokeWidth`）。 */
  size: number;
  /** 收笔的一条完整线；进行中的笔迹传 false，末端不封口。 */
  last?: boolean;
  /** 高亮笔：粗、不随压力变细、两端平口。 */
  highlight?: boolean;
}

/* -------------------------------- 简化 ------------------------------------ */

function perpendicularDistance(
  point: InkPoint,
  from: InkPoint,
  to: InkPoint,
): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point[0] - from[0], point[1] - from[1]);
  }
  const t =
    ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / lengthSquared;
  const clamped = Math.max(0, Math.min(1, t));
  return Math.hypot(
    point[0] - (from[0] + clamped * dx),
    point[1] - (from[1] + clamped * dy),
  );
}

/**
 * Ramer–Douglas–Peucker。递归改成显式栈：一条 8,000 点的长线在递归版里
 * 能把调用栈打穿，而这正是我们要压缩的那种线。
 */
function rdp(points: readonly InkPoint[], tolerance: number): InkPoint[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let farthest = -1;
    let distance = tolerance;
    for (let index = start + 1; index < end; index += 1) {
      const candidate = perpendicularDistance(
        points[index]!,
        points[start]!,
        points[end]!,
      );
      if (candidate > distance) {
        distance = candidate;
        farthest = index;
      }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    stack.push([start, farthest], [farthest, end]);
  }
  const result: InkPoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    if (keep[index]) result.push(points[index]!);
  }
  return result;
}

/**
 * 落成一条墨迹时压缩点集：先按容差简化，还超过上限就等距抽稀。
 *
 * 上限是硬的（`MAX_INK_POINTS`，zod 会拒绝超出的文档），所以抽稀这一步
 * 不能只是「尽量」——它必须保证结果一定在上限内。
 */
export function simplifyPoints(
  points: readonly InkPoint[],
  tolerance: number = SIMPLIFY_TOLERANCE,
  limit: number = MAX_INK_POINTS,
): InkPoint[] {
  const simplified = rdp(points, tolerance);
  if (simplified.length <= limit) return simplified;
  const step = simplified.length / limit;
  const thinned: InkPoint[] = [];
  for (let index = 0; index < limit - 1; index += 1) {
    thinned.push(simplified[Math.floor(index * step)]!);
  }
  thinned.push(simplified[simplified.length - 1]!);
  return thinned;
}

/* -------------------------------- 包围盒 ---------------------------------- */

export interface InkBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 点集的包围盒，四周按线宽的一半外扩（轮廓比中线宽）。
 *
 * 返回的是**页面坐标**：调用方拿它当对象的 `x/y/w/h`，再把点集平移到
 * 相对原点。空点集给一个 0×0 的盒子，调用方自己决定要不要落成。
 */
export function inkBounds(points: readonly InkPoint[], width = 0): InkBox {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const pad = width / 2;
  return {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + width,
    h: maxY - minY + width,
  };
}

/** 点集整体平移（落成时把页面坐标换成相对原点的坐标）。 */
export function translatePoints(
  points: readonly InkPoint[],
  dx: number,
  dy: number,
): InkPoint[] {
  return points.map(([x, y, pressure]) => [x + dx, y + dy, pressure]);
}

/**
 * 缩放点集（resize 一条墨迹）。压力不变——那是笔的属性，不是几何的属性。
 * 非有限的比例（除以 0 的高度）按 1 处理，宁可不缩也不要 NaN 进文档。
 */
export function scaleInk(
  points: readonly InkPoint[],
  scaleX: number,
  scaleY: number,
): InkPoint[] {
  const sx = Number.isFinite(scaleX) && scaleX !== 0 ? scaleX : 1;
  const sy = Number.isFinite(scaleY) && scaleY !== 0 ? scaleY : 1;
  if (sx === 1 && sy === 1) return [...points];
  return points.map(([x, y, pressure]) => [x * sx, y * sy, pressure]);
}

/* -------------------------------- 轮廓 ------------------------------------ */

/**
 * 点集 → 轮廓多边形。
 *
 * 高亮笔关掉 `thinning`（记号笔的宽度不随手劲变）并且不封口，普通笔保留
 * 压力效果。`simulatePressure` 只在所有点的压力都是默认值时才有意义，
 * 这里统一交给 perfect-freehand 自己判断（我们始终写入真实压力）。
 */
export function strokeOutline(
  points: readonly InkPoint[],
  options: StrokeOptions,
): number[][] {
  if (points.length === 0) return [];
  const highlight = options.highlight === true;
  return getStroke(
    points.map(([x, y, pressure]) => [x, y, pressure]),
    {
      size: options.size,
      thinning: highlight ? 0 : 0.55,
      smoothing: 0.55,
      streamline: 0.4,
      simulatePressure: false,
      last: options.last ?? true,
      start: { cap: !highlight },
      end: { cap: !highlight },
    },
  );
}

/**
 * 轮廓 → SVG `d`。二次贝塞尔穿过相邻点的中点，末尾 `Z` 封口。
 *
 * 一个点的轮廓（点一下就抬笔）也要闭合：否则 `fill` 什么都画不出来，
 * 用户点一下画布看到的是空白。
 */
export function outlineToPath(outline: readonly number[][]): string {
  if (outline.length === 0) return "";
  const [first] = outline;
  if (!first) return "";
  const parts: string[] = [`M ${round(first[0]!)} ${round(first[1]!)}`];
  for (let index = 0; index < outline.length; index += 1) {
    const current = outline[index]!;
    const next = outline[(index + 1) % outline.length]!;
    parts.push(
      `Q ${round(current[0]!)} ${round(current[1]!)} ${round(
        (current[0]! + next[0]!) / 2,
      )} ${round((current[1]! + next[1]!) / 2)}`,
    );
  }
  parts.push("Z");
  return parts.join(" ");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 一条墨迹的完整绘制路径：点集 + 线宽 → SVG `d`。 */
export function inkPath(
  points: readonly InkPoint[],
  options: StrokeOptions,
): string {
  return outlineToPath(strokeOutline(points, options));
}
