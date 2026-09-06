import {
  type BoardDocument,
  type CanvasNode,
  type Position,
} from "@armadra/shared";
import { usePreferencesStore } from "../../app/preferences-store";
import { emptyWhiteboard } from "../../canvas/whiteboard/model";
import { isCompactLayout } from "../../platform/layout";
import { diffSnapshots, record, type CommitOptions } from "./history";
import {
  type CanvasStore,
  type PanelState,
  type PremaxRect,
  type SaveState,
} from "./types";

export const emptyBoardState = {
  document: null,
  whiteboard: emptyWhiteboard(),
  selectedNodeIds: [] as string[],
  selectedEdgeIds: [] as string[],
  selectedItemIds: [] as string[],
  focusNodeId: null,
  maximized: {} as Record<string, PremaxRect>,
  saveState: "idle" as SaveState,
  saveError: null,
};

export const initialPanels: PanelState = {
  sidebar:
    !isCompactLayout() && usePreferencesStore.getState().sidebarOpen
      ? "open"
      : "collapsed",
  explorer: "closed",
  scm: "closed",
  resources: "closed",
  automation: "closed",
  handoff: "closed",
  usage: "closed",
  github: "closed",
  problems: "closed",
  references: "closed",
  settings: false,
  palette: false,
  quickOpen: false,
};

export function now(): string {
  return new Date().toISOString();
}

/**
 * 结构性改动的统一入口（React Flow 计划 §2.1 规则 1）：改文档 → 记历史 →
 * 置 dirty。
 *
 * 历史默认记录；远端灌入（`setDocument`、WS 事件、保存 409 变基）与撤销
 * 回放自己传 `history: "ignore"`，那时 ⌘Z 不该把别人的改动卷进来。
 * 白板对象走同一条路：它们和文档在同一次 `set` 里变，所以差分时两张表
 * 一起看（`store/canvas/history.ts`）。
 */
export function commit(
  state: CanvasStore,
  mutate: (document: BoardDocument) => BoardDocument | null,
  options: CommitOptions = {},
): Partial<CanvasStore> | null {
  if (!state.document) return null;
  const next = mutate(state.document);
  if (!next) return null;
  if ((options.history ?? "record") !== "ignore") {
    const items = state.whiteboard.items;
    const references = state.whiteboard.references;
    const diff = diffSnapshots(
      {
        nodes: state.document.nodes,
        edges: state.document.edges,
        items,
        references,
      },
      { nodes: next.nodes, edges: next.edges, items, references },
    );
    record({
      label: options.label ?? "edit",
      before: diff.before,
      after: diff.after,
    });
  }
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
