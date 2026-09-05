import { getEditor } from "../../canvas/editor-context";
import {
  isDocumentShapeId,
  toShapeId,
} from "../../canvas/shapes/armadra-shape";
import { type CanvasGet, type CanvasSet, type CanvasStore } from "./types";

export function createSelectionSlice(
  set: CanvasSet,
  get: CanvasGet,
): Pick<CanvasStore, "selectNodes" | "setFocusNode"> {
  return {
    selectNodes: (ids) => {
      let next: string[] | null = null;
      set((state) => {
        const known = new Set(
          state.document?.nodes.map((node) => node.id) ?? [],
        );
        const deduped = [...new Set(ids)].filter((id) => known.has(id));
        const same =
          deduped.length === state.selectedNodeIds.length &&
          deduped.every((id, index) => state.selectedNodeIds[index] === id);
        if (same) return state;
        next = deduped;
        return { selectedNodeIds: deduped };
      });
      if (!next) return;
      const editor = getEditor();
      if (!editor) return;
      /*
       * 只投影「节点」那一半（Phase 2 待办 3）。选中项里的边与白板 shape
       * 原样留着——`selectedNodeIds` 仍然只装节点，但画布上「一个终端 +
       * 一条边 + 一个矩形」的混合多选不会被这一步挤掉。
       */
      const current = editor.getSelectedShapeIds();
      // 边的 arrow 也有 uuid 形状的 id，所以「是不是节点」要连类型一起看。
      const kept = editor
        .getSelectedShapes()
        .filter(
          (shape) => shape.type === "arrow" || !isDocumentShapeId(shape.id),
        )
        .map((shape) => shape.id);
      const wanted = [...(next as string[]).map(toShapeId), ...kept];
      const same =
        current.length === wanted.length &&
        wanted.every((id) => current.includes(id));
      if (same) return;
      editor.run(() => editor.select(...wanted), { history: "ignore" });
    },
    setFocusNode: (focusNodeId) => set({ focusNodeId }),
  };
}
