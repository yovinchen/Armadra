import { type Position } from "@armadra/shared";
import { getEditor } from "../../canvas/editor-context";
import { markPushed } from "../../canvas/sync/pushed";
import { tidyPositions } from "../../canvas/tidy";
import { arrangeEditorShapes } from "../../canvas/tidy-editor";
import { commit, now } from "./internal";
import { type CanvasGet, type CanvasSet, type CanvasStore } from "./types";

export function createViewSlice(
  set: CanvasSet,
  get: CanvasGet,
): Pick<
  CanvasStore,
  "arrangeNodes" | "redo" | "setViewport" | "setWhiteboard" | "undo"
> {
  return {
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
      const editor = getEditor();
      if (!editor) return;
      markPushed(get().document);
      const camera = editor.getCamera();
      const zoom = viewport.zoom || 1;
      const next = { x: viewport.x / zoom, y: viewport.y / zoom, z: zoom };
      // 相机本来就在这儿（这次调用正是相机推过来的）就别再推回去，否则两边
      // 会互相追着走。
      if (
        Math.abs(camera.x - next.x) < 0.01 &&
        Math.abs(camera.y - next.y) < 0.01 &&
        Math.abs(camera.z - next.z) < 0.0001
      ) {
        return;
      }
      editor.setCamera(next, { immediate: true });
    },

    setWhiteboard: (snapshot) =>
      set((state) => {
        if (!state.document || state.document.board.whiteboard === snapshot) {
          return state;
        }
        return {
          document: {
            ...state.document,
            board: { ...state.document.board, whiteboard: snapshot },
          },
          saveState: "dirty",
        };
      }),

    // 撤销栈归 editor（§9.3）：画布没挂载时是安全的空操作。
    undo: () => {
      getEditor()?.undo();
    },

    redo: () => {
      getEditor()?.redo();
    },

    arrangeNodes: (options) => {
      const editor = getEditor();
      if (editor) {
        // Native shapes live only in the editor's whiteboard snapshot. Mutate the
        // complete scene once and let use-store-sync publish its document mirror.
        arrangeEditorShapes(editor, options);
        return;
      }
      let positions: Record<string, Position> = {};
      set((state) => {
        if (!state.document) return state;
        positions = tidyPositions(
          state.document.nodes,
          state.document.edges,
          options,
        );
        const patch = commit(state, (document) => {
          let changed = false;
          const nodes = document.nodes.map((node) => {
            const position = positions[node.id];
            if (!position) return node;
            if (
              position.x === node.position.x &&
              position.y === node.position.y
            ) {
              return node;
            }
            changed = true;
            return { ...node, position, updatedAt: now() };
          });
          return changed ? { ...document, nodes } : null;
        });
        return patch ?? state;
      });
    },
  };
}
