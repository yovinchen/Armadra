import { create } from "zustand";

import { createBoardSlice } from "./canvas/board";
import { createSelectionSlice } from "./canvas/selection";
import { createNodesSlice } from "./canvas/nodes";
import { createLayoutSlice } from "./canvas/layout";
import { createEdgesSlice } from "./canvas/edges";
import { createViewSlice } from "./canvas/view";
import type { CanvasStore } from "./canvas/types";

export type {
  AddNodeOptions,
  BoardBrief,
  CanvasActions,
  CanvasState,
  CanvasStore,
  PanelState,
  PremaxRect,
  Rect,
  SaveState,
} from "./canvas/types";
export { absolutePosition } from "./canvas/internal";
export {
  useCanRedo,
  useCanUndo,
  useCanvasNode,
  useIsMaximized,
  useSelectedNodes,
} from "./canvas/selectors";

/**
 * 画布状态 —— docs/contracts/tldraw-canvas-plan.md §3 / §9.3。
 *
 * v4 的两条规则：
 *
 *  1. **tldraw store 是内存真相。** 每个动作都写两处：先照旧改 `document`
 *     （45 个消费方要求「调完就能读到」，异步派生做不到），再把同一件事做到
 *     editor 上。随后 `sync/use-store-sync.ts` 从 editor 反向派生出文档；
 *     内容一致时它什么也不做，所以不会来回抖。
 *  2. **撤销栈归 editor。** `history` 字段已删除，`undo/redo` 转调
 *     `editor.undo()/redo()`；画布没挂载（启动页、单测）时是安全的空操作。
 *
 * `setViewport` 仍然既不置 dirty 也不进历史，由 `save/autosave.ts` 单独节流。
 */
export const useCanvasStore = create<CanvasStore>((set, get) => ({
  ...createBoardSlice(set, get),
  ...createSelectionSlice(set, get),
  ...createNodesSlice(set, get),
  ...createLayoutSlice(set, get),
  ...createEdgesSlice(set, get),
  ...createViewSlice(set, get),
}));
