import type { CanvasEdge, CanvasNode } from "@ai-coding-canvas/shared";
import {
  type IndexKey,
  type TLDefaultColorStyle,
  type TLFrameShape,
  type TLPageId,
  type TLParentId,
  type TLShapeId,
} from "tldraw";

import { defaultNodeSize } from "../../store/defaults";
import type { AiccNodeType, AiccProps, AiccShape } from "../shapes/aicc-shape";
import { toNodeId, toShapeId } from "../shapes/aicc-shape";
import type { LinkBinding, LinkShape } from "../shapes/link-shape";
import { toLinkBindingId, toLinkShapeId } from "../shapes/link-shape";

/**
 * 文档 → tldraw 记录（tldraw 计划 §9.2，归属 canvas）。全是纯函数，
 * 替代 `packages/shared/src/canvas-adapter.ts`。
 *
 * 三条约定，反向的 `derive.ts` 必须逐条对上：
 *
 *  1. id 不查表：节点 `<uuid>` ↔ shape `shape:<uuid>`，边同理。
 *  2. 分组是 tldraw 原生 `frame`；`frame` 的 props 只有 `w/h/name/color`，
 *     装不下标签、批注、时间戳，所以这些放进 `meta.aicc`。
 *  3. 坐标与文档完全一致：组员的 `x/y` 相对父 frame，顶层节点相对页面。
 */

/** tldraw 的默认页 id。真正落到编辑器里时用 `editor.getCurrentPageId()`。 */
export const DEFAULT_PAGE_ID = "page:page" as TLPageId;

export const shapeId = toShapeId;
export const nodeId = toNodeId;

export interface LinkProjection {
  shape: LinkShape;
  bindings: LinkBinding[];
}

/* ------------------------------- 颜色映射 ---------------------------------- */

/**
 * 节点色（十六进制）→ tldraw 颜色名。
 *
 * frame 的 `color` 只认颜色名，所以映射是有损的；原始十六进制同时写进
 * `meta.aicc.color`，反向派生优先读它，用户手改 frame 颜色时才退回名字。
 */
const COLOR_NAMES: Record<string, TLDefaultColorStyle> = {
  "#0a84ff": "blue",
  "#32d74b": "green",
  "#ffd60a": "yellow",
  "#ff453a": "red",
  "#bf5af2": "violet",
  "#6ac4dc": "light-blue",
  "#ff9f0a": "orange",
  "#8e8e93": "grey",
};

/** 颜色名 → 十六进制，只在 frame 的 `meta` 丢失时兜底。 */
const COLOR_HEXES: Record<string, string> = Object.fromEntries(
  Object.entries(COLOR_NAMES).map(([hex, name]) => [name, hex]),
);

export function toTldrawColor(hex: string): TLDefaultColorStyle {
  return COLOR_NAMES[hex.toLowerCase()] ?? "grey";
}

export function fromTldrawColor(name: string, fallback: string): string {
  return COLOR_HEXES[name] ?? fallback;
}

/* ------------------------------- 节点投影 ---------------------------------- */

/** 组员坐标相对父级，顶层坐标相对页面——两边的约定本来就一样。 */
function parentOf(node: CanvasNode, pageId: TLParentId): TLParentId {
  return node.parentId ? toShapeId(node.parentId) : pageId;
}

/** 分组 → `frame`，其余 → `aicc`。 */
export function nodeToShape(
  node: CanvasNode,
  pageId: TLParentId = DEFAULT_PAGE_ID,
  index: IndexKey = "a1" as IndexKey,
): AiccShape | TLFrameShape {
  const size = node.size ?? defaultNodeSize(node.type);
  const base = {
    id: toShapeId(node.id),
    typeName: "shape" as const,
    x: node.position.x,
    y: node.position.y,
    rotation: 0,
    index,
    parentId: parentOf(node, pageId),
    isLocked: false,
    opacity: 1,
  };

  if (node.type === "group") {
    return {
      ...base,
      type: "frame",
      props: {
        w: size.width,
        h: size.height,
        name: node.title,
        color: toTldrawColor(node.color),
      },
      meta: {
        aicc: {
          color: node.color,
          labels: [...(node.labels ?? [])],
          note: node.note ?? "",
          collapsed: node.collapsed ?? false,
          createdAt: node.createdAt,
        },
      },
    } as TLFrameShape;
  }

  const props: AiccProps = {
    w: size.width,
    h: size.height,
    nodeType: node.type as AiccNodeType,
    title: node.title,
    color: node.color,
    collapsed: node.collapsed ?? false,
    expandedHeight: node.expandedHeight ?? 0,
    labels: [...(node.labels ?? [])],
    note: node.note ?? "",
    data: node.data,
    createdAt: node.createdAt,
  };

  return {
    ...base,
    type: "aicc",
    props,
    meta: {},
  } as AiccShape;
}

/* -------------------------------- 边投影 ----------------------------------- */

export type EdgeArrowheads = { start: "arrow" | "none"; end: "arrow" | "none" };

/**
 * 箭头方向（原 `FloatingEdge.edgeAppearance`，§21）。
 *
 * 箭头表达「谁读谁」，与用户从哪一头拖出来无关：内容 → 终端单向指向终端；
 * 终端 ↔ 终端双向；内容 ↔ 内容无箭头，只表示归到一起。
 */
export function edgeArrowheads(
  sourceType?: string,
  targetType?: string,
): EdgeArrowheads {
  const sourceIsTerminal = sourceType === "terminal";
  const targetIsTerminal = targetType === "terminal";
  if (sourceIsTerminal && targetIsTerminal) {
    return { start: "arrow", end: "arrow" };
  }
  if (targetIsTerminal) return { start: "none", end: "arrow" };
  if (sourceIsTerminal) return { start: "arrow", end: "none" };
  return { start: "none", end: "none" };
}

/** 节点类型 → 连线标签的 i18n 键（§21 的那一行表）。 */
const EDGE_LABEL_KEYS: Record<string, string> = {
  sticky: "edge.sticky",
  editor: "edge.file",
  files: "edge.dir",
  browser: "edge.web",
  diff: "edge.diff",
};

/**
 * 连线中点的标签（i18n 键，不是文案）。
 *
 * 标签说的是「Agent 读到的是什么」：终端 ↔ 终端是互相读转录，写「上下文」；
 * 一端是内容节点时按那一端的类型写（便签 / 文件 / 目录 / 网页 / 差异）。
 */
export function edgeLabelKey(sourceType?: string, targetType?: string): string {
  const content =
    sourceType && sourceType !== "terminal"
      ? sourceType
      : targetType && targetType !== "terminal"
        ? targetType
        : null;
  if (!content) return "edge.context";
  return EDGE_LABEL_KEYS[content] ?? "edge.context";
}

/**
 * 一条上下文链接 → 一个 `link` shape + 两条 `link` binding。
 *
 * shape 的 `x/y` 固定 0：曲线画在页面坐标里，节点一动 tldraw 自己重算
 * （见 `shapes/link-shape.ts` 的模块注释）。所以这里没有任何起止点要算。
 *
 * `LinkArrow` 把用户拉出来的 arrow 换成 link 时走的也是这个函数，
 * 两种来源的记录必须一模一样，否则往返就不恒等了。
 */
export function linkRecords(
  edge: Pick<
    CanvasEdge,
    "id" | "source" | "target" | "kind" | "createdAt" | "updatedAt"
  >,
  pageId: TLParentId = DEFAULT_PAGE_ID,
  index: IndexKey = "a1" as IndexKey,
): LinkProjection {
  const shape = {
    id: toLinkShapeId(edge.id),
    typeName: "shape" as const,
    type: "link" as const,
    x: 0,
    y: 0,
    rotation: 0,
    index,
    parentId: pageId,
    isLocked: false,
    opacity: 1,
    props: {
      from: toShapeId(edge.source),
      to: toShapeId(edge.target),
      edgeId: edge.id,
      kind: edge.kind,
      createdAt: edge.createdAt,
      updatedAt: edge.updatedAt,
    },
    meta: {},
  } as unknown as LinkShape;

  const binding = (
    terminal: "start" | "end",
    toShape: TLShapeId,
  ): LinkBinding =>
    ({
      id: toLinkBindingId(edge.id, terminal),
      typeName: "binding" as const,
      type: "link" as const,
      fromId: shape.id,
      toId: toShape,
      props: { terminal },
      meta: {},
    }) as unknown as LinkBinding;

  return {
    shape,
    bindings: [
      binding("start", toShapeId(edge.source)),
      binding("end", toShapeId(edge.target)),
    ],
  };
}

/** 两端节点缺一个时返回 null（那条边投影不出来）。 */
export function edgeToLink(
  edge: CanvasEdge,
  nodes: readonly CanvasNode[],
  pageId: TLParentId = DEFAULT_PAGE_ID,
  index: IndexKey = "a1" as IndexKey,
): LinkProjection | null {
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  if (!source || !target) return null;
  return linkRecords(edge, pageId, index);
}

/** 一个节点 id 对应的 shape id 是否在 tldraw 里。 */
export function hasShape(
  ids: ReadonlySet<TLShapeId>,
  node: CanvasNode,
): boolean {
  return ids.has(toShapeId(node.id));
}
