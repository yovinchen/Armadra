import type { TerminalSurfaceHandle } from "@/terminal/TerminalSurface";

/**
 * 活着的终端节点句柄，按节点 id 索引。
 *
 * 右键菜单、命令面板、以及 Phase 3 的画布控制 API 都需要"对某个终端做点
 * 什么"，但它们拿不到组件的 ref。这里是唯一的中转，卸载时必须注销——
 * 留着一个死句柄会让菜单项静默无效。
 */
const handles = new Map<string, TerminalSurfaceHandle>();

export function registerTerminalHandle(
  nodeId: string,
  handle: TerminalSurfaceHandle,
): () => void {
  handles.set(nodeId, handle);
  return () => {
    if (handles.get(nodeId) === handle) handles.delete(nodeId);
  };
}

export function terminalHandle(
  nodeId: string,
): TerminalSurfaceHandle | undefined {
  return handles.get(nodeId);
}
