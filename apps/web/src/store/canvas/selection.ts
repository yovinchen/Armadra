import { type CanvasGet, type CanvasSet, type CanvasStore } from "./types";

/**
 * 选区（React Flow 计划 §2.8）。
 *
 * store 是唯一真相：投影时把 `selected` 写到 React Flow 的节点 / 边上
 * （`sync/project.ts`），用户在画布上改选区时 `onSelectionChange` 调
 * `setSelection` 一次写三项。旧引擎那条「编辑器 ⇄ store 双向」的
 * 环路整个消失了。
 */

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => b[index] === id);
}

export function createSelectionSlice(
  set: CanvasSet,
  _get: CanvasGet,
): Pick<CanvasStore, "selectNodes" | "setSelection" | "setFocusNode"> {
  return {
    /**
     * 只改节点那一半。边与白板对象原样留着——「一个终端 + 一条边 + 一个
     * 矩形」的混合多选不该被侧栏点一行挤掉。
     */
    selectNodes: (ids) =>
      set((state) => {
        const known = new Set(
          state.document?.nodes.map((node) => node.id) ?? [],
        );
        const deduped = [...new Set(ids)].filter((id) => known.has(id));
        if (same(deduped, state.selectedNodeIds)) return state;
        return { selectedNodeIds: deduped };
      }),

    setSelection: (selection) =>
      set((state) => {
        const known = new Set(
          state.document?.nodes.map((node) => node.id) ?? [],
        );
        const nodes = selection.nodes
          ? [...new Set(selection.nodes)].filter((id) => known.has(id))
          : state.selectedNodeIds;
        const edges = selection.edges
          ? [...new Set(selection.edges)]
          : state.selectedEdgeIds;
        const items = selection.items
          ? [...new Set(selection.items)]
          : state.selectedItemIds;
        if (
          same(nodes, state.selectedNodeIds) &&
          same(edges, state.selectedEdgeIds) &&
          same(items, state.selectedItemIds)
        ) {
          return state;
        }
        return {
          selectedNodeIds: nodes,
          selectedEdgeIds: edges,
          selectedItemIds: items,
        };
      }),

    setFocusNode: (focusNodeId) => set({ focusNodeId }),
  };
}
