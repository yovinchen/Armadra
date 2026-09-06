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

/** 开放给用户的工具。集合与旧引擎相同，id 从此归我们自己。 */
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

/* --------------------------------- 工具 ----------------------------------- */

let tool: CanvasToolId = "select";
const toolListeners = new Set<() => void>();

export function getTool(): CanvasToolId {
  return tool;
}

export function setTool(next: CanvasToolId): void {
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
  preferenceSize = DEFAULT_NEXT_STYLE.size;
  manualSize = null;
  writeStyle(DEFAULT_NEXT_STYLE);
}
