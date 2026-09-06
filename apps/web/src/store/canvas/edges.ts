import { type CanvasEdge } from "@armadra/shared";
import { commit, now } from "./internal";
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
      return edge.id;
    },

    removeEdges: (ids) => {
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
        return patch ?? state;
      });
    },
  };
}
