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
  beginCoalesce,
  endCoalesce,
  resetHistory,
  type CommitOptions,
} from "./canvas/history";
export {
  useCanRedo,
  useCanUndo,
  useCanvasNode,
  useIsMaximized,
  useSelectedNodes,
} from "./canvas/selectors";

/**
 * 画布状态 —— docs/design/canvas-react-flow.md §2.1。
 *
 * 两条规则：
 *
 *  1. **这里是唯一的内存真相。** React Flow 是受控视图：`nodes` / `edges`
 *     由 `document` 与 `whiteboard` 投影出来（`canvas/sync/project.ts`），
 *     用户手势经回调翻译成这里的动作。旧引擎「编辑器是真相、文档
 *     反向派生」的双轨整个删除了。
 *  2. **撤销栈自己维护。** `store/canvas/history.ts` 记按实体的反向补丁；
 *     远端灌入（`setDocument`、WS 事件、保存 409 变基）走
 *     `history: "ignore"`，所以 ⌘Z 撤不掉别人建的节点。
 *
 * `setViewport` 既不置 dirty 也不进历史，由 `save/autosave.ts` 单独节流。
 */
export const useCanvasStore = create<CanvasStore>((set, get) => ({
  ...createBoardSlice(set, get),
  ...createSelectionSlice(set, get),
  ...createNodesSlice(set, get),
  ...createLayoutSlice(set, get),
  ...createEdgesSlice(set, get),
  ...createViewSlice(set, get),
}));
