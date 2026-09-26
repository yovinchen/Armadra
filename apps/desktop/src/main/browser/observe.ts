import { canvasSessionsOf, guestsOfNode } from "./registry";

/**
 * 哪些浏览器节点此刻被 Agent 连着，由 core 整份告诉壳（`observe` 通知，
 * `core/browser/observe.ts`）。连着的节点，它在画布上的每个 guest 都被动接上
 * 调试器，控制台与请求从这一刻开始进缓冲；最后一条连线断开，摘掉。
 *
 * 为什么是整份而不是一条条增减：core 重启、壳重连之后，壳手里那份可能已经
 * 过时，整份替换就不必去对哪几条漏了。
 */

let observed = new Set<string>();

export function observedNodes(): ReadonlySet<string> {
  return observed;
}

/** 换成 core 刚给的那一份：新加的接上，不在了的摘掉。 */
export function setObservedNodes(nodeIds: readonly string[]): void {
  const next = new Set(nodeIds);
  for (const nodeId of observed) {
    if (next.has(nodeId)) continue;
    for (const entry of guestsOfNode(nodeId)) entry.session?.stopObserving();
  }
  observed = next;
  for (const nodeId of next) observeNode(nodeId);
}

/** 连着的节点新挂上一个 guest（新标签页、刷新后重新注册）：也接上。 */
export function observeNode(nodeId: string): void {
  if (!observed.has(nodeId)) return;
  for (const { session } of canvasSessionsOf(nodeId))
    void session.observe().catch(() => undefined);
}

/** 通知的 detail 里读出节点 id 列表；形状不对就当空表。 */
export function parseObserved(detail: unknown): string[] {
  const ids =
    typeof detail === "object" && detail !== null
      ? (detail as { nodeIds?: unknown }).nodeIds
      : undefined;
  if (!Array.isArray(ids)) return [];
  return ids.filter(
    (id): id is string =>
      typeof id === "string" && id.length > 0 && id.length <= 64,
  );
}

/** Only for tests. */
export function resetObserved(): void {
  observed = new Set();
}
