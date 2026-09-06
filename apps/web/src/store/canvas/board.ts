import { usePreferencesStore } from "../../app/preferences-store";
import { parseWhiteboard } from "../../canvas/whiteboard/serialize";
import { resetHistory } from "./history";
import { emptyBoardState, initialPanels } from "./internal";
import {
  type CanvasGet,
  type CanvasSet,
  type CanvasStore,
  type PanelState,
} from "./types";

/**
 * 右侧工作面板（画布平台设计 §4）。抽屉形态共用同一块地方，一次只开一个；
 * 外壳与「不因点到外面就关」的规矩在 `panels/WorkPanelSheet.tsx`。
 */
const WORK_PANELS = [
  "explorer",
  "scm",
  "github",
  "resources",
  "automation",
  "handoff",
  "problems",
  "usage",
] as const;

type WorkPanel = (typeof WORK_PANELS)[number];

function isWorkPanel(key: keyof PanelState): key is WorkPanel {
  return (WORK_PANELS as readonly string[]).includes(key);
}

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
     *
     * 右侧那一排抽屉共用同一块地方（画布平台设计 §4「右侧使用同一个工作面板
     * 容器」），所以开一个就把别的关掉：两个 `drawer` 同时开着时，后开的那个
     * 正好压在前一个上，用户看到的是「点了没反应」。pin 成浮卡的不在此列——
     * 那是用户明确要它常驻在旁边。
     */
    setPanel: (key, value) => {
      if (key === "sidebar") {
        usePreferencesStore.getState().setSidebarOpen(value === "open");
      }
      set((state) => {
        const panels: PanelState = { ...state.panels, [key]: value };
        if (value !== "drawer" || !isWorkPanel(key)) return { panels };
        for (const other of WORK_PANELS) {
          if (other !== key && panels[other] === "drawer") {
            panels[other] = "closed";
          }
        }
        return { panels };
      });
    },
  };
}
