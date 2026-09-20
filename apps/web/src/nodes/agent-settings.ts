/**
 * 「打开某个终端节点的 Agent 设置」那条通道（设计 `agent-delivery.md` §10）。
 *
 * 与 `meta/annotations.ts` 同一个理由做成没有任何 UI 依赖的叶子模块：入口在
 * 节点菜单（`nodes/terminal-menu.ts`）里，而菜单注册表与节点注册表之间已经是
 * 一个循环，把对话框组件拉进那条链会让模块求值顺序变得脆弱。
 */

const listeners = new Set<(nodeId: string) => void>();

/** 打开某个节点的 Agent 设置。 */
export function openAgentSettings(nodeId: string): void {
  for (const listener of [...listeners]) listener(nodeId);
}

export function onAgentSettingsRequest(
  listener: (nodeId: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
