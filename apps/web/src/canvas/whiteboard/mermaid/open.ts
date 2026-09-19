import * as React from "react";
import type { Position } from "@armadra/shared";

/**
 * 导入对话框的开关（[Mermaid 导入](../../../../../../docs/design/mermaid-import.md) §4.2）。
 *
 * 四个入口要打开同一个对话框：加号菜单、快捷键、粘贴、拖入 `.mmd`。它们
 * 谁都不该 import 那个 React 组件（`add-menu.ts` 与 `external-content.ts`
 * 都不是组件文件，而且组件那条链上挂着 mermaid 与 dagre）。所以开关状态
 * 单独放在这个 20 行的模块里，组件只订阅它。
 *
 * 用 `useSyncExternalStore` 而不是 zustand：这里只有一个布尔加两个字段，
 * 和 `interaction/tool-store.ts` 同一个写法。
 */

export interface MermaidDialogState {
  open: boolean;
  /** 预填的文本（粘贴与拖放带进来），没有就是空串。 */
  text: string;
  /** 落点；null = 用视口中心。 */
  at: Position | null;
}

const CLOSED: MermaidDialogState = { open: false, text: "", at: null };

let state: MermaidDialogState = CLOSED;
const listeners = new Set<() => void>();

function emit(next: MermaidDialogState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getMermaidDialog(): MermaidDialogState {
  return state;
}

/** 打开（可带预填文本与落点）。 */
export function openMermaidImport(
  options: { text?: string; at?: Position | null } = {},
): void {
  emit({
    open: true,
    text: options.text ?? "",
    at: options.at ?? null,
  });
}

export function closeMermaidImport(): void {
  if (state.open) emit(CLOSED);
}

/** 仅测试用。 */
export function resetMermaidDialog(): void {
  state = CLOSED;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMermaidDialog(): MermaidDialogState {
  return React.useSyncExternalStore(
    subscribe,
    getMermaidDialog,
    getMermaidDialog,
  );
}

/**
 * 只订阅「开没开」。
 *
 * `ToolLayer` 用它决定要不要渲染那个懒加载的组件——订阅整份状态会让
 * 每次改文本都重渲染整个工具层。
 */
export function useMermaidDialogOpen(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => state.open,
    () => false,
  );
}
