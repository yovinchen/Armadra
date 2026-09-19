import dagre from "@dagrejs/dagre";

import type { Box } from "../geometry";
import type { MermaidGraph, MermaidGroup } from "./parse";

/**
 * 中间图模型 → 坐标（[Mermaid 导入](../../../../../../docs/design/mermaid-import.md) §3.1）。
 *
 * 用 dagre 而不是 mermaid 自己的渲染结果：mermaid 的坐标藏在 SVG 里，取回来
 * 要量 DOM；dagre 正是 mermaid 的 flowchart 布局用的同一个库，是纯函数，
 * 单测里跑得动（设计 D4）。
 *
 * dagre 的图是**扁平**的：subgraph 不参与布局，框是事后按成员包围盒算出来
 * 的（设计 D5）。让 dagre 做 cluster 会把边路由也一并接管，而我们的连线只画
 * 两点直线，得不偿失。
 *
 * 这个文件静态 import dagre（约 200 kB），所以整个 `mermaid/` 目录只许从
 * 懒加载的对话框进入。
 */

/** 节点框的内边距与最小尺寸（页面单位）。 */
export const NODE_PADDING_X = 24;
export const NODE_PADDING_Y = 16;
export const MIN_NODE_WIDTH = 72;
export const MIN_NODE_HEIGHT = 44;

/** 子图框比成员包围盒大出来的一圈，上方多留一条给标题。 */
export const GROUP_PADDING = 28;
export const GROUP_TITLE_HEIGHT = 24;

/** 同层间距 / 层间距。 */
export const NODE_SEP = 48;
export const RANK_SEP = 72;

export interface LayoutOptions {
  /** 一个字符的估算宽度（`palette.fontSize(size) * 0.58`）。 */
  charWidth: number;
  /** 一行的高度（字号 × 行距）。 */
  lineHeight: number;
}

export interface LaidOutNode extends Box {
  id: string;
}

export interface LaidOutGroup extends Box {
  id: string;
  label: string;
}

export interface Layout {
  nodes: Map<string, LaidOutNode>;
  groups: LaidOutGroup[];
  /** 整张图的包围盒（含子图框）。 */
  bounds: Box;
}

/**
 * 标签 → 节点尺寸。
 *
 * 没有 DOM 可量（这是纯函数，而且要在单测里跑），所以按字符数估算：
 * 取最长一行的宽度，行数决定高度。CJK 字符按两个字宽算——否则中文标签
 * 会被框裁掉一半。
 */
export function measureLabel(
  label: string,
  options: LayoutOptions,
): { w: number; h: number } {
  const lines = label.split("\n");
  let widest = 0;
  for (const line of lines) {
    let units = 0;
    for (const char of line) units += isWide(char) ? 2 : 1;
    widest = Math.max(widest, units);
  }
  return {
    w: Math.max(
      MIN_NODE_WIDTH,
      widest * options.charWidth + NODE_PADDING_X * 2,
    ),
    h: Math.max(
      MIN_NODE_HEIGHT,
      lines.length * options.lineHeight + NODE_PADDING_Y * 2,
    ),
  };
}

/** CJK、假名、谚文与全角标点：这些字形占两个西文字宽。 */
function isWide(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/**
 * 跑一次 dagre。
 *
 * `rankdir` 直接用 Mermaid 声明的方向，所以 `flowchart LR` 出来就是从左到
 * 右——这是用户写那两个字母的全部意义。
 *
 * dagre 给的是**中心**坐标，白板对象要的是左上角，所以出口处减掉半宽半高。
 */
export function layoutGraph(
  graph: MermaidGraph,
  options: LayoutOptions,
): Layout {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({
    rankdir: graph.direction,
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of graph.nodes) {
    const size = measureLabel(node.label, options);
    g.setNode(node.id, { width: size.w, height: size.h });
  }
  for (const [index, edge] of graph.edges.entries()) {
    // multigraph + 显式 name：`A --> B` 写两遍时两条边都要保留。
    g.setEdge(edge.from, edge.to, {}, `e${index}`);
  }

  dagre.layout(g);

  const nodes = new Map<string, LaidOutNode>();
  for (const node of graph.nodes) {
    const placed = g.node(node.id) as
      | { x?: number; y?: number; width?: number; height?: number }
      | undefined;
    const size = measureLabel(node.label, options);
    const w = placed?.width ?? size.w;
    const h = placed?.height ?? size.h;
    // dagre 偶尔给不出坐标（孤立节点 + 极端配置）；落在原点比消失好。
    const cx = Number.isFinite(placed?.x) ? placed!.x! : 0;
    const cy = Number.isFinite(placed?.y) ? placed!.y! : 0;
    nodes.set(node.id, { id: node.id, x: cx - w / 2, y: cy - h / 2, w, h });
  }

  const groups = graph.groups
    .map((group) => groupBox(group, nodes))
    .filter((box): box is LaidOutGroup => box !== null);

  return { nodes, groups, bounds: boundsOf(nodes, groups) };
}

/** 子图框 = 成员包围盒 + 一圈留白，上方再多留一条给标题。 */
function groupBox(
  group: MermaidGroup,
  nodes: ReadonlyMap<string, LaidOutNode>,
): LaidOutGroup | null {
  const members = group.nodes
    .map((id) => nodes.get(id))
    .filter((node): node is LaidOutNode => node !== undefined);
  if (members.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of members) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.w);
    maxY = Math.max(maxY, node.y + node.h);
  }
  return {
    id: group.id,
    label: group.label,
    x: minX - GROUP_PADDING,
    y: minY - GROUP_PADDING - GROUP_TITLE_HEIGHT,
    w: maxX - minX + GROUP_PADDING * 2,
    h: maxY - minY + GROUP_PADDING * 2 + GROUP_TITLE_HEIGHT,
  };
}

function boundsOf(
  nodes: ReadonlyMap<string, LaidOutNode>,
  groups: readonly LaidOutGroup[],
): Box {
  const boxes: Box[] = [...nodes.values(), ...groups];
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 把整张图平移到以 `centre` 为中心。 */
export function centreLayout(
  layout: Layout,
  centre: { x: number; y: number },
): Layout {
  const dx = centre.x - (layout.bounds.x + layout.bounds.w / 2);
  const dy = centre.y - (layout.bounds.y + layout.bounds.h / 2);
  const nodes = new Map<string, LaidOutNode>();
  for (const [id, node] of layout.nodes) {
    nodes.set(id, { ...node, x: node.x + dx, y: node.y + dy });
  }
  return {
    nodes,
    groups: layout.groups.map((g) => ({ ...g, x: g.x + dx, y: g.y + dy })),
    bounds: {
      ...layout.bounds,
      x: layout.bounds.x + dx,
      y: layout.bounds.y + dy,
    },
  };
}
