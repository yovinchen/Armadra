import type { Edge, Node } from "@xyflow/react";
import type { BoardDocument, CanvasEdge, CanvasNode } from "@armadra/shared";

import { COLLAPSED_HEIGHT, defaultNodeSize } from "../../store/defaults";
import { NODE_DRAG_HANDLE, nodeMeta } from "../../nodes/registry";
import type { DraftMap } from "../flow/drafts";
import {
  fromItemId,
  isItemId,
  toItemId,
  type Item,
  type Reference,
  type WhiteboardDoc,
} from "../whiteboard/model";

/**
 * 文档 → React Flow（React Flow 计划 §2.1 规则 3 / §2.2 / §2.3，归属 canvas）。
 *
 * 全是纯函数：`canvas-store` 的 `document` + `whiteboard` + 手势草稿 + 选区
 * 进来，React Flow 的 `nodes` / `edges` 出去。React Flow 只是受控视图，
 * 反向派生（旧引擎的 `sync/derive.ts`）不再存在。
 *
 * 三条约定：
 *
 *  1. **id 不查表。** 节点 id 就是 `nodes` 行的 uuid，边 id 就是 `edges` 行的
 *     uuid，白板对象是 `wb:<uuid>`。删除分流按前缀判断（`tools.ts`）。
 *  2. **坐标与文档完全一致。** 组员的 `x/y` 相对父 Frame，顶层相对画布，
 *     和 React Flow 的子流语义本来就一样。
 *  3. **按对象身份缓存。** `CanvasNode` 没换、草稿没变、选中态没变，就复用
 *     上一次那个 RF 节点对象——否则一次相机移动会让 30 个终端全部重渲。
 */

export { fromItemId, isItemId, toItemId };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `nodes` / `edges` 行的 id 一律是 uuid（zod 在 shared 里就这么定的）。 */
export function isDocumentNodeId(id: string): boolean {
  return !isItemId(id) && UUID.test(id);
}

/** 分组画在普通节点下面：拖一个终端经过分组时不该被分组盖住。 */
export const GROUP_Z_INDEX = 0;
export const NODE_Z_INDEX = 1;

export type ArmadraNodeType = "armadra" | "group";
export type WhiteboardNodeType = `wb.${Item["kind"]}`;
export type FlowNodeType = ArmadraNodeType | WhiteboardNodeType;

export type ArmadraFlowNode = Node<CanvasNode, ArmadraNodeType>;
export type WhiteboardFlowNode = Node<Item, WhiteboardNodeType>;
export type CanvasFlowNode = ArmadraFlowNode | WhiteboardFlowNode;

export type LinkFlowEdge = Edge<Record<string, never>, "link">;
export type ReferenceFlowEdge = Edge<Record<string, never>, "reference">;
export type CanvasFlowEdge = LinkFlowEdge | ReferenceFlowEdge;

export interface Selection {
  nodes: ReadonlySet<string>;
  edges: ReadonlySet<string>;
  items: ReadonlySet<string>;
}

export const EMPTY_SELECTION: Selection = {
  nodes: new Set(),
  edges: new Set(),
  items: new Set(),
};

/* ------------------------------- 身份缓存 ---------------------------------- */

interface NodeCacheEntry {
  source: CanvasNode | Item;
  selected: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  projected: CanvasFlowNode;
}

const nodeCache = new Map<string, NodeCacheEntry>();

/** 仅测试与画布卸载用：丢掉缓存，下一次投影全部重建。 */
export function resetProjectionCache(): void {
  nodeCache.clear();
}

function reuse(
  id: string,
  entry: Omit<NodeCacheEntry, "projected">,
  build: () => CanvasFlowNode,
): CanvasFlowNode {
  const cached = nodeCache.get(id);
  if (
    cached &&
    cached.source === entry.source &&
    cached.selected === entry.selected &&
    cached.x === entry.x &&
    cached.y === entry.y &&
    cached.width === entry.width &&
    cached.height === entry.height
  ) {
    return cached.projected;
  }
  const projected = build();
  nodeCache.set(id, { ...entry, projected });
  return projected;
}

/* ------------------------------- 节点投影 ---------------------------------- */

/** 折叠时高度钉死；草稿（拖动 / resize 进行中）压在文档值之上。 */
function geometryOf(
  node: CanvasNode,
  drafts: DraftMap,
): { x: number; y: number; width: number; height: number } {
  const draft = drafts.get(node.id);
  const size = draft?.size ?? node.size ?? defaultNodeSize(node.type);
  const position = draft?.position ?? node.position;
  return {
    x: position.x,
    y: position.y,
    width: size.width,
    height: node.collapsed ? COLLAPSED_HEIGHT : size.height,
  };
}

function projectNode(
  node: CanvasNode,
  drafts: DraftMap,
  selected: boolean,
): CanvasFlowNode {
  const box = geometryOf(node, drafts);
  return reuse(node.id, { source: node, selected, ...box }, () => {
    const isGroup = node.type === "group";
    return {
      id: node.id,
      type: isGroup ? "group" : "armadra",
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      // 尺寸由文档给死，所以顺带把 `measured` 也填上——不是可有可无的重复：
      // React Flow 在 `adoptUserNodes` 里重建一个节点时，只有 `measured` 存在
      // 才会把上一份 `handleBounds` 带过去（`parseHandles`）。留空的话，任何
      // 一次节点对象换身份（换父、`setNodeExtent` 那次 `checkEquality: false`
      // 的全量重建）都会把把手尺寸清掉，而 DOM 尺寸没变、`ResizeObserver`
      // 不会再响，于是**所有连线永久消失**、把手也再拉不出线来。
      measured: { width: box.width, height: box.height },
      data: node,
      selected,
      draggable: true,
      // 拖拽只从头部起（F02）：体内的指针事件归节点体（终端、编辑器）。
      // 分组没有节点体，整块都是把手。
      ...(isGroup ? {} : { dragHandle: NODE_DRAG_HANDLE }),
      connectable: !isGroup && nodeMeta(node.type).hasBridgeHandles,
      zIndex: isGroup ? GROUP_Z_INDEX : NODE_Z_INDEX,
      ...(node.parentId ? { parentId: node.parentId } : {}),
    } as ArmadraFlowNode;
  });
}

function projectItem(item: Item, selected: boolean): CanvasFlowNode {
  const box = { x: item.x, y: item.y, width: item.w, height: item.h };
  const id = toItemId(item.id);
  return reuse(id, { source: item, selected, ...box }, () => ({
    id,
    type: `wb.${item.kind}` as WhiteboardNodeType,
    position: { x: item.x, y: item.y },
    width: item.w,
    height: item.h,
    // 与节点同理（见 `projectNode`）：`measured` 是 `handleBounds` 的保命符。
    measured: { width: item.w, height: item.h },
    data: item,
    selected,
    draggable: true,
    // 白板对象只作引用的一端（§2.3）；对象之间连线用直线 / 箭头工具。
    connectable: true,
    zIndex: item.z,
    ...(item.parentId ? { parentId: item.parentId } : {}),
  }));
}

/**
 * 顺序有意义：React Flow 要求父节点排在子节点前面，否则子流的坐标算不出来。
 * 分组一律排在最前，白板对象跟在节点后面（`zIndex` 才决定压盖关系）。
 */
export function projectNodes(
  document: BoardDocument | null,
  whiteboard: WhiteboardDoc,
  drafts: DraftMap,
  selection: Selection = EMPTY_SELECTION,
): CanvasFlowNode[] {
  const nodes = document?.nodes ?? [];
  const groups: CanvasFlowNode[] = [];
  const rest: CanvasFlowNode[] = [];
  for (const node of nodes) {
    const projected = projectNode(node, drafts, selection.nodes.has(node.id));
    if (node.type === "group") groups.push(projected);
    else rest.push(projected);
  }
  const items = whiteboard.items.map((item) =>
    projectItem(item, selection.items.has(toItemId(item.id))),
  );
  return [...groups, ...rest, ...items];
}

/* -------------------------------- 边投影 ----------------------------------- */

export type EdgeArrowheads = { start: "arrow" | "none"; end: "arrow" | "none" };

/**
 * 箭头方向（§21）。
 *
 * 箭头表达「谁读谁」，与用户从哪一头拖出来无关：内容 → 终端单向指向终端；
 * 终端 ↔ 终端双向；内容 ↔ 内容无箭头，只表示归到一起。
 */
export function edgeArrowheads(
  sourceType?: string,
  targetType?: string,
): EdgeArrowheads {
  const sourceIsTerminal = sourceType === "terminal";
  const targetIsTerminal = targetType === "terminal";
  if (sourceIsTerminal && targetIsTerminal) {
    return { start: "arrow", end: "arrow" };
  }
  if (targetIsTerminal) return { start: "none", end: "arrow" };
  if (sourceIsTerminal) return { start: "arrow", end: "none" };
  return { start: "none", end: "none" };
}

/** 节点类型 → 连线标签的 i18n 键（§21 的那一行表）。 */
const EDGE_LABEL_KEYS: Record<string, string> = {
  sticky: "edge.sticky",
  editor: "edge.file",
  files: "edge.dir",
  browser: "edge.web",
  diff: "edge.diff",
};

/**
 * 连线中点的标签（i18n 键，不是文案）。
 *
 * 标签说的是「Agent 读到的是什么」：终端 ↔ 终端是互相读转录，写「上下文」；
 * 一端是内容节点时按那一端的类型写（便签 / 文件 / 目录 / 网页 / 差异）。
 */
export function edgeLabelKey(sourceType?: string, targetType?: string): string {
  const content =
    sourceType && sourceType !== "terminal"
      ? sourceType
      : targetType && targetType !== "terminal"
        ? targetType
        : null;
  if (!content) return "edge.context";
  return EDGE_LABEL_KEYS[content] ?? "edge.context";
}

function projectEdge(edge: CanvasEdge, selected: boolean): CanvasFlowEdge {
  return {
    id: edge.id,
    type: "link",
    source: edge.source,
    target: edge.target,
    selected,
  } as LinkFlowEdge;
}

function projectReference(
  reference: Reference,
  selected: boolean,
): CanvasFlowEdge {
  return {
    id: reference.id,
    type: "reference",
    source: toItemId(reference.itemId),
    target: reference.nodeId,
    selected,
  } as ReferenceFlowEdge;
}

/** 两端有一个不在画布上的边投影不出来（远端刚删掉那个节点时会发生）。 */
export function projectEdges(
  document: BoardDocument | null,
  whiteboard: WhiteboardDoc,
  selection: Selection = EMPTY_SELECTION,
): CanvasFlowEdge[] {
  const nodes = new Set((document?.nodes ?? []).map((node) => node.id));
  const items = new Set(whiteboard.items.map((item) => toItemId(item.id)));
  const edges: CanvasFlowEdge[] = [];
  for (const edge of document?.edges ?? []) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
    edges.push(projectEdge(edge, selection.edges.has(edge.id)));
  }
  for (const reference of whiteboard.references) {
    if (!items.has(toItemId(reference.itemId))) continue;
    if (!nodes.has(reference.nodeId)) continue;
    edges.push(projectReference(reference, selection.edges.has(reference.id)));
  }
  return edges;
}
