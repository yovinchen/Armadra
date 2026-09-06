import { strokeWidth } from "./palette";
import type { Geo, Item, LinePoint } from "./model";

/**
 * 白板对象的几何（React Flow 计划 §2.4，归属 whiteboard）。
 *
 * 六种几何形的路径、直线的包围盒、以及「这个点打在哪个对象上」。
 * 全是纯函数，SVG 节点与 `raster.ts` 用同一份路径，导出的 PNG 与屏幕
 * 上看到的形状一模一样。
 *
 * 画布的节点几何在 `canvas/geometry.ts`，那是另一件事（节点矩形与方向
 * 导航），两者没有共用的东西。
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ------------------------------- 几何形路径 -------------------------------- */

/**
 * 一种几何形在 `w × h` 的框里的顶点（比例坐标，0–1）。
 *
 * 椭圆不在这张表里：它没有顶点，`geoPath` 单独用两段圆弧画。
 */
const POLYGONS: Record<Exclude<Geo, "ellipse">, [number, number][]> = {
  rectangle: [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ],
  diamond: [
    [0.5, 0],
    [1, 0.5],
    [0.5, 1],
    [0, 0.5],
  ],
  triangle: [
    [0.5, 0],
    [1, 1],
    [0, 1],
  ],
  hexagon: [
    [0.25, 0],
    [0.75, 0],
    [1, 0.5],
    [0.75, 1],
    [0.25, 1],
    [0, 0.5],
  ],
  star: starPoints(),
};

/** 五角星：外接 5 点与内接 5 点交替，起点在正上方。 */
function starPoints(): [number, number][] {
  const points: [number, number][] = [];
  for (let index = 0; index < 10; index += 1) {
    const radius = index % 2 === 0 ? 0.5 : 0.2;
    const angle = (Math.PI / 5) * index - Math.PI / 2;
    points.push([
      0.5 + radius * Math.cos(angle),
      0.5 + radius * Math.sin(angle),
    ]);
  }
  return points;
}

/** 几何形的顶点（画布单位）；椭圆返回空数组。 */
export function geoVertices(
  geo: Geo,
  w: number,
  h: number,
): [number, number][] {
  if (geo === "ellipse") return [];
  return (POLYGONS[geo] ?? POLYGONS.rectangle).map(
    ([x, y]) => [x * w, y * h] as [number, number],
  );
}

/**
 * 几何形的 SVG `d`（原点在对象左上角）。
 *
 * 尺寸为 0 时返回空串：`<path d="">` 什么都不画，比画一个退化的形状好
 * ——刚按下还没拖开的那一帧就是这个状态。
 */
export function geoPath(geo: Geo, w: number, h: number): string {
  if (!(w > 0) || !(h > 0)) return "";
  if (geo === "ellipse") {
    const rx = w / 2;
    const ry = h / 2;
    return [
      `M 0 ${ry}`,
      `A ${rx} ${ry} 0 1 0 ${w} ${ry}`,
      `A ${rx} ${ry} 0 1 0 0 ${ry}`,
      "Z",
    ].join(" ");
  }
  const vertices = geoVertices(geo, w, h);
  const [first, ...rest] = vertices;
  if (!first) return "";
  return [
    `M ${first[0]} ${first[1]}`,
    ...rest.map(([x, y]) => `L ${x} ${y}`),
    "Z",
  ].join(" ");
}

/* --------------------------------- 直线 ----------------------------------- */

/** 折线的包围盒（相对坐标进，相对坐标出）。 */
export function lineBounds(points: readonly LinePoint[]): Box {
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
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 箭头三角形的顶点（在末端点上，朝着上一个点的反方向）。 */
export function arrowHead(
  tip: LinePoint,
  from: LinePoint,
  size: number,
): string {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const spread = Math.PI / 7;
  const left: LinePoint = [
    tip[0] - size * Math.cos(angle - spread),
    tip[1] - size * Math.sin(angle - spread),
  ];
  const right: LinePoint = [
    tip[0] - size * Math.cos(angle + spread),
    tip[1] - size * Math.sin(angle + spread),
  ];
  return `M ${left[0]} ${left[1]} L ${tip[0]} ${tip[1]} L ${right[0]} ${right[1]}`;
}

/* --------------------------------- 命中 ----------------------------------- */

function insidePolygon(
  vertices: readonly [number, number][],
  x: number,
  y: number,
): boolean {
  let inside = false;
  for (
    let index = 0, previous = vertices.length - 1;
    index < vertices.length;
    previous = index++
  ) {
    const [xi, yi] = vertices[index]!;
    const [xj, yj] = vertices[previous]!;
    const crosses = yi > y !== yj > y;
    if (crosses && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function nearSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x: number,
  y: number,
  tolerance: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared),
        );
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= tolerance;
}

/**
 * 这个页面坐标打在这个对象上吗？
 *
 * 有面积的对象（文字、图片、有填充的几何形）按包围盒；线状对象（墨迹、
 * 直线、无填充的几何形）按「离线多近」——空心矩形的中间是空的，点在
 * 那里不该选中它，白板用户对这条规则的预期非常一致。
 *
 * `parentId` 不在这里换算：调用方把点换算到与对象同一个坐标系再进来。
 */
export function hitTestItem(item: Item, x: number, y: number): boolean {
  const localX = x - item.x;
  const localY = y - item.y;
  const tolerance = Math.max(strokeWidth(item.style.size) / 2, 4);
  if (
    localX < -tolerance ||
    localY < -tolerance ||
    localX > item.w + tolerance ||
    localY > item.h + tolerance
  ) {
    return false;
  }
  if (item.kind === "text" || item.kind === "image") return true;
  if (item.kind === "shape") {
    const vertices =
      item.geo === "ellipse"
        ? ellipseVertices(item.w, item.h)
        : geoVertices(item.geo, item.w, item.h);
    if (nearOutline(vertices, localX, localY, tolerance, true)) return true;
    // 空心形状的中间是空的：点在那里不该选中它（白板的通用预期）。
    if (!item.style.fill || item.style.fill === "none") return false;
    return insidePolygon(vertices, localX, localY);
  }
  if (item.kind === "line") {
    return nearOutline(
      item.points.map(([px, py]) => [px, py] as [number, number]),
      localX,
      localY,
      tolerance,
      false,
    );
  }
  return nearOutline(
    item.points.map(([px, py]) => [px, py] as [number, number]),
    localX,
    localY,
    tolerance,
    false,
  );
}

function ellipseVertices(w: number, h: number): [number, number][] {
  const points: [number, number][] = [];
  for (let index = 0; index < 32; index += 1) {
    const angle = (Math.PI * 2 * index) / 32;
    points.push([
      w / 2 + (w / 2) * Math.cos(angle),
      h / 2 + (h / 2) * Math.sin(angle),
    ]);
  }
  return points;
}

function nearOutline(
  vertices: readonly [number, number][],
  x: number,
  y: number,
  tolerance: number,
  closed: boolean,
): boolean {
  if (vertices.length === 0) return false;
  if (vertices.length === 1) {
    return Math.hypot(x - vertices[0]![0], y - vertices[0]![1]) <= tolerance;
  }
  const last = closed ? vertices.length : vertices.length - 1;
  for (let index = 0; index < last; index += 1) {
    const [ax, ay] = vertices[index]!;
    const [bx, by] = vertices[(index + 1) % vertices.length]!;
    if (nearSegment(ax, ay, bx, by, x, y, tolerance)) return true;
  }
  return false;
}

/** 一组对象的整体包围盒（栅格化与剪贴板落点用）。 */
export function itemsBounds(items: readonly Item[]): Box | null {
  if (items.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of items) {
    if (item.x < minX) minX = item.x;
    if (item.y < minY) minY = item.y;
    if (item.x + item.w > maxX) maxX = item.x + item.w;
    if (item.y + item.h > maxY) maxY = item.y + item.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
