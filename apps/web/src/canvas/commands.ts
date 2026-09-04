import type { CommandId } from "../keybindings";

/**
 * 画布命令注册表（§13.5）。
 *
 * 快捷键、Dock、命令面板、右键菜单都不直接调 React Flow —— 缩放、
 * 适应视图、最大化这些动作只有挂在 `<ReactFlowProvider>` 里的组件才能做。
 * `CanvasWorkspace` 挂载时把实现注册进来，壳只按 id 触发。
 *
 * 没注册的 id 触发时是安全的空操作（画布还没挂上时按 ⌘Z 不应该报错）。
 */

/**
 * `keybindings.ts` 里没有默认键、但菜单与 Dock 需要的画布命令。
 * 与 `CommandId` 合成一个联合，这样 shell 传 `CommandId` 也能直接调。
 */
export const EXTRA_CANVAS_COMMANDS = [
  "canvas.selectAll",
  "canvas.group",
  "canvas.restore",
  "canvas.duplicate",
  "canvas.toggleMarkdown",
] as const;

export type ExtraCanvasCommandId = (typeof EXTRA_CANVAS_COMMANDS)[number];
export type CanvasCommandId = CommandId | ExtraCanvasCommandId;

const registry = new Map<CanvasCommandId, () => void>();

/** 注册（或覆盖）一条命令，返回注销函数。 */
export function registerCanvasCommand(
  id: CanvasCommandId,
  run: () => void,
): () => void {
  registry.set(id, run);
  return () => {
    if (registry.get(id) === run) registry.delete(id);
  };
}

/** 批量注册；`CanvasWorkspace` 的 effect 用一次。 */
export function registerCanvasCommands(
  commands: Partial<Record<CanvasCommandId, () => void>>,
): () => void {
  const disposers = Object.entries(commands).map(([id, run]) =>
    registerCanvasCommand(id as CanvasCommandId, run as () => void),
  );
  return () => disposers.forEach((dispose) => dispose());
}

/** 触发一条命令；返回是否真的有实现接住。 */
export function runCanvasCommand(id: CanvasCommandId): boolean {
  const run = registry.get(id);
  if (!run) return false;
  run();
  return true;
}

export function hasCanvasCommand(id: CanvasCommandId): boolean {
  return registry.has(id);
}

/** 仅测试用。 */
export function clearCanvasCommands() {
  registry.clear();
}
