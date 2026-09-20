import type { CanvasNode } from "@armadra/shared";

/**
 * 节点的**名字**：形状、默认值，以及「拉完一条线该问谁起名」那条通道。
 *
 * 名字（handle）与标题不是一回事（`docs/design/agent-delivery.md` §2）：标题是
 * 给人看的散文，首个 Hook 回合之后会被自动命名改写一次；名字是 Agent 之间互相
 * 称呼用的短词，一块画布内唯一，只有显式改名才会变。所以「把这个交给 codex-2」
 * 在第二次自动命名之后仍然指向同一个节点。
 *
 * 唯一性真正的守卫在 core（`node_handles` 的主键）。这里这一份只用来**先说**：
 * 一个已经被占用的名字应该在对话框里就被拦下，而不是等保存被拒之后才知道。
 */

/** 与 core 的 `MAX_HANDLE_CHARS` 同值。 */
export const MAX_HANDLE_CHARS = 24;

/** 规范化成一个名字，或 `undefined`——大小写折叠，所以 `Review` 与 `review` 是同一个。 */
export function normalizeName(raw: string): string | undefined {
  const handle = raw.trim().toLowerCase();
  if (handle.length === 0 || handle.length > MAX_HANDLE_CHARS) return undefined;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(handle)) return undefined;
  return handle;
}

/** 一个节点现在的名字。文档里的副本按同一套规则重新校验，不直接信。 */
export function nodeName(node: CanvasNode): string | undefined {
  const raw = (node.data as { handle?: unknown } | null)?.handle;
  return typeof raw === "string" ? normalizeName(raw) : undefined;
}

/** 这块画布上已经被占用的名字（可排除某个节点自己）。 */
export function takenNames(
  nodes: readonly CanvasNode[],
  exceptId?: string,
): Set<string> {
  const taken = new Set<string>();
  for (const node of nodes) {
    if (node.id === exceptId) continue;
    const handle = nodeName(node);
    if (handle !== undefined) taken.add(handle);
  }
  return taken;
}

/** 谁叫这个名字，用来在对话框里当场说清楚而不是静默改写。 */
export function holderOf(
  nodes: readonly CanvasNode[],
  handle: string,
  exceptId?: string,
): CanvasNode | undefined {
  return nodes.find(
    (node) => node.id !== exceptId && nodeName(node) === handle,
  );
}

/**
 * 默认名字：`<类型或 agent>-<序号>`，序号是本画布内**最小的空位**。
 *
 * 只看本画布：`codex-1` 在另一块画布上可以再出现一次（设计 §2.2）。用 agent id
 * 而不是节点类型，因为人认的是「那个 codex」而不是「那个 terminal」。
 */
export function suggestName(
  nodes: readonly CanvasNode[],
  node: CanvasNode,
): string {
  const stem = normalizeName(agentOf(node) ?? node.type) ?? "node";
  const taken = takenNames(nodes, node.id);
  for (let index = 1; index <= 999; index += 1) {
    const candidate = `${stem}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return stem;
}

function agentOf(node: CanvasNode): string | undefined {
  const agent = (node.data as { agent?: { id?: unknown } } | null)?.agent;
  const id = agent?.id;
  if (typeof id !== "string") return undefined;
  // `custom:foo` 的冒号不是名字的字符，取后半截。
  return id.startsWith("custom:") ? id.slice("custom:".length) : id;
}

/* ------------------------------ 起名的请求 ------------------------------- */

/**
 * 「给这些节点起名」的请求通道。
 *
 * 拉完一条线的那一刻（`canvas/flow/use-flow-nodes.onConnect`）与节点菜单里的
 * 「名字…」用同一条：两个入口只有一个对话框，所以「连线时跳过了、回头再起」
 * 与「一开始就起」落在同一段代码上。
 */
export interface NodeNamesRequest {
  /**
   * 这次请求来自刚建立的那条边。
   *
   * 有它才问角色：对等还是主从是**一条边**的属性，从节点菜单点「名字…」时没
   * 有边可问，`open-agent` 建的边也不弹框——那条边是 Agent 自己拉的，人不在
   * 场，没有人可以回答这个问题。
   */
  readonly edgeId?: string;
}

export type NodeNamesListener = (
  nodeIds: readonly string[],
  request: NodeNamesRequest,
) => void;

const listeners = new Set<NodeNamesListener>();

export function requestNodeNames(
  nodeIds: readonly string[],
  request: NodeNamesRequest = {},
): void {
  if (nodeIds.length === 0) return;
  for (const listener of [...listeners]) listener(nodeIds, request);
}

export function onNodeNamesRequest(listener: NodeNamesListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
