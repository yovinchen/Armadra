import { type Size } from "@armadra/shared";
import { COLLAPSED_HEIGHT, defaultNodeSize } from "../defaults";
import { commit, now } from "./internal";
import {
  type CanvasGet,
  type CanvasSet,
  type CanvasStore,
  type PremaxRect,
} from "./types";

export function createLayoutSlice(
  set: CanvasSet,
  _get: CanvasGet,
): Pick<
  CanvasStore,
  "maximizeNode" | "moveNodes" | "resizeNode" | "restoreNode" | "setCollapsed"
> {
  return {
    moveNodes: (moves) => {
      set((state) => {
        if (moves.length === 0) return state;
        const byId = new Map(moves.map((move) => [move.id, move.position]));
        const patch = commit(
          state,
          (document) => {
            let changed = false;
            const nodes = document.nodes.map((node) => {
              const position = byId.get(node.id);
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
          },
          { label: "move" },
        );
        return patch ?? state;
      });
    },

    resizeNode: (id, size, position) => {
      set((state) => {
        const patch = commit(
          state,
          (document) => {
            let changed = false;
            const nodes = document.nodes.map((node) => {
              if (node.id !== id) return node;
              changed = true;
              return {
                ...node,
                size,
                ...(position ? { position } : {}),
                // 手动调整高度即是新的「展开高度」，折叠再展开要回到这里
                ...(node.collapsed ? {} : { expandedHeight: size.height }),
                updatedAt: now(),
              };
            });
            return changed ? { ...document, nodes } : null;
          },
          { label: "resize" },
        );
        return patch ?? state;
      });
    },

    setCollapsed: (id, collapsed) => {
      set((state) => {
        const patch = commit(
          state,
          (document) => {
            let changed = false;
            const nodes = document.nodes.map((node) => {
              if (node.id !== id || node.collapsed === collapsed) return node;
              changed = true;
              const height =
                node.size?.height ?? defaultNodeSize(node.type).height;
              const width =
                node.size?.width ?? defaultNodeSize(node.type).width;
              if (collapsed) {
                // 可见尺寸是权威：折叠前那一刻的高度就是「展开高度」。
                return {
                  ...node,
                  collapsed: true,
                  expandedHeight: height,
                  size: { width, height: COLLAPSED_HEIGHT } as Size,
                  updatedAt: now(),
                };
              }
              return {
                ...node,
                collapsed: false,
                size: {
                  width,
                  height:
                    node.expandedHeight ?? defaultNodeSize(node.type).height,
                } as Size,
                updatedAt: now(),
              };
            });
            return changed ? { ...document, nodes } : null;
          },
          { label: "collapse" },
        );
        return patch ?? state;
      });
    },

    maximizeNode: (id, rect) => {
      set((state) => {
        if (!state.document || state.maximized[id]) return state;
        const node = state.document.nodes.find((item) => item.id === id);
        if (!node) return state;
        const size = node.size ?? defaultNodeSize(node.type);
        const premax: PremaxRect = {
          x: node.position.x,
          y: node.position.y,
          width: size.width,
          height: size.height,
          ...(node.parentId ? { parentId: node.parentId } : {}),
        };
        const patch = commit(
          state,
          (document) => ({
            ...document,
            nodes: document.nodes.map((item) =>
              item.id === id
                ? {
                    ...item,
                    // 最大化的节点脱离组框：组员坐标是相对的，铺满视口时
                    // 再挂着父级只会让还原之后的位置对不上。
                    parentId: undefined,
                    collapsed: false,
                    position: { x: rect.x, y: rect.y },
                    size: { width: rect.width, height: rect.height },
                    updatedAt: now(),
                  }
                : item,
            ),
          }),
          { label: "maximize" },
        );
        if (!patch) return state;
        // `premaxRect` 不进历史（§2.7）：它是面板状态，不是画布内容。
        return { ...patch, maximized: { ...state.maximized, [id]: premax } };
      });
    },

    restoreNode: (id) => {
      set((state) => {
        const premax = state.maximized[id];
        if (!premax) return state;
        const patch = commit(
          state,
          (document) => ({
            ...document,
            nodes: document.nodes.map((item) =>
              item.id === id
                ? {
                    ...item,
                    parentId: premax.parentId,
                    position: { x: premax.x, y: premax.y },
                    size: { width: premax.width, height: premax.height },
                    updatedAt: now(),
                  }
                : item,
            ),
          }),
          { label: "restore" },
        );
        if (!patch) return state;
        const { [id]: _dropped, ...maximized } = state.maximized;
        return { ...patch, maximized };
      });
    },
  };
}
