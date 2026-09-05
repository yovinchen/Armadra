import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { type Editor } from "tldraw";
import { type CanvasNode } from "@armadra/shared";
import { useEditorHandle } from "../../canvas/editor-context";
import { useCanvasStore } from "../canvas-store";

/* --------------------------------- 选择器 --------------------------------- */

export function useSelectedNodes(): CanvasNode[] {
  return useCanvasStore(
    useShallow((state) =>
      state.document
        ? state.document.nodes.filter((node) =>
            state.selectedNodeIds.includes(node.id),
          )
        : [],
    ),
  );
}

export function useCanvasNode(id: string | null): CanvasNode | undefined {
  return useCanvasStore((state) =>
    id ? state.document?.nodes.find((node) => node.id === id) : undefined,
  );
}

/**
 * 撤销 / 重做的可用性来自 editor 的历史栈。
 *
 * 用 `useSyncExternalStore` 订阅 `editor.store.listen` 而不是 tldraw 的
 * `useValue`：这两个 hook 会被画布之外的组件（Dock、命令面板）调用，
 * 那里没有 `<Tldraw>` 的上下文。
 */
function useEditorHistoryFlag(read: (editor: Editor) => boolean): boolean {
  const editor = useEditorHandle();
  const subscribe = React.useCallback(
    (onChange: () => void) =>
      editor ? editor.store.listen(onChange) : () => {},
    [editor],
  );
  const snapshot = React.useCallback(
    () => (editor ? read(editor) : false),
    [editor, read],
  );
  return React.useSyncExternalStore(subscribe, snapshot, () => false);
}

const readCanUndo = (editor: Editor) => editor.getCanUndo();
const readCanRedo = (editor: Editor) => editor.getCanRedo();

export function useCanUndo(): boolean {
  return useEditorHistoryFlag(readCanUndo);
}

export function useCanRedo(): boolean {
  return useEditorHistoryFlag(readCanRedo);
}

/** 节点当前是否处于最大化状态（头部按钮要在最大化/还原之间切换）。 */
export function useIsMaximized(id: string): boolean {
  return useCanvasStore((state) => state.maximized[id] !== undefined);
}
