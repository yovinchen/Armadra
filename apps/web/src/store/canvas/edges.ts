import { type CanvasEdge } from "@armadra/shared";
import { commit, now } from "./internal";
import { type CanvasGet, type CanvasSet, type CanvasStore } from "./types";

export function createEdgesSlice(
  set: CanvasSet,
  get: CanvasGet,
): Pick<
  CanvasStore,
  "addEdge" | "removeEdges" | "setEdgeRole" | "reverseEdge"
> {
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

    /**
     * 对等还是主从（`source` 是主）。
     *
     * 单独一个动作而不是 `addEdge` 的第三个参数：角色是人在命名对话框里回答的
     * 第二个问题，而边在那之前就已经建立了——连线不该等一个可以跳过的对话框。
     */
    setEdgeRole: (id, role) => {
      set((state) => {
        const patch = commit(state, (document) => {
          const edge = document.edges.find((entry) => entry.id === id);
          if (!edge || edge.role === role) return null;
          const stamp = now();
          return {
            ...document,
            edges: document.edges.map((entry) =>
              entry.id === id ? { ...entry, role, updatedAt: stamp } : entry,
            ),
          };
        });
        return patch ?? state;
      });
    },

    /**
     * 掉头：把 `source` 与 `target` 换个个儿，边 id 不变。
     *
     * 主从边是画布上唯一一条有方向的关系，而方向今天由「当时往哪个方向拖」
     * 决定。拖反了不该只能删线重连——那会连带丢掉这条边上的一切（id 换了，
     * 投递记录与选区都跟着断）。所以换的是两端，不是这条边。
     *
     * `role` 一起传进来时在**同一次提交**里落：菜单里那一项（「设为 从 ← 主」）
     * 是人眼里的一个动作，撤销也该是一步。
     */
    reverseEdge: (id, role) => {
      set((state) => {
        const patch = commit(state, (document) => {
          const edge = document.edges.find((entry) => entry.id === id);
          if (!edge) return null;
          const stamp = now();
          return {
            ...document,
            edges: document.edges.map((entry) =>
              entry.id === id
                ? {
                    ...entry,
                    source: edge.target,
                    target: edge.source,
                    ...(role === undefined ? {} : { role }),
                    updatedAt: stamp,
                  }
                : entry,
            ),
          };
        });
        return patch ?? state;
      });
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
