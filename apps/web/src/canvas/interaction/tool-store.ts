import * as React from "react";

import type {
  WhiteboardColor,
  WhiteboardSize,
} from "@/app/preferences/whiteboard";
import type { Dash, Fill, Geo } from "@/canvas/whiteboard/model";

/**
 * 当前白板工具与「下一个对象的样式」（React Flow 计划 §2.11 / F21，
 * 归属 canvas；B0 放骨架，B2 填满工具覆盖层）。
 *
 * 旧引擎里这两件事住在编辑器里，Dock 用 `useValue` 订阅。现在没有
 * editor 了，而 Dock、快捷键、命令面板、样式面板都在画布组件树之外，
 * 所以做法与 `canvas-lock.ts` 一样：模块级变量 + `useSyncExternalStore`。
 *
 * 不进 zustand：它是 UI 的瞬时状态，不跟着画布文档存盘（默认颜色 / 粗细
 * 那两项由 `preferences-store` 持久化，挂载时推进来）。
 */

/** 开放给用户的工具。 */
export const CANVAS_TOOL_IDS = [
  "select",
  "hand",
  "draw",
  "highlight",
  "geo",
  "line",
  "arrow",
  "text",
] as const;

export type CanvasToolId = (typeof CANVAS_TOOL_IDS)[number];

export function isCanvasToolId(value: string): value is CanvasToolId {
  return (CANVAS_TOOL_IDS as readonly string[]).includes(value);
}

/**
 * 会自己吃掉左键的工具（选择与手之外的全部）。
 *
 * 两处读它，读的必须是同一个判据：`flow/flow-options.ts` 靠它关掉 React Flow
 * 的框选 / 节点拖动 / 拖动平移，`whiteboard/tools/use-tool-pointer.ts` 靠它
 * 决定要不要接管指针。手形不算——它的左键归 `panOnDrag`，不归工具层。
 */
export function isDrawingTool(tool: CanvasToolId): boolean {
  return tool !== "select" && tool !== "hand";
}

/* -------------------------------- 工具组 ---------------------------------- */

/**
 * Dock 上共用一个按钮的两对工具：笔（画笔 / 高亮）与线（直线 / 箭头）。
 *
 * 它们做的是同一件事的两种口味，各占一格只是在 Dock 上多摆两个按钮。合成
 * 一格之后按钮图标跟着「这一组上次选的那种」走，下拉里换另一种——与形状
 * 按钮跟着 `nextStyle.geo` 是同一套做法。
 *
 * 记忆放在这里而不是 Dock 里：快捷键与命令面板也能切到组内成员
 * （`canvas.tool.draw` 等四条命令照旧），按下去 Dock 的图标必须跟着变。
 */
export const TOOL_GROUPS = {
  pen: ["draw", "highlight"],
  line: ["line", "arrow"],
} as const satisfies Record<string, readonly CanvasToolId[]>;

export type ToolGroupId = keyof typeof TOOL_GROUPS;

export type ToolGroupChoice = {
  [K in ToolGroupId]: (typeof TOOL_GROUPS)[K][number];
};

const DEFAULT_TOOL_GROUP_CHOICE: ToolGroupChoice = {
  pen: "draw",
  line: "line",
};

/** 工具 → 它所属的组；不在任何组里的工具返回 null。 */
export function toolGroupOf(id: CanvasToolId): ToolGroupId | null {
  for (const group of Object.keys(TOOL_GROUPS) as ToolGroupId[]) {
    if ((TOOL_GROUPS[group] as readonly CanvasToolId[]).includes(id)) {
      return group;
    }
  }
  return null;
}

let groupChoice: ToolGroupChoice = DEFAULT_TOOL_GROUP_CHOICE;
const groupListeners = new Set<() => void>();

export function getToolGroupChoice(): ToolGroupChoice {
  return groupChoice;
}

/** 记下某一组当前选的成员；`setTool` 会替所有入口调它。 */
function rememberToolGroup(id: CanvasToolId): void {
  const group = toolGroupOf(id);
  if (!group || groupChoice[group] === id) return;
  groupChoice = { ...groupChoice, [group]: id };
  for (const listener of groupListeners) listener();
}

function subscribeToolGroup(listener: () => void): () => void {
  groupListeners.add(listener);
  return () => groupListeners.delete(listener);
}

export function useToolGroupChoice(): ToolGroupChoice {
  return React.useSyncExternalStore(
    subscribeToolGroup,
    getToolGroupChoice,
    () => DEFAULT_TOOL_GROUP_CHOICE,
  );
}

/* --------------------------------- 工具 ----------------------------------- */

let tool: CanvasToolId = "select";
const toolListeners = new Set<() => void>();

export function getTool(): CanvasToolId {
  return tool;
}

export function setTool(next: CanvasToolId): void {
  // 记忆在相等判断**之前**更新：下拉里重选当前那一项也要算数。
  rememberToolGroup(next);
  if (tool === next) return;
  tool = next;
  // 换工具就是新的一轮：样式面板上一次手动改的档位不再当基准。
  forgetManualSize();
  for (const listener of toolListeners) listener();
}

function subscribeTool(listener: () => void): () => void {
  toolListeners.add(listener);
  return () => toolListeners.delete(listener);
}

export function useTool(): CanvasToolId {
  return React.useSyncExternalStore(subscribeTool, getTool, () => "select");
}

/* -------------------------------- 下一个样式 -------------------------------- */

/**
 * 「下一个画出来的对象长什么样」。改选中对象的样式是另一条路径
 * （`whiteboard.updateItem`），两者共用同一张表的值域。
 */
export interface NextStyle {
  color: WhiteboardColor;
  size: WhiteboardSize;
  dash: Dash;
  fill: Fill;
  geo: Geo;
}

const DEFAULT_NEXT_STYLE: NextStyle = {
  color: "black",
  size: "m",
  dash: "solid",
  fill: "none",
  geo: "rectangle",
};

let nextStyle: NextStyle = DEFAULT_NEXT_STYLE;
const styleListeners = new Set<() => void>();

export function getNextStyle(): NextStyle {
  return nextStyle;
}

function writeStyle(patch: Partial<NextStyle>): void {
  const merged = { ...nextStyle, ...patch };
  const changed = (Object.keys(merged) as (keyof NextStyle)[]).some(
    (key) => merged[key] !== nextStyle[key],
  );
  if (!changed) return;
  nextStyle = merged;
  for (const listener of styleListeners) listener();
}

/** 用户自己改的样式（样式面板、Dock 的几何形菜单）。 */
export function setNextStyle(patch: Partial<NextStyle>): void {
  if (patch.size !== undefined) manualSize = patch.size;
  writeStyle(patch);
}

/* ------------------------------ 笔画档位基准 ------------------------------ */

/**
 * 「动态尺寸」（§2.10）永远从**基准档位**推导，不吃自己上一次的结果。
 *
 * 缩到 50% 画一笔会把 `nextStyle.size` 顶粗一档。要是下一笔再拿这一档去缩
 * 放，档位就只升不降——回到 100% 也退不回来，偏好里的默认粗细被永久盖掉
 * （2026-09-06 用户反馈）。所以基准单独存：`preferenceSize` 是偏好推进来
 * 的，`manualSize` 是样式面板手动改的（下一次工具切换时清掉），
 * `setDerivedSize` 只改「下一个」的档位，碰不到基准。
 */
let preferenceSize: WhiteboardSize = DEFAULT_NEXT_STYLE.size;
let manualSize: WhiteboardSize | null = null;

/** 推导档位的基准：手动改过就用手动值，否则用偏好里的默认粗细。 */
export function getBaseSize(): WhiteboardSize {
  return manualSize ?? preferenceSize;
}

/**
 * 丢掉手动档位，回到偏好的默认粗细。样式面板跟着一起回去，不让面板显示的
 * 档位和下一笔实际画出来的对不上。
 */
function forgetManualSize(): void {
  manualSize = null;
  writeStyle({ size: preferenceSize });
}

/**
 * 偏好 → 样式的单向推送（`app/use-canvas-preferences.ts`、
 * `whiteboard/tools/ToolLayer.tsx`）。它重置基准，手动档位不再生效。
 */
export function setDefaultStyle(style: {
  color: WhiteboardColor;
  size: WhiteboardSize;
}): void {
  preferenceSize = style.size;
  manualSize = null;
  writeStyle(style);
}

/** 动态尺寸算出来的档位：只改「下一个」，不进基准。 */
export function setDerivedSize(size: WhiteboardSize): void {
  writeStyle({ size });
}

function subscribeStyle(listener: () => void): () => void {
  styleListeners.add(listener);
  return () => styleListeners.delete(listener);
}

export function useNextStyle(): NextStyle {
  return React.useSyncExternalStore(
    subscribeStyle,
    getNextStyle,
    () => DEFAULT_NEXT_STYLE,
  );
}

/** 仅测试与画布卸载用：工具、样式与档位基准都回到初始值。 */
export function resetToolStore(): void {
  setTool("select");
  groupChoice = DEFAULT_TOOL_GROUP_CHOICE;
  for (const listener of groupListeners) listener();
  preferenceSize = DEFAULT_NEXT_STYLE.size;
  manualSize = null;
  writeStyle(DEFAULT_NEXT_STYLE);
}
