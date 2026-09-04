import * as React from "react";
import type { Editor } from "tldraw";
import type { Position } from "@ai-coding-canvas/shared";

/**
 * 全局 editor 句柄（tldraw 计划 §9.1，归属 canvas）。
 *
 * `TldrawWorkspace` 在 `onMount` 里 `setEditor(editor)`、卸载时 `setEditor(null)`；
 * Dock / 命令面板 / 侧栏 / store 门面通过这里拿 editor，**不许**各自
 * `useEditor()`——那个 hook 只能在 `<Tldraw>` 子树内用，而这些模块都在树外。
 *
 * 画布没挂载（启动页、单测）时一律返回 null，调用方必须自己兜底。
 */

let current: Editor | null = null;
const listeners = new Set<() => void>();

export function getEditor(): Editor | null {
  return current;
}

export function setEditor(editor: Editor | null): void {
  if (current === editor) return;
  current = editor;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 订阅挂载 / 卸载；画布重建时组件会重新渲染并拿到新的 editor。 */
export function useEditorHandle(): Editor | null {
  return React.useSyncExternalStore(subscribe, getEditor, () => null);
}

/** 屏幕坐标 → 页面坐标；画布未挂载时原样返回（右键菜单的兜底）。 */
export function screenToPage(point: Position): Position {
  const editor = current;
  if (!editor) return point;
  const page = editor.screenToPage({ x: point.x, y: point.y });
  return { x: page.x, y: page.y };
}

/** 会话侧栏 / 命令面板点一行 → 画布居中到那个节点。 */
export const CENTER_NODE_EVENT = "aicc:canvas:center-node";

export function requestCenterOnNode(nodeId: string): void {
  window.dispatchEvent(
    new CustomEvent(CENTER_NODE_EVENT, { detail: { nodeId } }),
  );
}
