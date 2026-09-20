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

/**
 * 内容没变就还给**上一份数组**。
 *
 * `setSelection` 一次写三项，三项里只要有一项真的变了就得 `set`，另外两项
 * 以前会把调用方新造的数组原样存进去——内容一模一样，身份却换了。画布的投影
 * 按身份记忆（`flow/use-flow-nodes.ts`），于是「只选中一条边」也会换掉整张
 * 节点表的身份，React Flow 的 `StoreUpdater` 跟着多调一次 `setNodes`。
 *
 * 那一次多余的 `setNodes` 会踩进一个真实的死循环：`StoreUpdater` 在同一个
 * effect 里先 `setNodes` 再 `setEdges`，而 React Flow 的选区监听器是在
 * `setNodes` 里**同步**发出的——那一刻边还是上一帧的。`onSelectionChange`
 * 于是把「节点新 + 边旧」这个半成品写回来，下一帧投影又把它翻回去，两个值
 * 来回弹，React 报 `Maximum update depth exceeded`，整页白屏。
 * 复现：框选一个连着边的节点（便签 → 终端）。
 */
function keep<T extends readonly string[]>(next: T, previous: T): T {
  return same(next, previous) ? previous : next;
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
          selectedNodeIds: keep(nodes, state.selectedNodeIds),
          selectedEdgeIds: keep(edges, state.selectedEdgeIds),
          selectedItemIds: keep(items, state.selectedItemIds),
        };
      }),

    setFocusNode: (focusNodeId) => set({ focusNodeId }),
  };
}
