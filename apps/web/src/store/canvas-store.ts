import { create } from "zustand";
import type {
  Board,
  BoardDocument,
  CanvasEdge,
  CanvasEdgeType,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  NodeZoom,
  Position,
  Size,
  Stroke,
  Viewport,
  Workspace,
} from "@ai-coding-canvas/shared";
import { recommendedEdgeType } from "../canvas/edge-types";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "failed";
export type CanvasTool = "select" | "pen";
export type MobilePanel = "resources" | "canvas" | "inspector";
export type ModalName = "newWorkspace" | "settings" | "command" | "diffScan";

export interface AddNodeOptions {
  size?: Size;
  zoom?: NodeZoom;
  /** Defaults to true: a freshly added node becomes the inspector subject. */
  select?: boolean;
}

export interface CanvasState {
  workspace: Workspace | null;
  boards: Board[];
  boardId: string | null;
  document: BoardDocument | null;
  selectedNodeId: string | null;
  saveState: SaveState;
  saveError: string | null;
  tool: CanvasTool;
  penColor: string;
  mobilePanel: MobilePanel;
  modal: ModalName | null;
  summaryThreshold: number;

  setWorkspace: (workspace: Workspace | null) => void;
  setBoards: (boards: Board[]) => void;
  selectBoard: (boardId: string | null) => void;
  setDocument: (document: BoardDocument) => void;
  selectNode: (nodeId: string | null) => void;
  setSaveState: (state: SaveState) => void;
  setSaveError: (message: string | null) => void;
  setTool: (tool: CanvasTool) => void;
  setPenColor: (color: string) => void;
  setModal: (modal: ModalName | null) => void;
  setMobilePanel: (panel: MobilePanel) => void;
  setSummaryThreshold: (threshold: number) => void;

  addNode: (
    data: CanvasNodeData,
    position?: Position,
    options?: AddNodeOptions,
  ) => CanvasNode | null;
  updateNode: (nodeId: string, data: Partial<CanvasNodeData>) => void;
  moveNode: (nodeId: string, position: Position) => void;
  resizeNode: (nodeId: string, size: Size) => void;
  setNodeZoom: (nodeId: string, zoom: NodeZoom) => void;
  removeNodes: (nodeIds: string[]) => void;
  duplicateNode: (nodeId: string) => CanvasNode | null;
  addEdge: (
    sourceNodeId: string,
    targetNodeId: string,
    type: CanvasEdgeType,
  ) => CanvasEdge | null;
  removeEdges: (edgeIds: string[]) => void;
  addStroke: (stroke: Stroke) => void;
  clearStrokes: () => void;
  setViewport: (viewport: Viewport) => void;
  arrangeNodes: (positions: Record<string, Position>) => void;
}

/** Mirrors the `defaultSize` column of docs/redesign-plan.md §6. */
export const DEFAULT_NODE_SIZES: Record<CanvasNodeType, Size> = {
  task: { width: 280, height: 250 },
  agent: { width: 430, height: 600 },
  terminal: { width: 480, height: 280 },
  diff: { width: 400, height: 420 },
  file: { width: 300, height: 230 },
  context: { width: 280, height: 150 },
  log: { width: 360, height: 220 },
  image: { width: 260, height: 200 },
  note: { width: 260, height: 180 },
  browser: { width: 520, height: 380 },
};

export const DEFAULT_PEN_COLOR = "#5B5BD6";
export const DEFAULT_SUMMARY_THRESHOLD = 0.6;

const emptyBoardState = {
  document: null,
  selectedNodeId: null,
  saveState: "idle" as SaveState,
  saveError: null,
};

function touch(): string {
  return new Date().toISOString();
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  workspace: null,
  boards: [],
  boardId: null,
  document: null,
  selectedNodeId: null,
  saveState: "idle",
  saveError: null,
  tool: "select",
  penColor: DEFAULT_PEN_COLOR,
  mobilePanel: "canvas",
  modal: null,
  summaryThreshold: DEFAULT_SUMMARY_THRESHOLD,

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
      const stillOpen = sorted.some((board) => board.id === state.boardId);
      if (stillOpen) return { boards: sorted };
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
      document,
      boardId: document.board.id,
      saveState: "saved",
      saveError: null,
    }),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  setSaveState: (saveState) => set({ saveState }),
  setSaveError: (saveError) => set({ saveError }),
  setTool: (tool) => set({ tool }),
  setPenColor: (penColor) => set({ penColor }),
  setModal: (modal) => set({ modal }),
  setMobilePanel: (mobilePanel) => set({ mobilePanel }),
  setSummaryThreshold: (summaryThreshold) => set({ summaryThreshold }),

  addNode: (data, position, options) => {
    const document = get().document;
    if (!document) return null;
    const now = touch();
    const node: CanvasNode = {
      id: crypto.randomUUID(),
      boardId: document.board.id,
      type: data.kind,
      position: position ?? {
        x: 80,
        y: 80 + document.nodes.length * 96,
      },
      size: options?.size ?? DEFAULT_NODE_SIZES[data.kind],
      zoom: options?.zoom ?? "normal",
      data,
      createdAt: now,
      updatedAt: now,
    };
    const select = options?.select ?? true;
    set((state) => ({
      document: state.document
        ? { ...state.document, nodes: [...state.document.nodes, node] }
        : state.document,
      selectedNodeId: select ? node.id : state.selectedNodeId,
      saveState: "dirty",
    }));
    return node;
  },

  updateNode: (nodeId, data) =>
    set((state) => {
      if (!state.document) return state;
      return {
        document: {
          ...state.document,
          nodes: state.document.nodes.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  data: { ...node.data, ...data } as CanvasNodeData,
                  updatedAt: touch(),
                }
              : node,
          ),
        },
        saveState: "dirty",
      };
    }),

  moveNode: (nodeId, position) =>
    set((state) => {
      if (!state.document) return state;
      return {
        document: {
          ...state.document,
          nodes: state.document.nodes.map((node) =>
            node.id === nodeId
              ? { ...node, position, updatedAt: touch() }
              : node,
          ),
        },
        saveState: "dirty",
      };
    }),

  resizeNode: (nodeId, size) =>
    set((state) => {
      if (!state.document) return state;
      return {
        document: {
          ...state.document,
          nodes: state.document.nodes.map((node) =>
            node.id === nodeId ? { ...node, size, updatedAt: touch() } : node,
          ),
        },
        saveState: "dirty",
      };
    }),

  setNodeZoom: (nodeId, zoom) =>
    set((state) => {
      if (!state.document) return state;
      const now = touch();
      return {
        document: {
          ...state.document,
          nodes: state.document.nodes.map((node) => {
            if (node.id === nodeId) {
              return node.zoom === zoom
                ? node
                : { ...node, zoom, updatedAt: now };
            }
            // Only one node may hold the focused slot at a time.
            if (zoom === "focus" && node.zoom === "focus") {
              return { ...node, zoom: "normal" as NodeZoom, updatedAt: now };
            }
            return node;
          }),
        },
        saveState: "dirty",
      };
    }),

  removeNodes: (nodeIds) =>
    set((state) => {
      if (!state.document) return state;
      const ids = new Set(nodeIds);
      return {
        document: {
          ...state.document,
          nodes: state.document.nodes.filter((node) => !ids.has(node.id)),
          edges: state.document.edges.filter(
            (edge) =>
              !ids.has(edge.sourceNodeId) && !ids.has(edge.targetNodeId),
          ),
        },
        selectedNodeId: ids.has(state.selectedNodeId ?? "")
          ? null
          : state.selectedNodeId,
        saveState: "dirty",
      };
    }),

  duplicateNode: (nodeId) => {
    const document = get().document;
    const source = document?.nodes.find((node) => node.id === nodeId);
    if (!document || !source) return null;
    const now = touch();
    const copy: CanvasNode = {
      ...source,
      id: crypto.randomUUID(),
      position: { x: source.position.x + 32, y: source.position.y + 32 },
      data: structuredClone(source.data),
      createdAt: now,
      updatedAt: now,
    };
    // A duplicate must never inherit a live session handle.
    if (copy.data.kind === "terminal" || copy.data.kind === "agent") {
      copy.data = { ...copy.data, sessionId: undefined, status: "idle" };
    }
    set((state) => ({
      document: state.document
        ? { ...state.document, nodes: [...state.document.nodes, copy] }
        : state.document,
      selectedNodeId: copy.id,
      saveState: "dirty",
    }));
    return copy;
  },

  addEdge: (sourceNodeId, targetNodeId, type) => {
    const document = get().document;
    if (!document || sourceNodeId === targetNodeId) return null;
    const duplicate = document.edges.some(
      (edge) =>
        edge.sourceNodeId === sourceNodeId &&
        edge.targetNodeId === targetNodeId &&
        edge.type === type,
    );
    if (duplicate) return null;
    const now = touch();
    const edge: CanvasEdge = {
      id: crypto.randomUUID(),
      boardId: document.board.id,
      sourceNodeId,
      targetNodeId,
      type,
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({
      document: state.document
        ? { ...state.document, edges: [...state.document.edges, edge] }
        : state.document,
      saveState: "dirty",
    }));
    return edge;
  },

  removeEdges: (edgeIds) =>
    set((state) => {
      if (!state.document) return state;
      const ids = new Set(edgeIds);
      return {
        document: {
          ...state.document,
          edges: state.document.edges.filter((edge) => !ids.has(edge.id)),
        },
        saveState: "dirty",
      };
    }),

  addStroke: (stroke) =>
    set((state) => {
      if (!state.document) return state;
      return {
        document: {
          ...state.document,
          strokes: [...state.document.strokes, stroke],
        },
        saveState: "dirty",
      };
    }),

  clearStrokes: () =>
    set((state) => {
      if (!state.document || state.document.strokes.length === 0) return state;
      return {
        document: { ...state.document, strokes: [] },
        saveState: "dirty",
      };
    }),

  // Panning is not an edit: the viewport is persisted by App on its own
  // throttle so a mouse wheel never resurrects the "unsaved changes" guard.
  setViewport: (viewport) =>
    set((state) => {
      if (!state.document) return state;
      return {
        document: {
          ...state.document,
          board: { ...state.document.board, viewport },
        },
      };
    }),

  arrangeNodes: (positions) =>
    set((state) => {
      if (!state.document) return state;
      const now = touch();
      let changed = false;
      const nodes = state.document.nodes.map((node) => {
        const next = positions[node.id];
        if (!next) return node;
        if (next.x === node.position.x && next.y === node.position.y)
          return node;
        changed = true;
        return { ...node, position: next, updatedAt: now };
      });
      if (!changed) return state;
      return {
        document: { ...state.document, nodes },
        saveState: "dirty",
      };
    }),
}));

export function inferEdgeType(
  source: CanvasNode,
  target: CanvasNode,
): CanvasEdgeType {
  return recommendedEdgeType(source.type, target.type);
}
