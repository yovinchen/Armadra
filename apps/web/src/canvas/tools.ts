import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Circle,
  Diamond,
  Frame,
  Hand,
  Hexagon,
  Highlighter,
  Image as ImageIcon,
  Minus,
  MousePointer2,
  Pencil,
  Square,
  Star,
  Triangle,
  Type,
} from "lucide-react";
import type { TLGeoShapeGeoStyle } from "@tldraw/tlschema";

import type { CanvasCommandId } from "./commands";

/**
 * 白板工具表（tldraw 计划 §5「Dock 工具组」）。
 *
 * 一份规格驱动三处：Dock 的工具组、`keybindings.ts` 的 `canvas.tool.*`
 * 命令、`TldrawWorkspace` 注册的命令实现。id 就是 tldraw 自己的工具 id
 * （`editor.setCurrentTool(id)` / `editor.getCurrentToolId()`），所以这里
 * **不做映射表**，改动只有一处。
 *
 * `image` 不是 tldraw 的工具（5.4 没有 image tool），它在 Dock 上是一个
 * 触发文件选择的按钮，落到 `putExternalContent({ type: "files" })`——
 * 也就是 content agent 的外部内容处理器。所以它单列在 `IMAGE_TOOL`。
 */

/** tldraw 里真的存在、并且我们开放给用户的工具 id。 */
export const CANVAS_TOOL_IDS = [
  "select",
  "hand",
  "draw",
  "highlight",
  "geo",
  "line",
  "arrow",
  "text",
  "frame",
] as const;

export type CanvasToolId = (typeof CANVAS_TOOL_IDS)[number];

export interface CanvasToolSpec {
  id: CanvasToolId;
  /** 触发它的画布命令；与 `keybindings.ts` 的 id 一一对应。 */
  command: CanvasCommandId;
  /** i18n 键（`i18n/canvas.ts`），不是文案。 */
  labelKey: string;
  icon: LucideIcon;
}

export const CANVAS_TOOLS: readonly CanvasToolSpec[] = [
  {
    id: "select",
    command: "canvas.tool.select",
    labelKey: "tool.select",
    icon: MousePointer2,
  },
  {
    id: "hand",
    command: "canvas.tool.hand",
    labelKey: "tool.hand",
    icon: Hand,
  },
  {
    id: "draw",
    command: "canvas.tool.draw",
    labelKey: "tool.draw",
    icon: Pencil,
  },
  {
    id: "highlight",
    command: "canvas.tool.highlight",
    labelKey: "tool.highlight",
    icon: Highlighter,
  },
  {
    id: "geo",
    command: "canvas.tool.geo",
    labelKey: "tool.geo",
    icon: Square,
  },
  {
    id: "line",
    command: "canvas.tool.line",
    labelKey: "tool.line",
    icon: Minus,
  },
  {
    id: "arrow",
    command: "canvas.tool.arrow",
    labelKey: "tool.arrow",
    icon: ArrowRight,
  },
  {
    id: "text",
    command: "canvas.tool.text",
    labelKey: "tool.text",
    icon: Type,
  },
  {
    id: "frame",
    command: "canvas.tool.frame",
    labelKey: "tool.frame",
    icon: Frame,
  },
];

/**
 * 图片：不是 tldraw 工具（5.4 没有 image tool），所以它没有命令、没有键位。
 * Dock 上那个按钮自己开文件选择，把文件交给 `putExternalContent`。
 */
export const IMAGE_TOOL: { labelKey: string; icon: LucideIcon } = {
  labelKey: "tool.image",
  icon: ImageIcon,
};

/* ------------------------------ 形状下拉 --------------------------------- */

export interface GeoOption {
  geo: TLGeoShapeGeoStyle;
  labelKey: string;
  icon: LucideIcon;
}

/**
 * 形状按钮的下拉。`geo` 是 tldraw 的样式属性（`GeoShapeGeoStyle`），
 * 选一项 = 把它写进「下一个 shape 的样式」再切到 `geo` 工具，
 * 所以样式面板里的形状选择器与这里永远是同一个值。
 */
export const GEO_OPTIONS: readonly GeoOption[] = [
  { geo: "rectangle", labelKey: "geo.rectangle", icon: Square },
  { geo: "ellipse", labelKey: "geo.ellipse", icon: Circle },
  { geo: "diamond", labelKey: "geo.diamond", icon: Diamond },
  { geo: "triangle", labelKey: "geo.triangle", icon: Triangle },
  { geo: "hexagon", labelKey: "geo.hexagon", icon: Hexagon },
  { geo: "star", labelKey: "geo.star", icon: Star },
];

/** 当前 geo 样式对应的图标；未知值退回矩形。 */
export function geoIcon(geo: string): LucideIcon {
  return GEO_OPTIONS.find((option) => option.geo === geo)?.icon ?? Square;
}

/* -------------------------------- 锁定 ----------------------------------- */

/**
 * 锁定视图时哪些工具要置灰。
 *
 * 锁定锁的是相机，但「能画」而「不能平移」是自相矛盾的状态，所以除了
 * 选择之外全部禁用（§5 的锁定项 + Phase 3 第 6 条）。
 */
export function isToolDisabledWhenLocked(id: string): boolean {
  return id !== "select";
}

/* ------------------------------ 样式面板 --------------------------------- */

/** 我们自己的节点 shape 类型；它没有任何 tldraw 样式。 */
export const NODE_SHAPE_TYPE = "aicc";

/** 是不是「白板原生」shape（有 tldraw 样式、归样式面板管）。 */
export function isWhiteboardShapeType(type: string): boolean {
  return type !== NODE_SHAPE_TYPE;
}

/**
 * 样式面板显隐（§12 第 2 条：复用 tldraw 的面板，只决定什么时候出现）。
 *
 * 两种情况显示：
 *  1. 当前工具不是选择——马上要画的东西需要先挑颜色粗细；
 *  2. 选中项里有白板 shape——它们真的有样式可改。
 *
 * 选中的全是 `aicc` 节点时隐藏：节点的颜色走自己的右键菜单，
 * tldraw 的面板对它们只会显示一个没用的透明度滑块。
 */
export function shouldShowStylePanel(
  toolId: string,
  selectedTypes: readonly string[],
): boolean {
  if (toolId !== "select") return true;
  return selectedTypes.some(isWhiteboardShapeType);
}

/* -------------------------------- 删除 ----------------------------------- */

/** `canvas.delete` 分流用的一条选中项。 */
export interface SelectedShapeInfo {
  /** tldraw 的 shape id。 */
  id: string;
  type: string;
  /** 箭头的 `meta.aicc.id`（边 id）；不是边就是 null。 */
  edgeId: string | null;
  /** shape id 能还原出的节点 id；不是节点 shape 就是 null。 */
  nodeId: string | null;
}

export interface DeleteSplit {
  /** 走 `store.removeNodes`（可能先弹会话确认框）。 */
  nodes: string[];
  /** 走 `store.removeEdges`。 */
  edges: string[];
  /** 纯白板 shape，直接 `editor.deleteShapes`。 */
  shapes: string[];
}

/**
 * 把一次选中拆成「节点 / 边 / 白板 shape」三堆（Phase 2 遗留待办 1）。
 *
 * 认边看的是 `meta.aicc.id` 而不是 shape id——用户拖出来的箭头 id 是随机的。
 * 认不出的箭头（没绑定、或只绑了一端）是白板内容，直接删。
 * 认不出的 `aicc` shape 一概不动：文档里没有它，删了也同步不回去。
 */
export function splitSelectionForDelete(
  selected: readonly SelectedShapeInfo[],
  knownNodeIds: ReadonlySet<string>,
  knownEdgeIds: ReadonlySet<string>,
): DeleteSplit {
  const split: DeleteSplit = { nodes: [], edges: [], shapes: [] };
  for (const shape of selected) {
    if (shape.nodeId !== null) {
      if (knownNodeIds.has(shape.nodeId)) split.nodes.push(shape.nodeId);
      continue;
    }
    if (shape.edgeId !== null && knownEdgeIds.has(shape.edgeId)) {
      split.edges.push(shape.edgeId);
      continue;
    }
    split.shapes.push(shape.id);
  }
  return split;
}
