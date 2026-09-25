import { getFlow } from "../../canvas/flow/flow-context";
import { arrangeCanvas } from "../../canvas/tidy-flow";
import { diffSnapshots, record, redo, undo } from "./history";
import { markPatch } from "./pending";
import { isReadOnly } from "./presence";
import { type CanvasGet, type CanvasSet, type CanvasStore } from "./types";

export function createViewSlice(
  set: CanvasSet,
  _get: CanvasGet,
): Pick<
  CanvasStore,
  "arrangeNodes" | "redo" | "setViewport" | "setWhiteboard" | "undo"
> {
  return {
    /**
     * 平移 / 缩放不是编辑：既不进历史也不置 dirty，由 `save/autosave.ts`
     * 单独节流保存（§2.1）。
     *
     * 存储值一直是 React Flow 语义（`{x, y, zoom}` = 屏幕像素的平移量 +
     * 缩放，§3.4），所以这里没有任何换算。相机本来就在这儿（这次调用正是
     * 视口回调推过来的）就别再推回去，否则两边会互相追着走。
     */
    setViewport: (viewport) => {
      set((state) =>
        state.document
          ? {
              document: {
                ...state.document,
                board: { ...state.document.board, viewport },
              },
            }
          : state,
      );
      const flow = getFlow();
      if (!flow) return;
      const current = flow.getViewport();
      if (
        Math.abs(current.x - viewport.x) < 0.01 &&
        Math.abs(current.y - viewport.y) < 0.01 &&
        Math.abs(current.zoom - viewport.zoom) < 0.0001
      ) {
        return;
      }
      void flow.setViewport(viewport);
    },

    /**
     * 整块换掉白板文档：打开画布（`parseWhiteboard` 的结果）与保存变基走
     * `history: "ignore"`，白板层自己的动作（B2）走默认的记录。
     */
    setWhiteboard: (doc, options = {}) =>
      set((state) => {
        if (state.whiteboard === doc) return state;
        // 远端灌入（`history: "ignore"`）照收；本地的白板编辑在只读时不落。
        if ((options.history ?? "record") !== "ignore" && isReadOnly(state)) {
          return state;
        }
        const nodes = state.document?.nodes ?? [];
        const edges = state.document?.edges ?? [];
        const diff = diffSnapshots(
          {
            nodes,
            edges,
            items: state.whiteboard.items,
            references: state.whiteboard.references,
          },
          {
            nodes,
            edges,
            items: doc.items,
            references: doc.references,
          },
        );
        // 与 `internal.commit` 同理：远端合并要知道动过哪几条（`pending.ts`）。
        markPatch(diff.after);
        markPatch(diff.before);
        if ((options.history ?? "record") !== "ignore") {
          record({
            label: options.label ?? "whiteboard",
            before: diff.before,
            after: diff.after,
          });
        }
        return { whiteboard: doc, saveState: "dirty" };
      }),

    undo,
    redo,

    /**
     * 整理排布（§2.9 `canvas.tidy`）。算法在 `tidy.ts`，取矩形与提交在
     * `tidy-flow.ts`——那里一次提交，所以整理只留一条历史。
     */
    arrangeNodes: (options) => arrangeCanvas(options),
  };
}
