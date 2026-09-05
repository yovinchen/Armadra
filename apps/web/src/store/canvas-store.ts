import * as React from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Editor, TLShape, TLShapeId } from "tldraw";
import type {
  BoardDocument,
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  Position,
  Size,
  Viewport,
  Workspace,
} from "@armadra/shared";
import {
  COLLAPSED_HEIGHT,
  defaultNodeColor,
  defaultNodeData,
  defaultNodeSize,
  defaultNodeTitle,
} from "./defaults";
import { usePreferencesStore } from "../app/preferences-store";
import { getEditor, useEditorHandle } from "../canvas/editor-context";
import { isDocumentShapeId, toShapeId } from "../canvas/shapes/armadra-shape";
import { edgeIdOfShape } from "../canvas/sync/derive";
import { edgeToLink, nodeToShape, toTldrawColor } from "../canvas/sync/project";
import { markPushed } from "../canvas/sync/pushed";
import { tidyPositions } from "../canvas/tidy";
import { normaliseLabels } from "../meta/model";

/**
 * 画布状态 —— docs/tldraw-canvas-plan.md §3 / §9.3。
 *
 * v4 的两条规则：
 *
 *  1. **tldraw store 是内存真相。** 每个动作都写两处：先照旧改 `document`
 *     （45 个消费方要求「调完就能读到」，异步派生做不到），再把同一件事做到
 *     editor 上。随后 `sync/use-store-sync.ts` 从 editor 反向派生出文档；
 *     内容一致时它什么也不做，所以不会来回抖。
 *  2. **撤销栈归 editor。** `history` 字段已删除，`undo/redo` 转调
 *     `editor.undo()/redo()`；画布没挂载（启动页、单测）时是安全的空操作。
 *
 * `setViewport` 仍然既不置 dirty 也不进历史，由 `save/autosave.ts` 单独节流。
 */

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export interface BoardBrief {
  id: string;
  name: string;
  sortOrder: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 最大化前的矩形。最大化会把节点临时移出组框（frame 会裁剪子级），
 * 所以还原时也要把 `parentId` 装回去。
 */
export interface PremaxRect extends Rect {
  parentId?: string;
}

export interface PanelState {
  /** 左侧 docked 侧栏（§20「左侧栏」）。折叠时宽 0，画布自己铺满。 */
  sidebar: "open" | "collapsed";
  explorer: "closed" | "drawer" | "pinned";
  scm: "closed" | "drawer";
  settings: boolean;
  palette: boolean;
}

export interface AddNodeOptions {
  position?: Position;
  title?: string;
  color?: string;
  size?: Size;
  data?: Partial<CanvasNodeData>;
  parentId?: string;
  /** 默认 true：新建的节点立刻成为唯一选中项。 */
  select?: boolean;
}

export interface CanvasState {
  workspace: Workspace | null;
  boards: BoardBrief[];
  boardId: string | null;
  document: BoardDocument | null;
  selectedNodeIds: string[];
  focusNodeId: string | null;
  /** 最大化之前的矩形，按节点 id 记；`restoreNode` 用它还原。 */
  maximized: Record<string, PremaxRect>;
  panels: PanelState;
  saveState: SaveState;
  saveError: string | null;
}

export interface CanvasActions {
  setWorkspace: (workspace: Workspace | null) => void;
  setBoards: (boards: BoardBrief[]) => void;
  selectBoard: (boardId: string | null) => void;
  setDocument: (document: BoardDocument) => void;
  setSaveState: (state: SaveState) => void;
  setSaveError: (message: string | null) => void;
  setPanel: <K extends keyof PanelState>(key: K, value: PanelState[K]) => void;

  selectNodes: (ids: string[]) => void;
  addNode: (type: CanvasNodeType, options?: AddNodeOptions) => string;
  updateNode: (
    id: string,
    patch: Partial<Omit<CanvasNode, "id" | "type" | "data">>,
  ) => void;
  updateNodeData: (id: string, patch: Partial<CanvasNodeData>) => void;
  /** 节点标签（看板卡片上的 chip）。 */
  setNodeLabels: (id: string, labels: string[]) => void;
  /** 节点批注（头部「评论」）。 */
  setNodeNote: (id: string, note: string) => void;
  moveNodes: (moves: { id: string; position: Position }[]) => void;
  resizeNode: (id: string, size: Size, position?: Position) => void;
  setCollapsed: (id: string, collapsed: boolean) => void;
  /** `rect` 由画布算（视口减 24px 边距），store 只负责记 premaxRect。 */
  maximizeNode: (id: string, rect: Rect) => void;
  restoreNode: (id: string) => void;
  setFocusNode: (id: string | null) => void;
  setParent: (ids: string[], parentId: string | null) => void;
  removeNodes: (ids: string[]) => void;
  duplicateNodes: (ids: string[]) => string[];
  addEdge: (source: string, target: string) => string | null;
  removeEdges: (ids: string[]) => void;
  setViewport: (viewport: Viewport) => void;
  /** 白板快照（tldraw 计划 §6.1）；跟着看板文档一起保存。 */
  setWhiteboard: (snapshot: string) => void;
  undo: () => void;
  redo: () => void;
  /** `options.aspect` 是当前视口宽高比（§23）；缺省时按 16:9 裹。 */
  arrangeNodes: (options?: { aspect?: number }) => void;
}

export type CanvasStore = CanvasState & CanvasActions;

const emptyBoardState = {
  document: null,
  selectedNodeIds: [] as string[],
  focusNodeId: null,
  maximized: {} as Record<string, PremaxRect>,
  saveState: "idle" as SaveState,
  saveError: null,
};

const initialPanels: PanelState = {
  sidebar: usePreferencesStore.getState().sidebarOpen ? "open" : "collapsed",
  explorer: "closed",
  scm: "closed",
  settings: false,
  palette: false,
};

function now(): string {
  return new Date().toISOString();
}

/** 结构性改动的统一入口：改文档 → 置 dirty。撤销栈已经归 editor。 */
function commit(
  state: CanvasStore,
  mutate: (document: BoardDocument) => BoardDocument | null,
): Partial<CanvasStore> | null {
  if (!state.document) return null;
  const next = mutate(state.document);
  if (!next) return null;
  return { document: next, saveState: "dirty" };
}

/* --------------------------------- 几何辅助 -------------------------------- */

/** 子节点位置是相对父组的；这里换算成画布绝对坐标。 */
export function absolutePosition(
  nodes: readonly CanvasNode[],
  node: CanvasNode,
  depth = 0,
): Position {
  if (!node.parentId || depth > 8) return node.position;
  const parent = nodes.find((candidate) => candidate.id === node.parentId);
  if (!parent) return node.position;
  const base = absolutePosition(nodes, parent, depth + 1);
  return { x: base.x + node.position.x, y: base.y + node.position.y };
}

/* ------------------------------- editor 桥 -------------------------------- */

/**
 * 把一件事同时做到 editor 上。画布没挂载时返回 false，调用方照旧只改文档。
 *
 * 所有写入都包在 `editor.run` 里：一次动作 = 一条撤销记录，和 React Flow
 * 时代「一次拖拽只留一条历史」的语义一致。
 */
function withEditor(run: (editor: Editor) => void): boolean {
  const editor = getEditor();
  if (!editor) return false;
  editor.run(() => run(editor));
  // 这份文档已经原样做到 editor 上了，`use-store-sync` 不必再整块投影回去
  // （否则每敲一个字都要把整块看板重新映射一遍）。
  markPushed(useCanvasStore.getState().document);
  return true;
}

function shapeOf(editor: Editor, nodeId: string): TLShape | undefined {
  return editor.getShape(toShapeId(nodeId));
}

/** 节点的一次属性改动 → shape 的一次 `updateShapes`（frame 与 armadra 不同槽）。 */
function updateNodeShape(
  editor: Editor,
  node: CanvasNode,
  patch: Partial<Omit<CanvasNode, "id" | "type" | "data">>,
  data?: Partial<CanvasNodeData>,
): void {
  const shape = shapeOf(editor, node.id);
  if (!shape) return;
  const geometry = {
    ...(patch.position ? { x: patch.position.x, y: patch.position.y } : {}),
  };

  if (shape.type === "frame") {
    const meta = (shape.meta.armadra ?? {}) as Record<string, unknown>;
    // `updateShapes` 的入参类型按 shape 类型收敛，而这里是按运行时分支写的，
    // 所以只能整条断言掉；字段名由上面的 `nodeToShape` 保证。
    editor.updateShapes([
      {
        id: shape.id,
        type: "frame",
        ...geometry,
        props: {
          ...(patch.title !== undefined ? { name: patch.title } : {}),
          ...(patch.color !== undefined
            ? { color: toTldrawColor(patch.color) }
            : {}),
          ...(patch.size ? { w: patch.size.width, h: patch.size.height } : {}),
        },
        meta: {
          armadra: {
            ...meta,
            ...(patch.color !== undefined ? { color: patch.color } : {}),
            ...(patch.labels !== undefined ? { labels: patch.labels } : {}),
            ...(patch.note !== undefined ? { note: patch.note } : {}),
            ...(patch.collapsed !== undefined
              ? { collapsed: patch.collapsed }
              : {}),
          },
        },
      } as never,
    ]);
    return;
  }

  const props: Record<string, unknown> = {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.collapsed !== undefined ? { collapsed: patch.collapsed } : {}),
    ...(patch.expandedHeight !== undefined
      ? { expandedHeight: patch.expandedHeight }
      : {}),
    ...(patch.labels !== undefined ? { labels: patch.labels } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(patch.size ? { w: patch.size.width, h: patch.size.height } : {}),
    ...(data
      ? {
          data: {
            ...(shape.props as { data: CanvasNodeData }).data,
            ...data,
          },
        }
      : {}),
  };
  editor.updateShapes([
    { id: shape.id, type: "armadra", ...geometry, props } as never,
  ]);
}

/** 新建一批节点 shape：组员的父 frame 必须先在，所以分组排在前面。 */
function createNodeShapes(editor: Editor, nodes: readonly CanvasNode[]): void {
  const page = editor.getCurrentPageId();
  const ordered = [...nodes].sort((a, b) =>
    a.type === b.type ? 0 : a.type === "group" ? -1 : 1,
  );
  for (const node of ordered) {
    editor.createShape(nodeToShape(node, page));
  }
}

/* ----------------------------------- store -------------------------------- */

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  workspace: null,
  boards: [],
  boardId: null,
  panels: initialPanels,
  ...emptyBoardState,

  setWorkspace: (workspace) =>
    set((state) =>
      state.workspace?.id === workspace?.id
        ? { workspace }
        : { workspace, boards: [], boardId: null, ...emptyBoardState },
    ),

  setBoards: (boards) =>
    set((state) => {
      const sorted = [...boards].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      );
      if (sorted.some((board) => board.id === state.boardId)) {
        return { boards: sorted };
      }
      return {
        boards: sorted,
        boardId: sorted[0]?.id ?? null,
        ...emptyBoardState,
      };
    }),

  selectBoard: (boardId) =>
    set((state) =>
      state.boardId === boardId ? { boardId } : { boardId, ...emptyBoardState },
    ),

  setDocument: (document) =>
    set({
      ...emptyBoardState,
      document,
      boardId: document.board.id,
      saveState: "saved",
    }),

  setSaveState: (saveState) => set({ saveState }),
  setSaveError: (saveError) => set({ saveError }),

  /**
   * 侧栏是唯一跨会话记住开合的面板，所以这里顺手写进偏好；
   * 其余面板都是「开着不留痕」。
   */
  setPanel: (key, value) => {
    if (key === "sidebar") {
      usePreferencesStore.getState().setSidebarOpen(value === "open");
    }
    set((state) => ({ panels: { ...state.panels, [key]: value } }));
  },

  /**
   * 选中态与 editor 双向同步。
   *
   * 只在「真的不一样」时才回写 editor：`use-store-sync` 会把 editor 的选中
   * 变化推回这里，两边只要有一次内容相同但数组身份不同，就会互相触发到
   * React 抛「Maximum update depth exceeded」（React Flow 时代踩过一次）。
   */
  selectNodes: (ids) => {
    let next: string[] | null = null;
    set((state) => {
      const known = new Set(state.document?.nodes.map((node) => node.id) ?? []);
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

  addNode: (type, options = {}) => {
    const state = get();
    if (!state.document) return "";
    const id = crypto.randomUUID();
    const stamp = now();
    const index = state.document.nodes.length;
    const base = defaultNodeData(type, {
      workspaceRoot: state.workspace?.rootPath,
    });
    const node = {
      id,
      boardId: state.document.board.id,
      type,
      title: options.title ?? defaultNodeTitle(type),
      color: options.color ?? defaultNodeColor(type),
      position: options.position ?? { x: 80 + index * 24, y: 80 + index * 24 },
      size: options.size ?? defaultNodeSize(type),
      ...(options.parentId ? { parentId: options.parentId } : {}),
      labels: [],
      note: "",
      data: { ...base, ...options.data, kind: type },
      createdAt: stamp,
      updatedAt: stamp,
    } as CanvasNode;

    const patch = commit(state, (document) => ({
      ...document,
      nodes: [...document.nodes, node],
    }));
    if (!patch) return "";
    const select = options.select ?? true;
    set({ ...patch, ...(select ? { selectedNodeIds: [id] } : {}) });
    withEditor((editor) => {
      createNodeShapes(editor, [node]);
      if (select) editor.select(toShapeId(id));
    });
    return id;
  },

  updateNode: (id, patch) => {
    let target: CanvasNode | undefined;
    set((state) => {
      if (!state.document) return state;
      let changed = false;
      const nodes = state.document.nodes.map((node) => {
        if (node.id !== id) return node;
        changed = true;
        target = node;
        return { ...node, ...patch, updatedAt: now() } as CanvasNode;
      });
      if (!changed) return state;
      return { document: { ...state.document, nodes }, saveState: "dirty" };
    });
    if (target) {
      withEditor((editor) => updateNodeShape(editor, target!, patch));
    }
  },

  updateNodeData: (id, patch) => {
    let target: CanvasNode | undefined;
    set((state) => {
      if (!state.document) return state;
      let changed = false;
      const nodes = state.document.nodes.map((node) => {
        if (node.id !== id) return node;
        changed = true;
        target = node;
        return {
          ...node,
          data: { ...node.data, ...patch, kind: node.data.kind },
          updatedAt: now(),
        } as CanvasNode;
      });
      if (!changed) return state;
      return { document: { ...state.document, nodes }, saveState: "dirty" };
    });
    if (target) {
      withEditor((editor) => updateNodeShape(editor, target!, {}, patch));
    }
  },

  // 标签与批注不是画布的结构性改动，但要置 dirty，跟着看板文档一起保存。
  setNodeLabels: (id, labels) => {
    const next = normaliseLabels(labels);
    let target: CanvasNode | undefined;
    set((state) => {
      if (!state.document) return state;
      let changed = false;
      const nodes = state.document.nodes.map((node) => {
        if (node.id !== id) return node;
        const current = node.labels ?? [];
        if (
          current.length === next.length &&
          current.every((label, index) => label === next[index])
        ) {
          return node;
        }
        changed = true;
        target = node;
        return { ...node, labels: next, updatedAt: now() } as CanvasNode;
      });
      if (!changed) return state;
      return { document: { ...state.document, nodes }, saveState: "dirty" };
    });
    if (target) {
      withEditor((editor) =>
        updateNodeShape(editor, target!, { labels: next }),
      );
    }
  },

  setNodeNote: (id, note) => {
    let target: CanvasNode | undefined;
    set((state) => {
      if (!state.document) return state;
      let changed = false;
      const nodes = state.document.nodes.map((node) => {
        if (node.id !== id) return node;
        if ((node.note ?? "") === note) return node;
        changed = true;
        target = node;
        return { ...node, note, updatedAt: now() } as CanvasNode;
      });
      if (!changed) return state;
      return { document: { ...state.document, nodes }, saveState: "dirty" };
    });
    if (target) {
      withEditor((editor) => updateNodeShape(editor, target!, { note }));
    }
  },

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
          const expandedHeight = node.expandedHeight ?? height;
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

  setFocusNode: (focusNodeId) => set({ focusNodeId }),

  setParent: (ids, parentId) => {
    let moved: string[] = [];
    set((state) => {
      const targets = new Set(ids);
      targets.delete(parentId ?? "");
      if (targets.size === 0) return state;
      const patch = commit(state, (document) => {
        const parent = parentId
          ? document.nodes.find((node) => node.id === parentId)
          : null;
        if (parentId && (!parent || parent.type !== "group")) return null;
        const parentOrigin = parent
          ? absolutePosition(document.nodes, parent)
          : { x: 0, y: 0 };
        let changed = false;
        const nodes = document.nodes.map((node) => {
          if (!targets.has(node.id)) return node;
          // 组不能进组：一层父子关系已经够用，嵌套组会让裁剪计算失控
          if (node.type === "group" && parentId) return node;
          if ((node.parentId ?? null) === parentId) return node;
          const absolute = absolutePosition(document.nodes, node);
          changed = true;
          moved.push(node.id);
          return {
            ...node,
            parentId: parentId ?? undefined,
            position: parentId
              ? {
                  x: absolute.x - parentOrigin.x,
                  y: absolute.y - parentOrigin.y,
                }
              : absolute,
            updatedAt: now(),
          };
        });
        return changed ? { ...document, nodes } : null;
      });
      if (!patch) moved = [];
      return patch ?? state;
    });
    if (moved.length === 0) return;
    withEditor((editor) => {
      const shapes = moved
        .map((id) => shapeOf(editor, id)?.id)
        .filter((id): id is TLShapeId => Boolean(id));
      if (shapes.length === 0) return;
      const parent = parentId ? shapeOf(editor, parentId)?.id : undefined;
      // tldraw 自己会把坐标换算成新父级的相对坐标，所以只交 id。
      editor.reparentShapes(shapes, parent ?? editor.getCurrentPageId());
    });
  },

  removeNodes: (ids) => {
    let applied = false;
    set((state) => {
      const doomed = new Set(ids);
      if (doomed.size === 0) return state;
      const patch = commit(state, (document) => {
        if (!document.nodes.some((node) => doomed.has(node.id))) return null;
        // 删组不删组员：先把孩子解组并换回绝对坐标，再删组本身。
        const orphaned = document.nodes.map((node) => {
          if (doomed.has(node.id)) return node;
          if (!node.parentId || !doomed.has(node.parentId)) return node;
          return {
            ...node,
            parentId: undefined,
            position: absolutePosition(document.nodes, node),
            updatedAt: now(),
          };
        });
        // 顺手扫掉被删节点的看板卡片条目，否则它们会一直躺在 board.kanban 里
        const kanban = document.board.kanban;
        const cleaned = Object.keys(kanban.cards).some((nodeId) =>
          doomed.has(nodeId),
        )
          ? {
              columns: kanban.columns,
              cards: Object.fromEntries(
                Object.entries(kanban.cards).filter(
                  ([nodeId]) => !doomed.has(nodeId),
                ),
              ),
            }
          : kanban;
        return {
          ...document,
          ...(cleaned === kanban
            ? {}
            : { board: { ...document.board, kanban: cleaned } }),
          nodes: orphaned.filter((node) => !doomed.has(node.id)),
          edges: document.edges.filter(
            (edge) => !doomed.has(edge.source) && !doomed.has(edge.target),
          ),
        };
      });
      if (!patch) return state;
      applied = true;
      const maximized = Object.fromEntries(
        Object.entries(state.maximized).filter(([id]) => !doomed.has(id)),
      );
      return {
        ...patch,
        maximized,
        selectedNodeIds: state.selectedNodeIds.filter((id) => !doomed.has(id)),
        focusNodeId:
          state.focusNodeId && doomed.has(state.focusNodeId)
            ? null
            : state.focusNodeId,
      };
    });
    if (!applied) return;
    withEditor((editor) => {
      const doomed = ids
        .map((id) => shapeOf(editor, id)?.id)
        .filter((id): id is TLShapeId => Boolean(id));
      if (doomed.length === 0) return;
      // frame 一删连子级一起删，但「删组不删组员」是画布的既定语义，
      // 所以先把孩子提到页面上（坐标由 tldraw 换算），再删 frame。
      const orphans = editor
        .getCurrentPageShapes()
        .filter(
          (shape) =>
            doomed.includes(shape.parentId as TLShapeId) &&
            !doomed.includes(shape.id),
        )
        .map((shape) => shape.id);
      if (orphans.length > 0) {
        editor.reparentShapes(orphans, editor.getCurrentPageId());
      }
      editor.deleteShapes(doomed);
    });
  },

  duplicateNodes: (ids) => {
    const state = get();
    if (!state.document) return [];
    const sources = state.document.nodes.filter((node) =>
      ids.includes(node.id),
    );
    if (sources.length === 0) return [];
    const stamp = now();
    const copies = sources.map((source) => {
      const copy = {
        ...source,
        id: crypto.randomUUID(),
        position: { x: source.position.x + 32, y: source.position.y + 32 },
        data: structuredClone(source.data),
        createdAt: stamp,
        updatedAt: stamp,
      } as CanvasNode;
      // 副本绝不继承活着的会话句柄，否则两个节点会抢同一个 PTY。
      if (copy.data.kind === "terminal") {
        const { sessionId: _session, agent, ...rest } = copy.data;
        copy.data = {
          ...rest,
          ...(agent ? { agent: { ...agent, sessionId: undefined } } : {}),
        };
      }
      return copy;
    });
    const patch = commit(state, (document) => ({
      ...document,
      nodes: [...document.nodes, ...copies],
    }));
    if (!patch) return [];
    set({ ...patch, selectedNodeIds: copies.map((copy) => copy.id) });
    withEditor((editor) => {
      createNodeShapes(editor, copies);
      editor.select(...copies.map((copy) => toShapeId(copy.id)));
    });
    return copies.map((copy) => copy.id);
  },

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
      for (const binding of projection.bindings) editor.createBinding(binding);
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
    markPushed(useCanvasStore.getState().document);
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
    withEditor((editor) => {
      editor.updateShapes(
        Object.entries(positions)
          .map(([id, position]) => {
            const shape = shapeOf(editor, id);
            if (!shape) return null;
            return {
              id: shape.id,
              type: shape.type,
              x: position.x,
              y: position.y,
            };
          })
          .filter((partial) => partial !== null),
      );
    });
  },
}));

/* --------------------------------- 选择器 --------------------------------- */

export function useSelectedNodes(): CanvasNode[] {
  return useCanvasStore(
    useShallow((state) =>
      state.document
        ? state.document.nodes.filter((node) =>
            state.selectedNodeIds.includes(node.id),
          )
        : [],
    ),
  );
}

export function useCanvasNode(id: string | null): CanvasNode | undefined {
  return useCanvasStore((state) =>
    id ? state.document?.nodes.find((node) => node.id === id) : undefined,
  );
}

/**
 * 撤销 / 重做的可用性来自 editor 的历史栈。
 *
 * 用 `useSyncExternalStore` 订阅 `editor.store.listen` 而不是 tldraw 的
 * `useValue`：这两个 hook 会被画布之外的组件（Dock、命令面板）调用，
 * 那里没有 `<Tldraw>` 的上下文。
 */
function useEditorHistoryFlag(read: (editor: Editor) => boolean): boolean {
  const editor = useEditorHandle();
  const subscribe = React.useCallback(
    (onChange: () => void) => (editor ? editor.store.listen(onChange) : () => {}),
    [editor],
  );
  const snapshot = React.useCallback(
    () => (editor ? read(editor) : false),
    [editor, read],
  );
  return React.useSyncExternalStore(subscribe, snapshot, () => false);
}

const readCanUndo = (editor: Editor) => editor.getCanUndo();
const readCanRedo = (editor: Editor) => editor.getCanRedo();

export function useCanUndo(): boolean {
  return useEditorHistoryFlag(readCanUndo);
}

export function useCanRedo(): boolean {
  return useEditorHistoryFlag(readCanRedo);
}

/** 节点当前是否处于最大化状态（头部按钮要在最大化/还原之间切换）。 */
export function useIsMaximized(id: string): boolean {
  return useCanvasStore((state) => state.maximized[id] !== undefined);
}
