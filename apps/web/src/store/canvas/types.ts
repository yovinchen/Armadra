import {
  type BoardDocument,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
  type Position,
  type Size,
  type Viewport,
  type Workspace,
} from "@armadra/shared";
import type { StoreApi } from "zustand";

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
  /** 主机 / 会话资源面板（T02）。开着时 Runtime 才采样。 */
  resources: "closed" | "drawer";
  /** 右侧工作面板的「自动化」页（自动化设计 §3 / 画布平台设计 §4）。 */
  automation: "closed" | "drawer";
  /** 工作空间的交接历史（自动化设计 §7）。只读，不发起交接。 */
  handoff: "closed" | "drawer";
  /** 额度、用量与成本看板（§4.2）。抽屉或右侧常驻浮卡。 */
  usage: "closed" | "drawer" | "pinned";
  /** 右侧工作面板的「GitHub」页（Git/GitHub 设计 §1 / 画布平台设计 §4）。 */
  github: "closed" | "drawer";
  /** 语言服务的诊断（语言服务设计 §1.1）。按工作空间聚合，点击跳转。 */
  problems: "closed" | "drawer";
  settings: boolean;
  palette: boolean;
  /** 快速打开（⌘P，E01/M4）。 */
  quickOpen: boolean;
}

export interface AddNodeOptions {
  /**
   * 指定节点 id，而不是随机生成一个。
   *
   * 只有认领孤立会话时用得上（T02）：那个会话的 key 就是它原来那个节点的
   * id，用同一个 id 建节点，恢复出来的节点拥有的才是原来那个进程，而不是
   * 一个新会话。id 已经在画布上时不新建，直接返回空串。
   */
  id?: string;
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
  /** 节点标签（画布卡片上的 chip）。 */
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
  /** 白板快照（tldraw 计划 §6.1）；跟着画布文档一起保存。 */
  setWhiteboard: (snapshot: string) => void;
  undo: () => void;
  redo: () => void;
  /** `options.aspect` 是当前视口宽高比（§23）；缺省时按 16:9 裹。 */
  arrangeNodes: (options?: { aspect?: number }) => void;
}

export type CanvasStore = CanvasState & CanvasActions;

/** zustand 交给 store 工厂的两个入口，切片按同一个签名接收。 */
export type CanvasSet = StoreApi<CanvasStore>["setState"];
export type CanvasGet = StoreApi<CanvasStore>["getState"];
