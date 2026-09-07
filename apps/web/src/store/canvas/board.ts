import { usePreferencesStore } from "../../app/preferences-store";
import { mergeRemoteBoard } from "../../canvas/sync/merge";
import { toItemId } from "../../canvas/whiteboard/model";
import { parseWhiteboard } from "../../canvas/whiteboard/serialize";
import { resetHistory } from "./history";
import { clearLocalEdits, localEdits } from "./pending";
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

/**
 * 「这块工作面板现在占着地方」的那几个值。
 *
 * 抽屉只有 `drawer` 一种形态时这是一次相等判断；Git 工具窗口停到底部之后
 * 多了 `bottom` 与 `maximized`（Git 工具窗口设计 §2.1），它们同样占着那块
 * 地方，所以「一次只开一个」必须把它们算进来——否则底部的 Git 窗口和右侧
 * 的资源管理器会同时开着，而它们本来就是同一个容器的两种停靠方向。
 */
const OPEN_WORK_PANEL = ["drawer", "bottom", "maximized"] as const;
function occupies(value: PanelState[keyof PanelState]): boolean {
  return (OPEN_WORK_PANEL as readonly unknown[]).includes(value);
}

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
  | "mergeRemoteDocument"
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
        clearLocalEdits();
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
        clearLocalEdits();
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
        clearLocalEdits();
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
      clearLocalEdits();
      set({
        ...emptyBoardState,
        document,
        whiteboard: parseWhiteboard(document.board.whiteboard).doc,
        boardId: document.board.id,
        saveState: "saved",
      });
    },

    /**
     * 远端改过之后重取回来的文档（`app/use-board-sync.ts` 收到
     * `board.changed` / Host 事件后调）。
     *
     * 三条与 `setDocument` 不同的规矩，都是 A04 要的：
     *
     *  1. **撤销栈不动。** 既不记录（远端改动不该能被 ⌘Z 撤掉），也不清空
     *     （别的窗口挪了一个节点，这边攒了半天的历史不该跟着没）。
     *  2. **保存态不动。** 本地还脏就继续脏，那一轮防抖照常把改动写出去，
     *     只是带上了远端刚给的 CAS 戳，下一次 PUT 不会再撞 409。
     *  3. **没变就不写。** 自己刚保存完收到的是自己那份，`changed` 为 false，
     *     一次多余的 `set` 都不做。
     */
    mergeRemoteDocument: (remote) => {
      const state = get();
      const local = state.document;
      if (!local || state.boardId !== remote.board.id) return;
      const dirty =
        state.saveState === "dirty" ||
        state.saveState === "saving" ||
        state.saveState === "error";
      const merged = mergeRemoteBoard({
        local,
        localWhiteboard: state.whiteboard,
        remote,
        dirty,
        // 只有这个窗口动过的那几条以本地为准，其余照收远端的（`pending.ts`）。
        localEdits: localEdits(),
      });
      if (!merged.changed) return;
      // 远端删掉的东西不能继续留在选区里，否则 Delete 打在不存在的 id 上。
      const nodeIds = new Set(merged.document.nodes.map((node) => node.id));
      const itemIds = new Set(
        merged.whiteboard.items.map((item) => toItemId(item.id)),
      );
      const edgeIds = new Set([
        ...merged.document.edges.map((edge) => edge.id),
        ...merged.whiteboard.references.map((reference) => reference.id),
      ]);
      set({
        document: merged.document,
        whiteboard: merged.whiteboard,
        selectedNodeIds: state.selectedNodeIds.filter((id) => nodeIds.has(id)),
        selectedItemIds: state.selectedItemIds.filter((id) => itemIds.has(id)),
        selectedEdgeIds: state.selectedEdgeIds.filter((id) => edgeIds.has(id)),
        maximized: Object.fromEntries(
          Object.entries(state.maximized).filter(([id]) => nodeIds.has(id)),
        ),
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
        if (!occupies(value) || !isWorkPanel(key)) return { panels };
        for (const other of WORK_PANELS) {
          if (other !== key && occupies(panels[other])) {
            panels[other] = "closed";
          }
        }
        return { panels };
      });
    },
  };
}
