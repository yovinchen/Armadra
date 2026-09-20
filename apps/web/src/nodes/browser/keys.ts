import { commandKeys, matchKeyboardEvent } from "@/keybindings";

/**
 * 从 guest 里回来的那一下按键，谁来接。
 *
 * guest 是另一个渲染进程，所以焦点在网页里时，`use-keybindings.ts` 里那个
 * 全应用唯一的捕获阶段 `keydown` 监听器**根本不会运行**——⌘K / ⌘P / ⌘T 在
 * 浏览器节点上没有反应，得先点回画布。主进程在 guest 的
 * `before-input-event` 上判断这一下属于谁（`shell-core/browser/guest-keys.ts`），
 * 属于 Armadra 的经 `browser:drive` 送回页面，由这里造一个等价事件。
 *
 * ## 为什么在节点自己的键盘根上派发，而不是 `window`
 *
 * `keybindingContext()` 用事件的 `target` 推 `when` 上下文。派在
 * `data-keybinding-scope="browser"` 那个根上，上下文就是「焦点在一个浏览器
 * 节点里」——这正是事实：那一下确实是在这个节点的页面里按的。派在 `window`
 * 上会得到 `canvasFocus`，于是 `browser.*` 那几条节点内命令永远不命中，而
 * 画布命令会在一个没有选中节点的上下文里执行。
 *
 * 捕获阶段的监听器装在 `window` 上，而捕获是从外往里走的，所以派在子元素上
 * 一样会被它收到——不需要也不应该派两次。
 */

/** 主进程送回来的那一下。字段是重建一个 `KeyboardEvent` 的最小集合。 */
export interface ForwardedChord {
  readonly key: string;
  /** 物理键位（`KeyK`）。`key` 被修饰键改过时匹配器回落到它。 */
  readonly code?: string;
  readonly meta?: boolean;
  readonly control?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

/**
 * 命令里带的字段不一定是这个形状——`browser:drive` 是一条共用通道，
 * 载荷类型在另一个包里。缺 `key` 的一律不重放：一个 `key` 为空的
 * `KeyboardEvent` 不会命中任何和弦，派它出去只是多一次无声的分发。
 */
export function parseForwardedChord(raw: unknown): ForwardedChord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.key !== "string" || value.key === "") return null;
  return {
    key: value.key,
    code: typeof value.code === "string" ? value.code : undefined,
    meta: value.meta === true,
    control: value.control === true,
    shift: value.shift === true,
    alt: value.alt === true,
  };
}

/**
 * 造出那个事件。单独一个函数，因为它是这条路上唯一能被单测钉住的东西：
 * 派发本身要一棵真实的 DOM 树。
 */
export function chordEvent(chord: ForwardedChord): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: chord.key,
    code: chord.code ?? "",
    metaKey: chord.meta === true,
    ctrlKey: chord.control === true,
    shiftKey: chord.shift === true,
    altKey: chord.alt === true,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
}

/** 重放。目标为空（节点还没挂上根）时什么也不做，返回是否派出去了。 */
export function replayChord(
  target: HTMLElement | null,
  chord: ForwardedChord,
): boolean {
  if (!target) return false;
  target.dispatchEvent(chordEvent(chord));
  return true;
}

/* ----------------------------- 节点内的那几条 ----------------------------- */

/**
 * `scope: "browser"` 的四条命令。
 *
 * 它们**不能**靠重放来触发，原因在 `apps/web/src/app/use-app-keybindings.ts:69-75`：
 * 那个全应用唯一的派发器给 `COMMANDS` 里**每一条** id 都装了处理函数，装在
 * `window` 上。捕获阶段从外往里走，于是它先命中、`preventDefault` +
 * `stopPropagation`，再调 `dispatch.run("browser.reload")`——而那条 id 不在
 * 画布命令注册表里，`runCanvasCommand` 静默返回 false。节点自己那个装在子树
 * 根上的监听器**永远收不到这一下**。
 *
 * 所以转发回来的和弦先在这里对一次键位表：命中 `browser.*` 的直接交给节点的
 * 处理函数，其余的才重放给上面那个派发器。对的是**生效中的**键位
 * （`commandKeys` 读的是 `setActiveKeymap` 推进去的那一份），所以用户在设置
 * 里改过键，这里跟着改。
 */
export const BROWSER_NODE_COMMANDS = [
  "browser.reload",
  "browser.back",
  "browser.forward",
  "browser.focusAddress",
] as const;

export type BrowserNodeCommand = (typeof BROWSER_NODE_COMMANDS)[number];

/** 这一下和弦是哪一条节点内命令，都不是就 `null`。 */
export function browserCommandFor(
  chord: ForwardedChord,
): BrowserNodeCommand | null {
  const event = chordEvent(chord);
  for (const id of BROWSER_NODE_COMMANDS) {
    if (matchKeyboardEvent(event, commandKeys(id))) return id;
  }
  return null;
}
