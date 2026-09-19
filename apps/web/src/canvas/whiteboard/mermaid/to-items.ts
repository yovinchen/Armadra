import type { WhiteboardColor } from "@/app/preferences/whiteboard";

import { geoVertices, type Box } from "../geometry";
import type {
  Geo,
  Item,
  ItemStyle,
  LineItem,
  ShapeItem,
  TextItem,
} from "../model";
import { WHITEBOARD_PALETTE, type ColorScheme } from "../palette";
import type { Layout, LaidOutNode } from "./layout";
import type { MermaidGraph, MermaidShape } from "./parse";

/**
 * 中间图模型 + 布局 → 白板对象（[Mermaid 导入](../../../../../../docs/design/mermaid-import.md) §3.1）。
 *
 * 纯函数：进去是数据，出来是 `Item[]`，不碰 store、不碰 DOM。落库是调用方
 * 一次 `addItems(items)` 的事，所以整张图是**一条**撤销（设计 D6）。
 *
 * 产出的对象和手画的没有任何区别——没有「Mermaid 对象」这种东西，导入完
 * 就只是一堆几何形、连线和文字。
 */

/* ------------------------------ 形状映射 ---------------------------------- */

/**
 * Mermaid 形状 → 白板的六种几何（设计 §3.1 的表）。
 *
 * 白板只有 `rectangle` / `ellipse` / `diamond` / `triangle` / `hexagon` /
 * `star`。`triangle` 与 `star` 没有 Mermaid 对应物，所以导入永远不产出这
 * 两种——不拿它们硬凑。表里没有的一律降级成矩形。
 */
const SHAPE_TO_GEO: Partial<Record<MermaidShape, Geo>> = {
  diamond: "diamond",
  hexagon: "hexagon",
  circle: "ellipse",
  doublecircle: "ellipse",
  stadium: "ellipse",
};

export function geoForShape(shape: MermaidShape): Geo {
  return SHAPE_TO_GEO[shape] ?? "rectangle";
}

/* -------------------------------- 颜色 ------------------------------------ */

/** `#f9f` / `#ffaa00` → `[r, g, b]`；认不出返回 null。 */
export function parseHex(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    const [r, g, b] = [...hex].map((c) => parseInt(c + c, 16));
    return [r!, g!, b!];
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  return null;
}

/**
 * Mermaid 的填充色 → 调色板里最近的一个**颜色名**。
 *
 * 不是直接用它的十六进制：导入的图必须看起来是这块板上的内容，而 Mermaid
 * 的主题色是为它自己的浅色底调的（设计 D7）。吸附到颜色名之后，切深浅色
 * 主题时这些节点跟着变，和手画的一样。
 */
export function nearestColor(
  fill: string,
  scheme: ColorScheme,
): WhiteboardColor | null {
  const target = parseHex(fill);
  if (!target) return null;
  let best: WhiteboardColor | null = null;
  let distance = Infinity;
  for (const [name, swatch] of Object.entries(WHITEBOARD_PALETTE)) {
    const rgb = parseHex(swatch[scheme]);
    if (!rgb) continue;
    const gap =
      (rgb[0] - target[0]) ** 2 +
      (rgb[1] - target[1]) ** 2 +
      (rgb[2] - target[2]) ** 2;
    if (gap < distance) {
      distance = gap;
      best = name as WhiteboardColor;
    }
  }
  return best;
}

/* ------------------------------ 边界裁剪 ---------------------------------- */

/** 椭圆按多少边的多边形近似。64 边在任何缩放下都看不出棱角。 */
const ELLIPSE_SEGMENTS = 64;

/** 几何形的边界多边形（绝对坐标）。椭圆单独生成，其余用 `geoVertices`。 */
export function boundaryPolygon(geo: Geo, box: Box): [number, number][] {
  if (geo === "ellipse") {
    const rx = box.w / 2;
    const ry = box.h / 2;
    const cx = box.x + rx;
    const cy = box.y + ry;
    return Array.from({ length: ELLIPSE_SEGMENTS }, (_, index) => {
      const angle = (index / ELLIPSE_SEGMENTS) * Math.PI * 2;
      return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)] as [
        number,
        number,
      ];
    });
  }
  return geoVertices(geo, box.w, box.h).map(
    ([x, y]) => [box.x + x, box.y + y] as [number, number],
  );
}

export function centreOf(box: Box): [number, number] {
  return [box.x + box.w / 2, box.y + box.h / 2];
}

/**
 * 从 `box` 的中心朝 `towards` 射出去，取与边界的交点。
 *
 * 一条统一代码路径（多边形求交，椭圆先转多边形），所以「箭头停在菱形的
 * 斜边上而不是它的外接矩形上」是免费的。射线与任何边都不相交时（退化的
 * 框）退回中心——线会短一点，但不会跑飞。
 */
export function boundaryPoint(
  geo: Geo,
  box: Box,
  towards: readonly [number, number],
): [number, number] {
  const centre = centreOf(box);
  const dx = towards[0] - centre[0];
  const dy = towards[1] - centre[1];
  if (dx === 0 && dy === 0) return centre;
  const polygon = boundaryPolygon(geo, box);
  if (polygon.length < 2) return centre;

  let best: [number, number] | null = null;
  let bestT = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index]!;
    const b = polygon[(index + 1) % polygon.length]!;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) < 1e-9) continue;
    // 射线 centre + t·d 与线段 a + u·e 的交点。
    const t = ((a[0] - centre[0]) * ey - (a[1] - centre[1]) * ex) / denominator;
    const u = ((a[0] - centre[0]) * dy - (a[1] - centre[1]) * dx) / denominator;
    if (t < 0 || u < 0 || u > 1) continue;
    if (t < bestT) {
      bestT = t;
      best = [centre[0] + dx * t, centre[1] + dy * t];
    }
  }
  return best ?? centre;
}

/* ------------------------------ 对象生成 ---------------------------------- */

export interface ToItemsOptions {
  /** 用户当前那支笔（`tool-store.getNextStyle()`）。 */
  style: Pick<ItemStyle, "color" | "size">;
  /** 取哪一套色值（吸附填充色时用）。 */
  scheme: ColorScheme;
  /** 生成对象 id；注入进来是为了单测可重放。 */
  newId: () => string;
}

const base = (id: string, box: Box, style: ItemStyle) => ({
  id,
  x: box.x,
  y: box.y,
  w: box.w,
  h: box.h,
  // z 一律 0：`store.addItems` 会按数组顺序从当前顶层往上编号，所以
  // 「子图框在最底、边标签在最上」由入列顺序表达（设计 §3.1）。
  z: 0,
  parentId: null,
  style,
});

/**
 * 一张图 → 一个 `Item[]`。
 *
 * 入列顺序即 z 序：子图框 → 连线 → 节点 → 边标签。节点压在连线上，所以
 * 连线的端点即使算得偏里一点也看不出来；边标签在最上，不会被节点盖住。
 */
export function graphToItems(
  graph: MermaidGraph,
  layout: Layout,
  options: ToItemsOptions,
): Item[] {
  const { style, scheme, newId } = options;
  const pen: ItemStyle = { color: style.color, size: style.size };

  const groups: ShapeItem[] = layout.groups.map((group) => ({
    ...base(newId(), group, { ...pen, dash: "dashed", fill: "none" }),
    kind: "shape",
    geo: "rectangle",
    label: group.label,
  }));

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const lines: LineItem[] = [];
  const edgeLabels: TextItem[] = [];

  for (const edge of graph.edges) {
    const from = layout.nodes.get(edge.from);
    const to = layout.nodes.get(edge.to);
    if (!from || !to) continue;
    const fromGeo = geoForShape(byId.get(edge.from)?.shape ?? "unknown");
    const toGeo = geoForShape(byId.get(edge.to)?.shape ?? "unknown");
    const start = boundaryPoint(fromGeo, from, centreOf(to));
    const end = boundaryPoint(toGeo, to, centreOf(from));

    // `line` 的 `points` 相对对象原点，原点取两端的左上角。
    const x = Math.min(start[0], end[0]);
    const y = Math.min(start[1], end[1]);
    lines.push({
      ...base(
        newId(),
        {
          x,
          y,
          w: Math.abs(end[0] - start[0]),
          h: Math.abs(end[1] - start[1]),
        },
        { ...pen, dash: edge.dash },
      ),
      kind: "line",
      points: [
        [start[0] - x, start[1] - y],
        [end[0] - x, end[1] - y],
      ],
      ...(edge.arrowStart ? { arrowStart: true } : {}),
      ...(edge.arrowEnd ? { arrowEnd: true } : {}),
    });

    if (!edge.label) continue;
    const box = labelBox(start, end, edge.label);
    edgeLabels.push({
      ...base(newId(), box, { ...pen, align: "middle" }),
      kind: "text",
      text: edge.label,
    });
  }

  const shapes: ShapeItem[] = [];
  for (const node of graph.nodes) {
    const placed = layout.nodes.get(node.id);
    if (!placed) continue;
    shapes.push(
      shapeFor(node.label, node.fill, node.shape, placed, pen, scheme, newId),
    );
  }

  return [...groups, ...lines, ...shapes, ...edgeLabels];
}

function shapeFor(
  label: string,
  fill: string | null,
  shape: MermaidShape,
  box: LaidOutNode,
  pen: ItemStyle,
  scheme: ColorScheme,
  newId: () => string,
): ShapeItem {
  // `style` / `classDef` 只映射填充色；描边色、字色、线宽一概丢弃（设计 §5）。
  const colour = fill ? nearestColor(fill, scheme) : null;
  return {
    ...base(newId(), box, {
      ...pen,
      ...(colour ? { color: colour, fill: "semi" as const } : {}),
    }),
    kind: "shape",
    geo: geoForShape(shape),
    label,
  };
}

/** 边标签的框：居中在线段中点上，宽度按字符数估。 */
const LABEL_CHAR_WIDTH = 8;
const LABEL_HEIGHT = 20;

function labelBox(
  start: readonly [number, number],
  end: readonly [number, number],
  label: string,
): Box {
  const w = Math.max(24, label.length * LABEL_CHAR_WIDTH);
  return {
    x: (start[0] + end[0]) / 2 - w / 2,
    y: (start[1] + end[1]) / 2 - LABEL_HEIGHT / 2,
    w,
    h: LABEL_HEIGHT,
  };
}
