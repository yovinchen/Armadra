/**
 * 全应用唯一的那个 keydown 监听器。
 *
 * 三道闸门，顺序固定：
 *  1. `scopes` —— 调用方只启用自己关心的那几组命令；
 *  2. `allowInTerminal` / `allowWhileTyping` —— 「终端优先」与「输入框区别
 *     对待」，这两条比按键本身更早决定放不放行；
 *  3. `when` —— 「只在编辑器里」「只在 mac 上」这类条件（见 `when.ts`）。
 *
 * 第 3 道是后加的，故意排在最后：`when` 能表达前两道的一部分，但前两道是
 * 每条命令都必须回答的问题，写成条件表达式反而会让每一行都重复一遍。
 */
import * as React from "react";

import { isMacPlatform, isWindowShortcut, matchKeyboardEvent } from "./chords";
import { COMMANDS, type CommandId, type CommandScope } from "./commands";
import type { MatchOptions } from "./chords";
import type { PlatformKeys } from "./commands";
import { keybindingContext } from "./context";
import { evaluateWhen } from "./when";

let keybindingSuspensions = 0;

/** Recording must suspend even handlers registered earlier on window. */
export function suspendKeybindings(): () => void {
  keybindingSuspensions += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    keybindingSuspensions -= 1;
  };
}

export type KeybindingHandlers = Partial<Record<CommandId, () => void>>;

export interface UseKeybindingsOptions extends MatchOptions {
  /** 关掉整套快捷键（例如全屏 overlay 自己接管键盘时）。 */
  enabled?: boolean;
  /** 只启用这些 scope 的命令。 */
  scopes?: readonly CommandScope[];
  /** 用户自定义键位。 */
  keymap?: Partial<Record<CommandId, PlatformKeys>>;
  /** 监听目标，默认 `window`。 */
  target?: Window | Document | HTMLElement | null;
}

/**
 * 装一个捕获阶段的 keydown 监听器，把命中的命令派发给 `handlers`。
 *
 * 捕获阶段是必须的：xterm 自己在 textarea 上监听 keydown，
 * 冒泡阶段再拦就晚了（键已经写进 PTY）。
 */
export function useKeybindings(
  handlers: KeybindingHandlers,
  options: UseKeybindingsOptions = {},
): void {
  const handlersRef = React.useRef(handlers);
  handlersRef.current = handlers;
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const enabled = options.enabled ?? true;
  const target = options.target;

  React.useEffect(() => {
    if (!enabled) return;
    const host: Window | Document | HTMLElement | null =
      target ?? (typeof window === "undefined" ? null : window);
    if (!host) return;

    function onKeyDown(event: Event) {
      const keyboardEvent = event as KeyboardEvent;
      // 输入法组词过程中的按键不是命令
      if (keyboardEvent.isComposing || keyboardEvent.keyCode === 229) return;

      const current = optionsRef.current;
      const mac = current.mac ?? isMacPlatform();
      if (keybindingSuspensions > 0 || isWindowShortcut(keyboardEvent, mac))
        return;
      const scopes = current.scopes;
      const context = keybindingContext({
        target: keyboardEvent.target,
        mac,
      });
      const inTerminal = context.terminalFocus === true;
      const typing = context.editing === true;

      for (const command of COMMANDS) {
        const handler = handlersRef.current[command.id];
        if (!handler) continue;
        if (scopes && !scopes.includes(command.scope)) continue;
        // 终端优先：终端里的 textarea 也算 typing，但只看 allowInTerminal
        if (inTerminal && !command.allowInTerminal) continue;
        if (typing && !command.allowWhileTyping) continue;
        if (!evaluateWhen(whenOf(command), context)) continue;

        const keys =
          current.keymap?.[command.id]?.[mac ? "mac" : "other"] ??
          command.defaultKeys[mac ? "mac" : "other"];
        if (!matchKeyboardEvent(keyboardEvent, keys, { mac })) continue;

        // 放行的那一条（⌘V）：浏览器接着发原生 `paste`，别的命令不再看这一下。
        // `COMMANDS` 是 `as const`，只有真的写了 `native` 的那一条才有这个键。
        if ("native" in command && command.native) return;

        keyboardEvent.preventDefault();
        keyboardEvent.stopPropagation();
        handler();
        return;
      }
    }

    host.addEventListener("keydown", onKeyDown, true);
    return () => host.removeEventListener("keydown", onKeyDown, true);
  }, [enabled, target]);
}

/** `COMMANDS` 是 `as const`，只有写了 `when` 的那几条才有这个键。 */
function whenOf(command: (typeof COMMANDS)[number]): string | undefined {
  return "when" in command ? command.when : undefined;
}
