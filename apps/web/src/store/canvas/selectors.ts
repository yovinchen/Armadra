import { useShallow } from "zustand/react/shallow";
import { type CanvasNode } from "@armadra/shared";
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
 * 撤销 / 重做的可用性来自自写的历史栈（`store/canvas/history.ts`）。
 *
 * 直接转出去而不是包一层：Dock 与命令面板都在画布组件树之外，历史模块
 * 本来就是模块级的 `useSyncExternalStore`，不需要任何上下文。
 */
export { useCanRedo, useCanUndo } from "./history";

/** 节点当前是否处于最大化状态（头部按钮要在最大化/还原之间切换）。 */
export function useIsMaximized(id: string): boolean {
  return useCanvasStore((state) => state.maximized[id] !== undefined);
}
