/**
 * 连线合法性（§21「任意互连」）。
 *
 * 规则只剩两条：不能自连，同一对节点不能连两次（无论方向）。类型不再参与
 * 判断——任意两个节点都可以连，连上之后 Agent 能读到什么由 Runtime 按对方
 * 的类型决定（`collab/context_link.rs`）。
 */

export interface ConnectionEnds {
  source?: string | null;
  target?: string | null;
}

export interface EdgeEnds {
  source: string;
  target: string;
}

export interface NodeId {
  id: string;
}

export function isValidLink(
  connection: ConnectionEnds,
  nodes: readonly NodeId[],
  edges: readonly EdgeEnds[],
): boolean {
  const { source, target } = connection;
  if (!source || !target || source === target) return false;
  // 拖到空白处松手时 React Flow 也会问一遍，两端都必须真实存在。
  const known = new Set(nodes.map((node) => node.id));
  if (!known.has(source) || !known.has(target)) return false;
  return !edges.some(
    (edge) =>
      (edge.source === source && edge.target === target) ||
      (edge.source === target && edge.target === source),
  );
}
