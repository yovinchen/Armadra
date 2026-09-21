import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Circle,
  Diamond,
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

import type { CanvasCommandId } from "./commands";
import { CANVAS_TOOL_IDS, type CanvasToolId } from "./interaction/tool-store";
import { GEOS, isItemId, type Geo } from "./whiteboard/model";

/**
 * 白板工具表（React Flow 计划 F21）。
 *
 * 一份规格驱动三处：Dock 的工具组、`keybindings.ts` 的 `canvas.tool.*`
 * 命令、`FlowWorkspace` 注册的命令实现。工具 id 从旧引擎换成我们自己的
 * （`interaction/tool-store.ts`），集合一个没变，所以这里仍然**没有映射表**。
 *
 * `image` 不是工具：它在 Dock 上是一个触发文件选择的按钮，落到
 * `dnd/external-content.ts` 的图片分支，所以单列在 `IMAGE_TOOL`。
 */

export { CANVAS_TOOL_IDS };
export type { CanvasToolId };

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
];

/**
 * 手机上开放的工具（F32 / §6.6）。
 *
 * 手指画不出能用的墨迹，几何形与文字都要跟着一个样式面板，390×844 里
 * 摆不下——所以只留平移与选择这两件在触屏上真的好用的事。桌面窗口缩到
 * 767px 以下也走这一条（同一个断点，`platform/layout.isCompactLayout`）。
 */
export const PHONE_TOOL_IDS: readonly CanvasToolId[] = ["select", "hand"];

/**
 * 图片：不是工具，所以它没有命令、没有键位。
 * Dock 上那个按钮自己开文件选择，把文件交给外部内容处理器。
 */
export const IMAGE_TOOL: { labelKey: string; icon: LucideIcon } = {
  labelKey: "tool.image",
  icon: ImageIcon,
};

/* ------------------------------ 形状下拉 --------------------------------- */

export interface GeoOption {
  geo: Geo;
  labelKey: string;
  icon: LucideIcon;
}

/**
 * 形状按钮的下拉。选一项 = 把它写进 `tool-store.nextStyle` 再切到形状工具，
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

/** 表与类型必须同步：漏一种几何形是编译错误，不是运行时惊喜。 */
export const GEO_IDS: readonly Geo[] = GEOS;

/** 当前几何形对应的图标；未知值退回矩形。 */
export function geoIcon(geo: string): LucideIcon {
  return GEO_OPTIONS.find((option) => option.geo === geo)?.icon ?? Square;
}

/* -------------------------------- 锁定 ----------------------------------- */

/**
 * 锁定视图时哪些工具要置灰。
 *
 * 锁定锁的是相机，但「能画」而「不能平移」是自相矛盾的状态，所以除了
 * 选择之外全部禁用。
 */
export function isToolDisabledWhenLocked(id: string): boolean {
  return id !== "select";
}

/* ------------------------------ 样式面板 --------------------------------- */

/**
 * 样式面板显隐（§2.4）。两种情况显示：
 *
 *  1. 当前工具不是选择——马上要画的东西需要先挑颜色粗细；
 *  2. 选中项里有白板对象——它们真的有样式可改。
 *
 * 选中的全是节点时隐藏：节点的颜色走自己的右键菜单。
 */
export function shouldShowStylePanel(
  toolId: string,
  selectedIds: readonly string[],
): boolean {
  if (toolId !== "select") return true;
  return selectedIds.some(isItemId);
}

/* -------------------------------- 删除 ----------------------------------- */

export interface DeleteSplit {
  /** 走 `store.removeNodes`（可能先弹会话确认框）。 */
  nodes: string[];
  /** 走 `store.removeEdges`。 */
  edges: string[];
  /** 白板对象，走 `whiteboard.removeItems`（B2）。 */
  items: string[];
  /** 内容引用，走 `whiteboard.removeReferences`（B5 / F29）。 */
  references: string[];
}

/**
 * 把一次选中拆成「节点 / 边 / 白板对象 / 引用」四堆（F17）。
 *
 * 判据就是 id：`wb:` 前缀是白板对象，其余按三张表查。三张表都不认的 id
 * 一概丢掉——文档里没有它，删了也同步不回去。
 *
 * 引用与上下文连线在 React Flow 上都是边，选区里混在同一格
 * （`selectedEdgeIds`），但它们住在两份文档里：连线是 `document.edges`
 * 的一行，引用是 `whiteboard.references` 的一行。少了这一堆，框选一片
 * 「连线 + 引用」再按 Delete 会只删掉连线，引用静静地留着（B5 交接记录）。
 */
export function splitSelectionForDelete(
  selected: readonly string[],
  knownNodeIds: ReadonlySet<string>,
  knownEdgeIds: ReadonlySet<string>,
  knownReferenceIds: ReadonlySet<string> = new Set(),
): DeleteSplit {
  const split: DeleteSplit = {
    nodes: [],
    edges: [],
    items: [],
    references: [],
  };
  for (const id of selected) {
    if (isItemId(id)) {
      split.items.push(id);
      continue;
    }
    if (knownNodeIds.has(id)) {
      split.nodes.push(id);
      continue;
    }
    if (knownEdgeIds.has(id)) {
      split.edges.push(id);
      continue;
    }
    if (knownReferenceIds.has(id)) split.references.push(id);
  }
  return split;
}
