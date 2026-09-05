import * as React from "react";

/**
 * 「锁定视图」的开关（tldraw 计划 §5，Phase 3 第 6 条）。
 *
 * 锁定原本只是 `TldrawWorkspace` 的一个局部 state，但工具组在 Dock 上、
 * 在画布组件树之外，所以要有一处两边都能读的真相。做法与
 * `editor-context.ts` 一样：模块级变量 + `useSyncExternalStore`，
 * 不进 zustand（它是 UI 的瞬时状态，不该跟着画布文档存盘）。
 *
 * 锁的是相机，不是编辑；但「不能平移却能画」是自相矛盾的状态，
 * 所以锁定时白板工具一并置灰（`tools.ts` 的 `isToolDisabledWhenLocked`）。
 */

let locked = false;
const listeners = new Set<() => void>();

export function isCanvasLocked(): boolean {
  return locked;
}

export function setCanvasLocked(next: boolean): void {
  if (locked === next) return;
  locked = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCanvasLocked(): boolean {
  return React.useSyncExternalStore(subscribe, isCanvasLocked, () => false);
}

/** 仅测试用：把开关恢复成初始值。 */
export function resetCanvasLock(): void {
  setCanvasLocked(false);
}
