import type { BoardDocument } from "@armadra/shared";

/**
 * 交接入口的事件总线与目标推导（docs/design/agent-automation-design.md §7）。
 *
 * 和 `meta/annotations` 一样刻意不依赖任何 UI：入口在终端头部的「更多」下拉
 * 里，而对话框挂在壳上，中间只走一个 `CustomEvent`，免得把浮层拉进节点注册
 * 表那条循环依赖链。
 */

export const HANDOFF_EVENT = "armadra:handoff";

export interface HandoffRequestDetail {
  /** 来源节点，以及它当前那条 PTY 的身份——Runtime 按 generation 校验。 */
  nodeId: string;
  sessionId: string;
  generation: number;
  /**
   * 打开一个已有的交接包而不是新建。来源和目标两边都能这样查看同一份包
   * （design §7.3 第 6 条），此时不需要新的会话身份，也没有编辑表单。
   */
  handoffId?: string;
}

export function openHandoff(detail: HandoffRequestDetail): void {
  window.dispatchEvent(
    new CustomEvent<HandoffRequestDetail>(HANDOFF_EVENT, { detail }),
  );
}

export function onHandoffRequest(
  handler: (detail: HandoffRequestDetail) => void,
): () => void {
  function listener(event: Event) {
    const detail = (event as CustomEvent<HandoffRequestDetail>).detail;
    if (detail?.nodeId) handler(detail);
  }
  window.addEventListener(HANDOFF_EVENT, listener);
  return () => window.removeEventListener(HANDOFF_EVENT, listener);
}

export interface HandoffTarget {
  nodeId: string;
  title: string;
  agentId: string;
}

/**
 * 可选目标 = 画布上与来源**直接连线**、且自身是 Agent 终端的节点。
 *
 * 这里和 `canvas/context-links.buildLinkDocuments` 用同一条判据（无向边、两头
 * 都算），因为 Runtime 的授权依据正是那份链接文档：界面上能选的目标必须是
 * Runtime 也认的目标，否则用户填完一整张表才在 `prepare` 时被拒。
 */
export function handoffTargets(
  document: BoardDocument | null | undefined,
  sourceNodeId: string,
): HandoffTarget[] {
  if (!document) return [];
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const targets: HandoffTarget[] = [];
  for (const edge of document.edges) {
    const other =
      edge.source === sourceNodeId
        ? edge.target
        : edge.target === sourceNodeId
          ? edge.source
          : null;
    if (other === null || other === sourceNodeId) continue;
    if (targets.some((target) => target.nodeId === other)) continue;
    const node = byId.get(other);
    const agent =
      node?.data.kind === "terminal" ? node.data.agent?.id : undefined;
    // 普通终端没有会话身份，SSH 终端的执行主机 Runtime 还没有映射，
    // 两者都不是合法目标——与其列出来再被后端拒，不如现在就不列。
    if (!node || !agent || (node.data.kind === "terminal" && node.data.ssh))
      continue;
    targets.push({ nodeId: node.id, title: node.title, agentId: agent });
  }
  return targets;
}
