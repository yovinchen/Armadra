import * as React from "react";
import { type CanvasEdge } from "@armadra/shared";
import { edgeIdOfShape } from "../../canvas/sync/derive";
import { edgeToLink } from "../../canvas/sync/project";
import { commit, now, withEditor } from "./internal";
import { type CanvasGet, type CanvasSet, type CanvasStore } from "./types";

export function createEdgesSlice(
  set: CanvasSet,
  get: CanvasGet,
): Pick<CanvasStore, "addEdge" | "removeEdges"> {
  return {
    addEdge: (source, target) => {
      const state = get();
      if (!state.document || source === target) return null;
      const nodes = state.document.nodes;
      const from = nodes.find((node) => node.id === source);
      const to = nodes.find((node) => node.id === target);
      if (!from || !to) return null;
      // 方向按用户拖的来（§21）：任意两个节点都能连，箭头由两端的类型决定
      // （`sync/project.edgeArrowheads`），文档里只记谁连了谁。
      const duplicate = state.document.edges.some(
        (edge) =>
          (edge.source === from.id && edge.target === to.id) ||
          (edge.source === to.id && edge.target === from.id),
      );
      if (duplicate) return null;

      const stamp = now();
      const edge: CanvasEdge = {
        id: crypto.randomUUID(),
        boardId: state.document.board.id,
        source: from.id,
        target: to.id,
        kind: "link",
        createdAt: stamp,
        updatedAt: stamp,
      };
      const patch = commit(state, (document) => ({
        ...document,
        edges: [...document.edges, edge],
      }));
      if (!patch) return null;
      set(patch);
      withEditor((editor) => {
        const projection = edgeToLink(edge, nodes, editor.getCurrentPageId());
        if (!projection) return;
        editor.createShape(projection.shape);
        for (const binding of projection.bindings)
          editor.createBinding(binding);
        // 线走在节点下面（与 `shapes/LinkArrow.ts` 的换形一致）。
        editor.sendToBack([projection.shape.id]);
      });
      return edge.id;
    },

    removeEdges: (ids) => {
      let applied = false;
      set((state) => {
        const doomed = new Set(ids);
        if (doomed.size === 0) return state;
        const patch = commit(state, (document) =>
          document.edges.some((edge) => doomed.has(edge.id))
            ? {
                ...document,
                edges: document.edges.filter((edge) => !doomed.has(edge.id)),
              }
            : null,
        );
        applied = patch !== null;
        return patch ?? state;
      });
      if (!applied) return;
      withEditor((editor) => {
        // 「什么算边」只有 `sync/derive.edgeIdOfShape` 一处定义。
        const wanted = new Set(ids);
        const doomed = editor
          .getCurrentPageShapes()
          .filter((shape) => {
            const id = edgeIdOfShape(shape);
            return id !== null && wanted.has(id);
          })
          .map((shape) => shape.id);
        if (doomed.length > 0) editor.deleteShapes(doomed);
      });
    },

    /**
     * 平移/缩放不是编辑：既不进历史也不置 dirty，由 save/autosave.ts 节流保存。
     *
     * React Flow 的 `{x,y,zoom}` 与 tldraw 的相机 `{x,y,z}` 差一个缩放因子：
     * 前者是「屏幕像素的平移量」，后者是「页面坐标的平移量」。
     */
  };
}
