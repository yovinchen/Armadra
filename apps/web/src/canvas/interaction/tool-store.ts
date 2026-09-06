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

/* --------------------------------- 工具 ----------------------------------- */

let tool: CanvasToolId = "select";
const toolListeners = new Set<() => void>();

export function getTool(): CanvasToolId {
  return tool;
}

export function setTool(next: CanvasToolId): void {
  if (tool === next) return;
  tool = next;
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

export function setNextStyle(patch: Partial<NextStyle>): void {
  const merged = { ...nextStyle, ...patch };
  const changed = (Object.keys(merged) as (keyof NextStyle)[]).some(
    (key) => merged[key] !== nextStyle[key],
  );
  if (!changed) return;
  nextStyle = merged;
  for (const listener of styleListeners) listener();
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

/** 仅测试与画布卸载用：工具与样式都回到初始值。 */
export function resetToolStore(): void {
  setTool("select");
  setNextStyle(DEFAULT_NEXT_STYLE);
}
