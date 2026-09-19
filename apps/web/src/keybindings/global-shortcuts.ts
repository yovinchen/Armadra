/**
 * 系统全局热键的页面这一半。
 *
 * 壳负责向操作系统注册（`apps/desktop/src/main/shortcuts.ts`），页面负责三件
 * 事：把当前键位里 `global` 作用域的那几条翻成 accelerator 交过去、把壳报回
 * 来的结果留给设置页显示、以及在热键触发时派发那条命令。
 *
 * 「新建终端节点」不在壳里实现：壳不知道什么是终端节点，让它自己去建就会
 * 出现第二套和画布不一致的实现。壳只把窗口叫回前台并发一条事件，真正的动作
 * 仍然是画布的那条命令。
 */
import { create } from "zustand";

import { isDesktop } from "../platform";
import { acceleratorFor } from "./accelerator";
import { commandKeys } from "./active";
import { commandsInScope, type CommandId, type PlatformKeys } from "./commands";

/** 壳对一条请求的答复。 */
export type GlobalShortcutState = "bound" | "unbound" | "invalid" | "taken";

export interface GlobalShortcutOutcome {
  id: string;
  state: GlobalShortcutState;
}

export interface GlobalBinding {
  id: CommandId;
  /** Electron accelerator，空串表示「这一条没有绑」。 */
  accelerator: string;
}

/** 这台机器上要注册的那几条，按当前生效的键位算出来。 */
export function globalBindings(
  keymap?: Partial<Record<CommandId, PlatformKeys>>,
): GlobalBinding[] {
  return commandsInScope("global").map((command) => ({
    id: command.id,
    accelerator: acceleratorFor(commandKeys(command.id, { keymap })),
  }));
}

/** 把这张表交给壳（`window.armadra.shortcuts`），答复是 `{ id, state }[]`。 */
async function applyInShell(
  bindings: GlobalBinding[],
): Promise<GlobalShortcutOutcome[]> {
  const shell = typeof window === "undefined" ? undefined : window.armadra;
  if (!shell) return [];
  return (await shell.shortcuts.apply(bindings)) as GlobalShortcutOutcome[];
}

interface GlobalShortcutStore {
  /** 每条命令最后一次注册的结果；没试过的不在里面。 */
  outcomes: Record<string, GlobalShortcutState>;
  apply: (bindings: GlobalBinding[]) => Promise<void>;
}

export const useGlobalShortcuts = create<GlobalShortcutStore>((set) => ({
  outcomes: {},
  async apply(bindings) {
    if (!isDesktop()) return;
    try {
      const outcomes = await applyInShell(bindings);
      set({
        outcomes: Object.fromEntries(
          outcomes.map((outcome) => [outcome.id, outcome.state]),
        ),
      });
    } catch (cause) {
      // 注册不上时**不**假装装上了：设置页会照着 `outcomes` 说哪一条没生效，
      // 而一条空的结果表就是「这一轮什么也没确认」。
      console.error("global_shortcuts_apply failed", cause);
      set({ outcomes: {} });
    }
  },
}));

/**
 * 订阅热键触发。返回退订函数；不在桌面壳里时什么也不做。
 */
export function onGlobalShortcut(
  callback: (id: CommandId) => void,
): () => void {
  const shell = typeof window === "undefined" ? undefined : window.armadra;
  if (!shell) return () => undefined;
  return shell.shortcuts.onTriggered((id) => callback(id as CommandId));
}

/** 哪条画布命令由哪个全局热键代跑。 */
export const GLOBAL_SHORTCUT_ACTIONS: Partial<Record<CommandId, CommandId>> = {
  "global.newTerminal": "canvas.newTerminal",
};
