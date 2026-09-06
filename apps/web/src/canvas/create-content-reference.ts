import { toast } from "sonner";
import type { BoardDocument, CanvasNode } from "@armadra/shared";

import { t } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { MAX_LINKS } from "./content-links";
import { fromItemId, type WhiteboardDoc } from "./whiteboard/model";
import { addReference, removeReferences } from "./whiteboard/store";

/**
 * 创建内容引用（React Flow 计划 §2.5 / F29，归属 B5）。
 *
 * 引用不再是一条带绑定的箭头，而是 `whiteboard.references` 里的一行
 * `{ id, itemId, nodeId }`（§3.1），画出来是 `reference` 边。所以「建一条
 * 引用」= 往白板文档里加一行，经 `whiteboard/store.addReference` 走
 * `canvas-store`，撤销栈与置脏一起有（AGENTS.md：画布修改经 canvas-store
 * 动作）。
 *
 * 两个入口共用这里：右键「引用到 Agent」子菜单（`menus/reference-menu.tsx`）
 * 与从把手拖到白板对象（`flow/use-flow-nodes.onConnect`）。上限与去重的
 * 判定在两条路上必须一致，所以判定只写一份。
 */

/** 能接收内容引用的节点：带 Agent 的终端（Runtime 只对它们开链接文档）。 */
export function referenceTargets(document: BoardDocument | null): CanvasNode[] {
  if (!document) return [];
  return document.nodes.filter(
    (node) => node.data.kind === "terminal" && Boolean(node.data.agent?.id),
  );
}

/**
 * 一个节点已经关联了多少个对端：连线的另一头 + 引用的白板对象，去重后计数。
 * 上限 64 与 `contextLinksRequestSchema` 同一个数（`content-links.MAX_LINKS`）。
 */
export function referenceCountForNode(
  document: BoardDocument | null,
  whiteboard: WhiteboardDoc,
  nodeId: string,
): number {
  const peers = new Set<string>();
  for (const edge of document?.edges ?? []) {
    if (edge.source === nodeId) peers.add(edge.target);
    if (edge.target === nodeId) peers.add(edge.source);
  }
  for (const reference of whiteboard.references) {
    if (reference.nodeId === nodeId) peers.add(reference.itemId);
  }
  return peers.size;
}

/** 这个节点已经引用过这个对象了吗？返回那一行的 id（也是 `ContextLink.id`）。 */
export function findReference(
  whiteboard: WhiteboardDoc,
  itemId: string,
  nodeId: string,
): string | null {
  const bare = fromItemId(itemId);
  return (
    whiteboard.references.find(
      (reference) => reference.itemId === bare && reference.nodeId === nodeId,
    )?.id ?? null
  );
}

export type ReferenceOutcome =
  /** 新建了一行；`id` 是 `ContextLink.id`。 */
  | { kind: "created"; id: string }
  /** 已经引用过了：选中那条边而不是再画一条（「去重定位」）。 */
  | { kind: "existing"; id: string }
  | { kind: "rejected"; reason: "unknown" | "limit" };

/**
 * 建一条引用（必要时只是定位到已有的那条）。
 *
 * 纯粹的判定 + 一次 store 动作，不碰 React Flow：新建或找到之后把那条边
 * 设成唯一选区，用户松开菜单就能看见它在哪、并且可以直接删。
 *
 * `toast` 只在**菜单**那条路上响（`notify` 默认 true）。拖线那条路由
 * `use-flow-nodes.onConnectEnd` 统一提示，两处都提示会弹两遍。
 */
export function createContentReference(
  itemId: string,
  nodeId: string,
  { notify = true }: { notify?: boolean } = {},
): ReferenceOutcome {
  const state = useCanvasStore.getState();
  const whiteboard = state.whiteboard;
  const bare = fromItemId(itemId);
  if (!whiteboard.items.some((item) => item.id === bare)) {
    return { kind: "rejected", reason: "unknown" };
  }
  if (!referenceTargets(state.document).some((node) => node.id === nodeId)) {
    return { kind: "rejected", reason: "unknown" };
  }

  const existing = findReference(whiteboard, bare, nodeId);
  if (existing) {
    state.setSelection({ nodes: [], edges: [existing], items: [] });
    if (notify) toast.info(t("shape.referenceExists"));
    return { kind: "existing", id: existing };
  }

  if (referenceCountForNode(state.document, whiteboard, nodeId) >= MAX_LINKS) {
    if (notify) toast.error(t("shape.referenceLimit", { limit: MAX_LINKS }));
    return { kind: "rejected", reason: "limit" };
  }

  const id = crypto.randomUUID();
  addReference({ id, itemId: bare, nodeId });
  useCanvasStore.getState().setSelection({ nodes: [], edges: [id], items: [] });
  return { kind: "created", id };
}

/**
 * 删掉一条引用。
 *
 * 传的是**引用行的 id**（也是 React Flow 上那条边的 id）。对象本身不动：
 * 用户删的是「Agent 能不能读它」，不是那张图。
 */
export function removeContentReference(referenceId: string): boolean {
  const before = useCanvasStore.getState().whiteboard.references.length;
  removeReferences([referenceId]);
  const after = useCanvasStore.getState().whiteboard.references.length;
  if (after === before) return false;
  const state = useCanvasStore.getState();
  state.setSelection({
    edges: state.selectedEdgeIds.filter((id) => id !== referenceId),
  });
  return true;
}
