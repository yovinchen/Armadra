import * as React from "react";
import { type Editor, type TLShape } from "tldraw";
import {
  type BoardDocument,
  type CanvasNode,
  type CanvasNodeData,
  type FrameBinding,
  type Position,
} from "@armadra/shared";
import { usePreferencesStore } from "../../app/preferences-store";
import { getEditor } from "../../canvas/editor-context";
import { toShapeId } from "../../canvas/shapes/armadra-shape";
import { nodeToShape, toTldrawColor } from "../../canvas/sync/project";
import { markPushed } from "../../canvas/sync/pushed";
import { isCompactLayout } from "../../platform/layout";
import {
  type CanvasStore,
  type PanelState,
  type PremaxRect,
  type SaveState,
} from "./types";
import { useCanvasStore } from "../canvas-store";

export const emptyBoardState = {
  document: null,
  selectedNodeIds: [] as string[],
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
  settings: false,
  palette: false,
  quickOpen: false,
};

export function now(): string {
  return new Date().toISOString();
}

/** 结构性改动的统一入口：改文档 → 置 dirty。撤销栈已经归 editor。 */
export function commit(
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
export function withEditor(run: (editor: Editor) => void): boolean {
  const editor = getEditor();
  if (!editor) return false;
  editor.run(() => run(editor));
  // 这份文档已经原样做到 editor 上了，`use-store-sync` 不必再整块投影回去
  // （否则每敲一个字都要把整块画布重新映射一遍）。
  markPushed(useCanvasStore.getState().document);
  return true;
}

export function shapeOf(editor: Editor, nodeId: string): TLShape | undefined {
  return editor.getShape(toShapeId(nodeId));
}

/** 节点的一次属性改动 → shape 的一次 `updateShapes`（frame 与 armadra 不同槽）。 */
export function updateNodeShape(
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
            // worktree 绑定（G03）也只有 meta 放得下；不写这一条，
            // `updateNodeData` 改完绑定，下一轮反向派生就把它抹回去了。
            ...(data && "binding" in data
              ? {
                  binding:
                    (data as { binding?: FrameBinding | null }).binding ?? null,
                }
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
export function createNodeShapes(
  editor: Editor,
  nodes: readonly CanvasNode[],
): void {
  const page = editor.getCurrentPageId();
  const ordered = [...nodes].sort((a, b) =>
    a.type === b.type ? 0 : a.type === "group" ? -1 : 1,
  );
  for (const node of ordered) {
    editor.createShape(nodeToShape(node, page));
  }
}
