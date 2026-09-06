import { usePreferencesStore } from "../../app/preferences-store";
import { parseWhiteboard } from "../../canvas/whiteboard/serialize";
import { resetHistory } from "./history";
import { emptyBoardState, initialPanels } from "./internal";
import { type CanvasGet, type CanvasSet, type CanvasStore } from "./types";

export function createBoardSlice(
  set: CanvasSet,
  _get: CanvasGet,
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
  | "selectedEdgeIds"
  | "selectedItemIds"
  | "selectedNodeIds"
  | "setBoards"
  | "setDocument"
  | "setPanel"
  | "setSaveError"
  | "setSaveState"
  | "setWorkspace"
  | "whiteboard"
  | "workspace"
> {
  return {
    workspace: null,
    boards: [],
    boardId: null,
    panels: initialPanels,
    ...emptyBoardState,

    setWorkspace: (workspace) =>
      set((state) => {
        if (state.workspace?.id === workspace?.id) return { workspace };
        resetHistory();
        return { workspace, boards: [], boardId: null, ...emptyBoardState };
      }),

    setBoards: (boards) =>
      set((state) => {
        const sorted = [...boards].sort(
          (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
        );
        if (sorted.some((board) => board.id === state.boardId)) {
          return { boards: sorted };
        }
        resetHistory();
        return {
          boards: sorted,
          boardId: sorted[0]?.id ?? null,
          ...emptyBoardState,
        };
      }),

    selectBoard: (boardId) =>
      set((state) => {
        if (state.boardId === boardId) return { boardId };
        resetHistory();
        return { boardId, ...emptyBoardState };
      }),

    /**
     * 打开一块画布（也用于 WS 事件重载与保存 409 变基后的写回）。
     *
     * 白板在这里解析一次（§3.3）：只认 v2，认不出的一律按空白板处理，
     * 下一次保存直接覆盖。远端灌入不进撤销栈，所以顺手清空历史——上一块
     * 板的反向补丁在这一块上没有意义。
     */
    setDocument: (document) => {
      resetHistory();
      set({
        ...emptyBoardState,
        document,
        whiteboard: parseWhiteboard(document.board.whiteboard).doc,
        boardId: document.board.id,
        saveState: "saved",
      });
    },

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
  };
}
