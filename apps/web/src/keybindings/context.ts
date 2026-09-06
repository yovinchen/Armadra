/**
 * 焦点在哪里——`when` 条件求值用的上下文，以及它依赖的几个 DOM 判定。
 *
 * 终端与「正在打字」是从元素本身认出来的（xterm 有固定 class，输入控件有
 * 固定标签），编辑器与浏览器节点则由节点自己在 DOM 上标 `data-keybinding-scope`。
 * 用属性而不是 class 或组件树：判定发生在 window 的捕获阶段监听器里，
 * 那里只有一个 `EventTarget`，`closest()` 是唯一能从它问出「我在谁里面」的手段，
 * 而一个专用属性不会被样式重构顺手改掉。
 */
import { NODE_SCOPES, type NodeScope } from "./commands";
import type { WhenContext } from "./when";

/** 节点在自己的根元素上标这个属性，值是 `editor` / `browser`。 */
export const SCOPE_ATTRIBUTE = "data-keybinding-scope";

/** 事件目标是否在 xterm 终端内。 */
export function isTerminalTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return Boolean(element?.closest(".xterm"));
}

/** 事件目标是否是可编辑控件（含 contenteditable）。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) {
    // 复选框、单选、按钮型 input 不算“正在打字”
    return ![
      "checkbox",
      "radio",
      "button",
      "submit",
      "reset",
      "range",
    ].includes(element.type);
  }
  return Boolean(
    element.closest("[contenteditable=''],[contenteditable='true']"),
  );
}

/** 事件目标落在哪个节点内部的作用域里；都不在时是 `null`。 */
export function nodeScopeOf(target: EventTarget | null): NodeScope | null {
  const element = target instanceof Element ? target : null;
  const host = element?.closest(`[${SCOPE_ATTRIBUTE}]`);
  const value = host?.getAttribute(SCOPE_ATTRIBUTE);
  return NODE_SCOPES.find((scope) => scope === value) ?? null;
}

export interface ContextInput {
  target: EventTarget | null;
  mac: boolean;
  /** 覆盖平台名；不传时按 `mac` 推断（其余平台按 UA 区分不了，统一 windows）。 */
  platform?: string;
}

/**
 * 事件目标 → `when` 上下文。
 *
 * 四个焦点键互斥，与 `whenContexts()` 穷举时的假设一致：焦点同一时刻只有
 * 一处，而 `canvasFocus` 的定义就是「不在上面三处、也不在任何输入控件里」。
 * 判定顺序是终端 → 编辑器 / 浏览器 → 其它，因为终端里那个 textarea 同时满足
 * 「在终端里」与「正在打字」，而终端优先是这套快捷键的第一条规则。
 */
export function keybindingContext({
  target,
  mac,
  platform,
}: ContextInput): WhenContext {
  const terminal = isTerminalTarget(target);
  const scope = terminal ? null : nodeScopeOf(target);
  const typing = !terminal && isTypingTarget(target);
  return {
    platform: platform ?? (mac ? "mac" : "windows"),
    terminalFocus: terminal,
    editorFocus: scope === "editor",
    browserFocus: scope === "browser",
    canvasFocus: !terminal && scope === null && !typing,
    editing: typing,
  };
}
