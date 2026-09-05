import type {
  CanvasEdge,
  CanvasNode,
  Position,
} from "@armadra/shared";
import { COLLAPSED_HEIGHT, defaultNodeSize } from "../store/defaults";

/**
 * 整理布局（docs/v3-agent-terminal-plan.md §23「整理布局」）。
 *
 * 三步，全是纯函数：
 *   1. 按**连通分量**分组（连线当无向边看），分量内按拓扑深度排成
 *      「从左到右深度递增、列内纵向堆叠」；
 *   2. 每个分量整体当一个盒子，按阅读顺序依次塞进当前行，行宽超过
 *      `sqrt(总面积 × 视口宽高比) × 1.15` 就换行（行高 = 行内最高的分量）；
 *   3. 组框（`group`）本身参与排布，组员的坐标是**相对组框**的，
 *      所以只要不碰它们就会跟着组一起平移。
 *
 * 上一版是「整张画布一条拓扑长链」，节点一多就横向拉出几万像素、
 * 竖直方向全是空白；按视口宽高比裹成矩形之后才可能一屏放得下。
 */

export interface TidyBox {
  id: string;
  width: number;
  height: number;
}

export interface TidyLink {
  source: string;
  target: string;
}

export interface TidyOptions {
  /** 目标区域宽高比，默认按视口给；拿不到视口时退回 16:9。 */
  aspect?: number;
}

/** 版式常量（§23）。 */
export const ROW_GAP = 48;
export const COLUMN_GAP = 60;
export const MAX_DEPTH = 50;
export const DEFAULT_ASPECT = 16 / 9;
/** 行宽上限的宽容系数：宁可略宽，也不要为了 1px 把一整列挤到下一行。 */
export const ROW_WIDTH_SLACK = 1.15;

/** 一个连通分量排完之后的相对布局。 */
interface TidyCluster {
  width: number;
  height: number;
  /** 成员相对分量左上角的偏移。 */
  offsets: Map<string, Position>;
}

/**
 * 分量内部：拓扑分列。只有出边没有入边的节点在最左列，每层一列，
 * 列内纵向堆叠；纯环（谁都有入边）整列落在第 0 列。
 */
function layoutCluster(members: TidyBox[], links: TidyLink[]): TidyCluster {
  const ids = new Set(members.map((box) => box.id));
  const edges = links.filter(
    (link) => ids.has(link.source) && ids.has(link.target),
  );

  const incoming = new Map<string, number>(members.map((box) => [box.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    const list = outgoing.get(edge.source);
    if (list) list.push(edge.target);
    else outgoing.set(edge.source, [edge.target]);
  }

  // 从「只有出边」的根开始 DFS。`>= level` 的守卫让环不会无限循环，
  // MAX_DEPTH 兜住病态长链。
  const depth = new Map<string, number>();
  const visit = (id: string, level: number) => {
    if (level > MAX_DEPTH) return;
    const seen = depth.get(id);
    if (seen !== undefined && seen >= level) return;
    depth.set(id, level);
    for (const next of outgoing.get(id) ?? []) visit(next, level + 1);
  };
  for (const box of members) {
    if (incoming.get(box.id) === 0 && outgoing.has(box.id)) visit(box.id, 0);
  }

  const deepest = Math.max(-1, ...depth.values());
  const rest = deepest + 1;
  const columns = new Map<number, TidyBox[]>();
  for (const box of members) {
    const level = depth.get(box.id) ?? rest;
    const column = columns.get(level);
    if (column) column.push(box);
    else columns.set(level, [box]);
  }

  const offsets = new Map<string, Position>();
  let x = 0;
  let height = 0;
  for (const level of [...columns.keys()].sort((a, b) => a - b)) {
    let y = 0;
    let width = 0;
    for (const box of columns.get(level) ?? []) {
      offsets.set(box.id, { x, y });
      y += box.height + ROW_GAP;
      width = Math.max(width, box.width);
    }
    height = Math.max(height, y - ROW_GAP);
    x += width + COLUMN_GAP;
  }
  return { width: Math.max(0, x - COLUMN_GAP), height, offsets };
}

/** 无向连通分量；顺序按 `boxes` 的输入顺序（= 稳定的阅读顺序）。 */
function clustersOf(boxes: TidyBox[], links: TidyLink[]): TidyBox[][] {
  const parent = new Map<string, string>(boxes.map((box) => [box.id, box.id]));
  const find = (start: string): string => {
    let root = start;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cursor = start;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  for (const link of links) {
    const a = find(link.source);
    const b = find(link.target);
    if (a !== b) parent.set(b, a);
  }

  const grouped = new Map<string, TidyBox[]>();
  for (const box of boxes) {
    const root = find(box.id);
    const list = grouped.get(root);
    if (list) list.push(box);
    else grouped.set(root, [box]);
  }
  return [...grouped.values()];
}

/**
 * 按连通分量排布，再把分量按阅读顺序裹进一个接近视口宽高比的矩形。
 */
export function tidy(
  boxes: TidyBox[],
  links: TidyLink[],
  options: TidyOptions = {},
): Record<string, Position> {
  if (boxes.length === 0) return {};
  const known = new Set(boxes.map((box) => box.id));
  const edges = links.filter(
    (link) =>
      link.source !== link.target &&
      known.has(link.source) &&
      known.has(link.target),
  );

  const clusters = clustersOf(boxes, edges).map((members) =>
    layoutCluster(members, edges),
  );

  const totalArea = clusters.reduce(
    (sum, cluster) => sum + cluster.width * cluster.height,
    0,
  );
  const aspect =
    options.aspect && Number.isFinite(options.aspect) && options.aspect > 0
      ? options.aspect
      : DEFAULT_ASPECT;
  const rowLimit = Math.sqrt(totalArea * aspect) * ROW_WIDTH_SLACK;

  const positions: Record<string, Position> = {};
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const cluster of clusters) {
    // `x > 0` 的守卫：比一整行还宽的分量自己独占一行，不会死循环换行。
    if (x > 0 && x + cluster.width > rowLimit) {
      x = 0;
      y += rowHeight + ROW_GAP;
      rowHeight = 0;
    }
    for (const [id, offset] of cluster.offsets) {
      positions[id] = { x: x + offset.x, y: y + offset.y };
    }
    x += cluster.width + COLUMN_GAP;
    rowHeight = Math.max(rowHeight, cluster.height);
  }
  return positions;
}

/** 文档层的入口：过滤掉组员，按真实尺寸排布顶层节点。 */
export function tidyPositions(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  options: TidyOptions = {},
): Record<string, Position> {
  const top = nodes.filter((node) => !node.parentId);
  const boxes = top.map((node) => {
    const size = node.size ?? defaultNodeSize(node.type);
    return {
      id: node.id,
      width: size.width,
      // 折叠之后只剩头部，按 40px 参与排布，否则行里全是空气。
      height: node.collapsed ? COLLAPSED_HEIGHT : size.height,
    };
  });
  return tidy(
    boxes,
    edges.map((edge) => ({ source: edge.source, target: edge.target })),
    options,
  );
}
