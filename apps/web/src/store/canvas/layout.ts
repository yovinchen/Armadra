import { type CanvasNode, type Size } from "@armadra/shared";
import { COLLAPSED_HEIGHT, defaultNodeSize } from "../defaults";
import { commit, now, shapeOf, updateNodeShape, withEditor } from "./internal";
import {
  type CanvasGet,
  type CanvasSet,
  type CanvasStore,
  type PremaxRect,
} from "./types";

export function createLayoutSlice(
  set: CanvasSet,
  get: CanvasGet,
): Pick<
  CanvasStore,
  "maximizeNode" | "moveNodes" | "resizeNode" | "restoreNode" | "setCollapsed"
> {
  return {
    moveNodes: (moves) => {
      let applied = false;
      set((state) => {
        if (moves.length === 0) return state;
        const byId = new Map(moves.map((move) => [move.id, move.position]));
        const patch = commit(state, (document) => {
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
        });
        applied = patch !== null;
        return patch ?? state;
      });
      if (!applied) return;
      withEditor((editor) => {
        editor.updateShapes(
          moves
            .map((move) => {
              const shape = shapeOf(editor, move.id);
              if (!shape) return null;
              return {
                id: shape.id,
                type: shape.type,
                x: move.position.x,
                y: move.position.y,
              };
            })
            .filter((partial) => partial !== null),
        );
      });
    },

    resizeNode: (id, size, position) => {
      let target: CanvasNode | undefined;
      set((state) => {
        const patch = commit(state, (document) => {
          let changed = false;
          const nodes = document.nodes.map((node) => {
            if (node.id !== id) return node;
            changed = true;
            target = node;
            return {
              ...node,
              size,
              ...(position ? { position } : {}),
              // 手动调整高度即是新的“展开高度”，折叠再展开要回到这里
              ...(node.collapsed ? {} : { expandedHeight: size.height }),
              updatedAt: now(),
            };
          });
          return changed ? { ...document, nodes } : null;
        });
        return patch ?? state;
      });
      if (!target) return;
      const collapsed = target.collapsed ?? false;
      withEditor((editor) =>
        updateNodeShape(editor, target!, {
          size,
          ...(position ? { position } : {}),
          ...(collapsed ? {} : { expandedHeight: size.height }),
        }),
      );
    },

    setCollapsed: (id, collapsed) => {
      let next: { size: Size; expandedHeight?: number } | null = null;
      set((state) => {
        if (!state.document) return state;
        let changed = false;
        const nodes = state.document.nodes.map((node) => {
          if (node.id !== id || node.collapsed === collapsed) return node;
          changed = true;
          const height = node.size?.height ?? defaultNodeSize(node.type).height;
          const width = node.size?.width ?? defaultNodeSize(node.type).width;
          if (collapsed) {
            // The visible size is authoritative after native canvas resizing.
            const expandedHeight = height;
            next = {
              size: { width, height: COLLAPSED_HEIGHT },
              expandedHeight,
            };
            return {
              ...node,
              collapsed: true,
              expandedHeight,
              size: next.size,
              updatedAt: now(),
            };
          }
          next = {
            size: {
              width,
              height: node.expandedHeight ?? defaultNodeSize(node.type).height,
            },
          };
          return {
            ...node,
            collapsed: false,
            size: next.size,
            updatedAt: now(),
          };
        });
        if (!changed) return state;
        return { document: { ...state.document, nodes }, saveState: "dirty" };
      });
      if (!next) return;
      const applied = next as { size: Size; expandedHeight?: number };
      withEditor((editor) => {
        const node = get().document?.nodes.find((item) => item.id === id);
        if (!node) return;
        updateNodeShape(editor, node, {
          collapsed,
          size: applied.size,
          ...(applied.expandedHeight !== undefined
            ? { expandedHeight: applied.expandedHeight }
            : {}),
        });
      });
    },

    maximizeNode: (id, rect) => {
      let applied = false;
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
        applied = true;
        return {
          maximized: { ...state.maximized, [id]: premax },
          document: {
            ...state.document,
            nodes: state.document.nodes.map((item) =>
              item.id === id
                ? {
                    ...item,
                    // 最大化的节点必须脱离组框，否则会被 frame 裁掉
                    parentId: undefined,
                    collapsed: false,
                    position: { x: rect.x, y: rect.y },
                    size: { width: rect.width, height: rect.height },
                    updatedAt: now(),
                  }
                : item,
            ),
          },
          saveState: "dirty",
        };
      });
      if (!applied) return;
      withEditor((editor) => {
        const shape = shapeOf(editor, id);
        if (!shape) return;
        editor.reparentShapes([shape.id], editor.getCurrentPageId());
        const node = get().document?.nodes.find((item) => item.id === id);
        if (!node) return;
        updateNodeShape(editor, node, {
          collapsed: false,
          position: { x: rect.x, y: rect.y },
          size: { width: rect.width, height: rect.height },
        });
      });
    },

    restoreNode: (id) => {
      let premax: PremaxRect | undefined;
      set((state) => {
        premax = state.maximized[id];
        if (!state.document || !premax) return state;
        const { [id]: _dropped, ...maximized } = state.maximized;
        const restored = premax;
        return {
          maximized,
          document: {
            ...state.document,
            nodes: state.document.nodes.map((item) =>
              item.id === id
                ? {
                    ...item,
                    parentId: restored.parentId,
                    position: { x: restored.x, y: restored.y },
                    size: { width: restored.width, height: restored.height },
                    updatedAt: now(),
                  }
                : item,
            ),
          },
          saveState: "dirty",
        };
      });
      if (!premax) return;
      const rect = premax as PremaxRect;
      withEditor((editor) => {
        const shape = shapeOf(editor, id);
        if (!shape) return;
        if (rect.parentId) {
          const parent = shapeOf(editor, rect.parentId);
          if (parent) editor.reparentShapes([shape.id], parent.id);
        }
        const node = get().document?.nodes.find((item) => item.id === id);
        if (!node) return;
        updateNodeShape(editor, node, {
          position: { x: rect.x, y: rect.y },
          size: { width: rect.width, height: rect.height },
        });
      });
    },
  };
}
