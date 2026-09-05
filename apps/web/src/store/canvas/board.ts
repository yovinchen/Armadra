import * as React from "react";
import { usePreferencesStore } from "../../app/preferences-store";
import { emptyBoardState, initialPanels } from "./internal";
import { type CanvasGet, type CanvasSet, type CanvasStore } from "./types";

export function createBoardSlice(
  set: CanvasSet,
  get: CanvasGet,
): Pick<
  CanvasStore,
  | "boardId"
  | "boards"
  | "document"
  | "focusNodeId"
  | "maximized"
  | "panels"
  | "saveError"
  | "saveState"
  | "selectBoard"
  | "selectedNodeIds"
  | "setBoards"
  | "setDocument"
  | "setPanel"
  | "setSaveError"
  | "setSaveState"
  | "setWorkspace"
  | "workspace"
> {
  return {
    workspace: null,
    boards: [],
    boardId: null,
    panels: initialPanels,
    ...emptyBoardState,

    setWorkspace: (workspace) =>
      set((state) =>
        state.workspace?.id === workspace?.id
          ? { workspace }
          : { workspace, boards: [], boardId: null, ...emptyBoardState },
      ),

    setBoards: (boards) =>
      set((state) => {
        const sorted = [...boards].sort(
          (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
        );
        if (sorted.some((board) => board.id === state.boardId)) {
          return { boards: sorted };
        }
        return {
          boards: sorted,
          boardId: sorted[0]?.id ?? null,
          ...emptyBoardState,
        };
      }),

    selectBoard: (boardId) =>
      set((state) =>
        state.boardId === boardId
          ? { boardId }
          : { boardId, ...emptyBoardState },
      ),

    setDocument: (document) =>
      set({
        ...emptyBoardState,
        document,
        boardId: document.board.id,
        saveState: "saved",
      }),

    setSaveState: (saveState) => set({ saveState }),
    setSaveError: (saveError) => set({ saveError }),

    /**
     * 侧栏是唯一跨会话记住开合的面板，所以这里顺手写进偏好；
     * 其余面板都是「开着不留痕」。
     */
    setPanel: (key, value) => {
      if (key === "sidebar") {
        usePreferencesStore.getState().setSidebarOpen(value === "open");
      }
      set((state) => ({ panels: { ...state.panels, [key]: value } }));
    },

    /**
     * 选中态与 editor 双向同步。
     *
     * 只在「真的不一样」时才回写 editor：`use-store-sync` 会把 editor 的选中
     * 变化推回这里，两边只要有一次内容相同但数组身份不同，就会互相触发到
     * React 抛「Maximum update depth exceeded」（React Flow 时代踩过一次）。
     */
  };
}
