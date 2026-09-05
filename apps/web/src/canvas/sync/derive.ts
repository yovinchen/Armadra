import type { CanvasEdge, CanvasNode, CanvasNodeType } from "@armadra/shared";
import type {
  TLArrowBinding,
  TLArrowShape,
  TLFrameShape,
  TLShape,
} from "tldraw";

import type { ArmadraShape } from "../shapes/armadra-shape";
import { isDocumentShapeId, isUuid, toNodeId } from "../shapes/armadra-shape";
import type { LinkShape } from "../shapes/link-shape";
import { isLinkShape, linkEnds } from "../shapes/link-shape";
import { fromTldrawColor } from "./project";

/**
 * tldraw 记录 → 文档（tldraw 计划 §9.2，归属 canvas）。纯函数。
 *
 * 反向映射要和 `project.ts` 逐条对上：frame → `group` 节点、`armadra` → 其余
 * 类型、`link` shape → 一条 `edges` 行。
 *
 * 时间戳：`createdAt` 从 props / meta 取回；`updatedAt` 由调用方决定
 * （`deriveNodes` 只在内容真的变了时才换新，否则沿用上一份，这样
 * 「没改动」不会被误判成脏）。
 */

/** shape 的父级是不是另一个节点。 */
function parentNodeId(shape: TLShape): string | undefined {
  return shape.parentId.startsWith("shape:")
    ? toNodeId(shape.parentId)
    : undefined;
}

interface FrameArmadraMeta {
  color?: string;
  labels?: string[];
  note?: string;
  collapsed?: boolean;
  createdAt?: string;
}

export function shapeToNode(
  shape: ArmadraShape | TLFrameShape,
  boardId: string,
  updatedAt: string,
): CanvasNode {
  const parentId = parentNodeId(shape);
  const position = { x: shape.x, y: shape.y };

  if (shape.type === "frame") {
    const frame = shape as TLFrameShape;
    const meta = (frame.meta.armadra ?? {}) as FrameArmadraMeta;
    return {
      id: toNodeId(frame.id),
      boardId,
      type: "group" as CanvasNodeType,
      title: frame.props.name,
      color: fromTldrawColor(frame.props.color, meta.color ?? "#0a84ff"),
      position,
      size: { width: frame.props.w, height: frame.props.h },
      ...(meta.collapsed ? { collapsed: true } : {}),
      ...(parentId ? { parentId } : {}),
      labels: [...(meta.labels ?? [])],
      note: meta.note ?? "",
      data: { kind: "group" },
      createdAt: meta.createdAt ?? updatedAt,
      updatedAt,
    } as CanvasNode;
  }

  const armadra = shape as ArmadraShape;

  return {
    id: toNodeId(armadra.id),
    boardId,
    type: armadra.props.nodeType as CanvasNodeType,
    title: armadra.props.title,
    color: armadra.props.color,
    position,
    size: { width: armadra.props.w, height: armadra.props.h },
    ...(armadra.props.collapsed ? { collapsed: true } : {}),
    ...(armadra.props.expandedHeight > 0
      ? { expandedHeight: armadra.props.expandedHeight }
      : {}),
    ...(parentId ? { parentId } : {}),
    labels: [...armadra.props.labels],
    note: armadra.props.note,
    data: armadra.props.data,
    createdAt: armadra.props.createdAt,
    updatedAt,
  } as CanvasNode;
}

export interface ArrowArmadraMeta {
  /** 边的 uuid（§Phase 2）。用户拉出来的 arrow 自身 id 是随机的，只能记在这里。 */
  id?: string;
  kind?: CanvasEdge["kind"];
  createdAt?: string;
  updatedAt?: string;
  /** 方向与颜色已经写过一次；之后用户手改样式不再被覆盖。 */
  styled?: boolean;
  /**
   * 内容链接的稳定 uuid（§6.3，`canvas/content-links.ts`）。
   *
   * 一端绑节点、一端绑白板 shape 的 arrow 不是一条 `edges` 行，但要在链接文档
   * 里有个固定的 id，导出的 PNG 才能一直写同一个 `.armadra/exports/<uuid>.png`。
   */
  contentId?: string;
}

/** 一条 arrow 的 `meta.armadra`（没有就是空对象）。 */
export function arrowArmadraMeta(arrow: {
  meta?: Record<string, unknown>;
}): ArrowArmadraMeta {
  return (arrow.meta?.armadra ?? {}) as ArrowArmadraMeta;
}

/**
 * 这条 arrow 对应哪条 `edges` 行？
 *
 * **优先读 `meta.armadra.id`**：用户用把手或箭头工具拉出来的 arrow，tldraw 给的是
 * 随机 id（`shape:xxxx`），只有 meta 里记得住 uuid。文档投影出来的 arrow 两边
 * 都有（id 是 `shape:<uuid>`，meta 里也写同一个），所以两种来源往返恒等。
 *
 * 都没有 ⇒ 这条 arrow 还没被 `LinkArrow` 认领（或者根本不是边），返回 null。
 */
export function arrowEdgeId(arrow: {
  id: string;
  meta?: Record<string, unknown>;
}): string | null {
  const meta = arrowArmadraMeta(arrow);
  if (typeof meta.id === "string" && isUuid(meta.id)) return meta.id;
  return isDocumentShapeId(arrow.id) ? toNodeId(arrow.id) : null;
}

/** 一条 arrow 的两端分别绑到了哪个节点（没绑或绑到白板 shape 时为 null）。 */
export function arrowEnds(
  arrow: TLArrowShape,
  bindings: readonly TLArrowBinding[],
): { source: string | null; target: string | null } {
  const mine = bindings.filter((binding) => binding.fromId === arrow.id);
  const at = (terminal: "start" | "end"): string | null => {
    const binding = mine.find((item) => item.props.terminal === terminal);
    // 绑到白板 shape 的箭头不是上下文链接（§4.3）：只有节点 id 是 uuid。
    if (!binding || !isDocumentShapeId(binding.toId)) return null;
    return toNodeId(binding.toId);
  };
  return { source: at("start"), target: at("end") };
}

/**
 * 一个 `link` shape → 一条 `edges` 行。两端不是节点（uuid）时返回 null。
 *
 * 上下文链接从 Phase 3 起是**自定义 shape**，不再是 tldraw 原生 arrow
 * （见 `shapes/link-shape.ts`）：边 id 在 `props.edgeId` 里，两端在
 * `props.from` / `props.to`，所以这一步不用查 binding。
 */
export function linkToEdge(
  shape: LinkShape,
  boardId: string,
): CanvasEdge | null {
  const { source, target } = linkEnds(shape);
  if (!source || !target || source === target) return null;
  const id = shape.props.edgeId;
  if (!isUuid(id)) return null;

  const stamp = shape.props.createdAt || new Date().toISOString();
  return {
    id,
    boardId,
    source,
    target,
    kind: shape.props.kind ?? "link",
    createdAt: stamp,
    updatedAt: shape.props.updatedAt || stamp,
  };
}

/**
 * 一个 shape 对应哪条 `edges` 行？不是边就返回 null。
 *
 * 「什么算边」只有这一处定义：`canvas.delete` 的分流、`store.removeEdges`
 * 都调它，别在调用方再写一遍 `shape.type === "link"`。旧看板里可能还留着
 * Phase 2 认领过的 arrow（`meta.armadra.id`），一并认出来。
 */
export function edgeIdOfShape(shape: {
  id: string;
  type: string;
  props?: unknown;
  meta?: Record<string, unknown>;
}): string | null {
  if (isLinkShape(shape)) {
    const id = (shape.props as { edgeId?: unknown } | undefined)?.edgeId;
    return typeof id === "string" && isUuid(id) ? id : null;
  }
  if (shape.type === "arrow") return arrowEdgeId(shape);
  return null;
}

/* ------------------------------ 整页派生 ---------------------------------- */

/** 除 `updatedAt` 之外全都一样 ⇒ 这一轮没改动，沿用上一份对象。 */
function sameNode(a: CanvasNode, b: CanvasNode): boolean {
  return (
    JSON.stringify({ ...a, updatedAt: "" }) ===
    JSON.stringify({ ...b, updatedAt: "" })
  );
}

function sameEdge(a: CanvasEdge, b: CanvasEdge): boolean {
  return a.source === b.source && a.target === b.target && a.kind === b.kind;
}

export interface DeriveResult<T> {
  items: T[];
  /** 有任何一条真的变了（新增、删除、内容改动）。 */
  changed: boolean;
}

/**
 * 一页的 shape → 节点数组。
 *
 * `previous` 是上一份文档：内容没变的节点原样复用（对象身份也保持不变），
 * 这样 React 侧的 memo 不会因为一次相机移动而全量重渲，`saveState` 也不会
 * 被空改动置脏。
 */
export function deriveNodes(
  shapes: readonly (ArmadraShape | TLFrameShape)[],
  boardId: string,
  previous: readonly CanvasNode[],
  stamp: string,
): DeriveResult<CanvasNode> {
  const before = new Map(previous.map((node) => [node.id, node]));
  const items: CanvasNode[] = [];
  let changed = false;
  for (const shape of shapes) {
    const next = shapeToNode(shape, boardId, stamp);
    const old = before.get(next.id);
    if (old && sameNode(old, next)) {
      items.push(old);
      continue;
    }
    changed = true;
    items.push(next);
  }
  return { items, changed: changed || items.length !== previous.length };
}

export function deriveEdges(
  links: readonly LinkShape[],
  boardId: string,
  previous: readonly CanvasEdge[],
): DeriveResult<CanvasEdge> {
  const before = new Map(previous.map((edge) => [edge.id, edge]));
  const items: CanvasEdge[] = [];
  let changed = false;
  for (const link of links) {
    const next = linkToEdge(link, boardId);
    if (!next) continue;
    const old = before.get(next.id);
    if (old && sameEdge(old, next)) {
      items.push(old);
      continue;
    }
    changed = true;
    items.push(next);
  }
  return { items, changed: changed || items.length !== previous.length };
}
