// B5 重建：创建内容引用（React Flow 计划 §2.5 / F29）。
//
// 引用不再是一条 一条带绑定的箭头，而是 `whiteboard.references`
// 里的一行（`{ id, itemId, nodeId }`，§3.1），画出来是 `reference` 边。
// 上限（64）、去重定位、右键子菜单与拖线创建都归 B5。
//
// B0 只保留「哪些节点能当引用目标」和「一个节点已经有多少条」这两个纯
// 判断——它们只看 `document`，与白板模型无关，B5 直接用。
import type { BoardDocument, CanvasNode } from "@armadra/shared";

import type { WhiteboardDoc } from "./whiteboard/model";

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
