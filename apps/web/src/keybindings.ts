import * as React from "react";

import { t } from "./app/preferences-store";

/**
 * 快捷键注册表 —— docs/v3-agent-terminal-plan.md §8。
 *
 * 这是 Phase 1 四个界面 agent 的跨模块接口：命令面板、Dock、右键菜单、
 * 设置页都从这里读 id 与默认键，谁都不许再各自 `addEventListener("keydown")`。
 *
 * 三条规则决定了这份表的形状：
 *  1. **只有一个监听器。** `useKeybindings` 在捕获阶段装一个 keydown，
 *     命中就 `preventDefault`。多个监听器互相抢 ⌘W 是上一版的老问题。
 *  2. **终端优先。** 节点里跑的是真 CLI，绝大多数组合键必须原样进 xterm；
 *     只有 `allowInTerminal` 的少数几条会被应用截走（§8 明确列了 7 条）。
 *  3. **输入框区别对待。** `allowWhileTyping` 单独一位，因为“在便签里打字”
 *     和“在终端里打字”要放行的集合并不一样（⌘Z 在输入框里必须留给浏览器）。
 */

export type CommandScope = "app" | "canvas" | "terminal" | "scm";

/**
 * 一个平台上的默认按键。
 *
 * 语法：`Mod+Shift+K`。修饰键 `Mod` / `Ctrl` / `Shift` / `Alt` / `Meta`，
 * `Mod` 在 macOS 展开成 ⌘、其余平台展开成 Ctrl。
 * 逗号分隔多个等价写法（`Backspace,Delete`），任一命中即可。
 * `null` 表示该平台默认不绑定。
 */
export type KeyChords = string | null;

export interface PlatformKeys {
  mac: KeyChords;
  other: KeyChords;
}

export interface CommandSpec {
  id: string;
  /**
   * i18n 键（`i18n/commands.ts`），不是文案。
   *
   * 这张表是模块级常量、在任何 React 之外求值，存文案就等于把语言定死在
   * 加载那一刻；命令面板与设置页在渲染时 `t(labelKey)`，切语言立刻跟着变。
   */
  labelKey: string;
  scope: CommandScope;
  defaultKeys: PlatformKeys;
  /** 焦点在终端（`.xterm`）里时是否仍然由应用接管。 */
  allowInTerminal: boolean;
  /** 焦点在输入框 / textarea / contenteditable 里时是否仍然由应用接管。 */
  allowWhileTyping: boolean;
}

/** 两个平台绑同一套键时的简写。 */
function both(chords: KeyChords): PlatformKeys {
  return { mac: chords, other: chords };
}

export const COMMANDS = [
  // ── app：全局壳，终端里也放行 ────────────────────────────────────
  {
    id: "app.commandPalette",
    labelKey: "cmd.app.commandPalette",
    scope: "app",
    defaultKeys: both("Mod+K"),
    allowInTerminal: true,
    allowWhileTyping: true,
  },
  {
    id: "app.settings",
    labelKey: "cmd.app.settings",
    scope: "app",
    defaultKeys: both("Mod+Comma"),
    allowInTerminal: true,
    allowWhileTyping: true,
  },
  {
    id: "app.sidebar",
    labelKey: "cmd.app.sidebar",
    scope: "app",
    defaultKeys: both("Mod+Shift+L"),
    allowInTerminal: true,
    allowWhileTyping: true,
  },
  {
    id: "app.explorer",
    labelKey: "cmd.app.explorer",
    scope: "app",
    defaultKeys: both("Mod+Shift+E"),
    allowInTerminal: true,
    allowWhileTyping: true,
  },
  {
    id: "app.sourceControl",
    labelKey: "cmd.app.sourceControl",
    scope: "app",
    defaultKeys: both("Mod+Shift+G"),
    allowInTerminal: true,
    allowWhileTyping: true,
  },

  // ── canvas：画布与节点 ──────────────────────────────────────────
  {
    id: "canvas.newTerminal",
    labelKey: "cmd.canvas.newTerminal",
    scope: "canvas",
    defaultKeys: both("Mod+T"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.newAgent",
    labelKey: "cmd.canvas.newAgent",
    scope: "canvas",
    defaultKeys: both("Mod+Shift+C"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.focusMode",
    labelKey: "cmd.canvas.focusMode",
    scope: "canvas",
    defaultKeys: both("Mod+Shift+F"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.maximize",
    labelKey: "cmd.canvas.maximize",
    scope: "canvas",
    defaultKeys: both("Mod+Shift+Enter"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.closeNode",
    labelKey: "cmd.canvas.closeNode",
    scope: "canvas",
    defaultKeys: both("Mod+W"),
    allowInTerminal: true,
    allowWhileTyping: false,
  },
  {
    id: "canvas.undo",
    labelKey: "cmd.canvas.undo",
    scope: "canvas",
    defaultKeys: both("Mod+Z"),
    allowInTerminal: false,
    // 输入框里的 ⌘Z 必须留给浏览器的文本撤销
    allowWhileTyping: false,
  },
  {
    id: "canvas.redo",
    labelKey: "cmd.canvas.redo",
    scope: "canvas",
    defaultKeys: both("Mod+Shift+Z"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tidy",
    labelKey: "cmd.canvas.tidy",
    scope: "canvas",
    defaultKeys: both("Mod+Shift+A"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.zoomIn",
    labelKey: "cmd.canvas.zoomIn",
    scope: "canvas",
    // ⌘= 与 ⌘+ 是同一个物理键，收两种写法（⇧ 与否都算）。
    defaultKeys: both("Mod+Equal,Mod+Shift+Equal"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.zoomOut",
    labelKey: "cmd.canvas.zoomOut",
    scope: "canvas",
    defaultKeys: both("Mod+Minus"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.zoom100",
    labelKey: "cmd.canvas.zoom100",
    scope: "canvas",
    defaultKeys: both("Mod+0"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.fitView",
    labelKey: "cmd.canvas.fitView",
    scope: "canvas",
    defaultKeys: both("Mod+1"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.focusLeft",
    labelKey: "cmd.canvas.focusLeft",
    scope: "canvas",
    defaultKeys: both("Mod+ArrowLeft"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.focusRight",
    labelKey: "cmd.canvas.focusRight",
    scope: "canvas",
    defaultKeys: both("Mod+ArrowRight"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.focusUp",
    labelKey: "cmd.canvas.focusUp",
    scope: "canvas",
    defaultKeys: both("Mod+ArrowUp"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.focusDown",
    labelKey: "cmd.canvas.focusDown",
    scope: "canvas",
    defaultKeys: both("Mod+ArrowDown"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.delete",
    labelKey: "cmd.canvas.delete",
    scope: "canvas",
    // macOS 上 ⌫ 是主删除键，⌦ 只有全尺寸键盘才有；两个都收
    defaultKeys: { mac: "Backspace,Delete", other: "Delete,Backspace" },
    allowInTerminal: false,
    allowWhileTyping: false,
  },

  // ── canvas：tldraw 偏好（2026-09-05 用户反馈：偏好要能在系统里配） ──
  //
  // 键位照抄 tldraw 原生偏好菜单（Q / ⌘\' / ⌘.），这样从 tldraw 过来的人
  // 按下去是同一件事。三条都写 `preferences-store` 的 `whiteboard` 段，
  // 偏好菜单与设置页读的是同一个值。
  {
    id: "canvas.toggleToolLock",
    labelKey: "cmd.canvas.toggleToolLock",
    scope: "canvas",
    defaultKeys: both("Q"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.toggleGrid",
    labelKey: "cmd.canvas.toggleGrid",
    scope: "canvas",
    defaultKeys: both("Mod+Quote"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.toggleFocus",
    labelKey: "cmd.canvas.toggleFocus",
    scope: "canvas",
    defaultKeys: both("Mod+Period"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },

  // ── canvas：白板工具（tldraw 计划 §5 的工具键表） ────────────────
  //
  // 键位照抄 tldraw 默认（V / H / D / ⇧D / R / L / A / T / F），这样从
  // 别的白板过来的人不用重学；`allowInTerminal` 与 `allowWhileTyping`
  // 全是 false —— 单字母键在终端里就是普通输入，绝不能被应用截走。
  {
    id: "canvas.tool.select",
    labelKey: "cmd.canvas.tool.select",
    scope: "canvas",
    defaultKeys: both("V"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.hand",
    labelKey: "cmd.canvas.tool.hand",
    scope: "canvas",
    defaultKeys: both("H"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.draw",
    labelKey: "cmd.canvas.tool.draw",
    scope: "canvas",
    defaultKeys: both("D"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.highlight",
    labelKey: "cmd.canvas.tool.highlight",
    scope: "canvas",
    defaultKeys: both("Shift+D"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.geo",
    labelKey: "cmd.canvas.tool.geo",
    scope: "canvas",
    defaultKeys: both("R"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.line",
    labelKey: "cmd.canvas.tool.line",
    scope: "canvas",
    defaultKeys: both("L"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.arrow",
    labelKey: "cmd.canvas.tool.arrow",
    scope: "canvas",
    defaultKeys: both("A"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.text",
    labelKey: "cmd.canvas.tool.text",
    scope: "canvas",
    defaultKeys: both("T"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },
  {
    id: "canvas.tool.frame",
    labelKey: "cmd.canvas.tool.frame",
    scope: "canvas",
    defaultKeys: both("F"),
    allowInTerminal: false,
    allowWhileTyping: false,
  },

  // ── terminal ───────────────────────────────────────────────────
  {
    id: "terminal.search",
    labelKey: "cmd.terminal.search",
    scope: "terminal",
    defaultKeys: both("Mod+F"),
    allowInTerminal: true,
    allowWhileTyping: false,
  },

  // ── scm ────────────────────────────────────────────────────────
  {
    id: "scm.commit",
    labelKey: "cmd.scm.commit",
    scope: "scm",
    defaultKeys: both("Mod+Enter"),
    allowInTerminal: false,
    // 提交信息输入框里按 ⌘⏎ 就是这条命令的主要用法，必须放行
    allowWhileTyping: true,
  },
] as const satisfies readonly CommandSpec[];

export type CommandId = (typeof COMMANDS)[number]["id"];

export type Command = CommandSpec & { id: CommandId };

export const COMMAND_BY_ID = Object.fromEntries(
  COMMANDS.map((command) => [command.id, command]),
) as Record<CommandId, Command>;

export function commandsInScope(scope: CommandScope): readonly Command[] {
  return COMMANDS.filter((command) => command.scope === scope);
}

/* ────────────────────────────────────────────────────────────────────
 * 平台判定
 * ──────────────────────────────────────────────────────────────── */

/**
 * 是否 macOS 键盘布局。
 *
 * `navigator.platform` 已废弃但在 WKWebView / WebView2 上仍最可靠；
 * 读不到时退回 UA 串。测试与 SSR 路径可以直接传参覆盖。
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData;
  const source = uaData?.platform || navigator.platform || navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(source);
}

/* ────────────────────────────────────────────────────────────────────
 * 按键解析与匹配
 * ──────────────────────────────────────────────────────────────── */

interface Chord {
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** 归一后的主键 token，例如 `k` / `enter` / `arrowleft` / `,`。 */
  key: string;
}

/** 书写用的 token → `KeyboardEvent.key` 的小写形式。 */
const TOKEN_TO_KEY: Record<string, string> = {
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  backquote: "`",
  minus: "-",
  equal: "=",
  bracketleft: "[",
  bracketright: "]",
  space: " ",
  esc: "escape",
  return: "enter",
  del: "delete",
};

function normaliseKeyToken(token: string): string {
  const lower = token.toLowerCase();
  return TOKEN_TO_KEY[lower] ?? lower;
}

function parseChord(chord: string, mac: boolean): Chord | null {
  const parts = chord
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const result: Chord = {
    meta: false,
    ctrl: false,
    shift: false,
    alt: false,
    key: "",
  };
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const lower = part.toLowerCase();
    const isLast = index === parts.length - 1;
    if (!isLast || parts.length === 1) {
      // 修饰键只能出现在最后一个 token 之前；单 token 的和弦本身就是主键
    }
    if (isLast) {
      result.key = normaliseKeyToken(part);
      continue;
    }
    switch (lower) {
      case "mod":
        if (mac) result.meta = true;
        else result.ctrl = true;
        break;
      case "cmd":
      case "meta":
      case "command":
        result.meta = true;
        break;
      case "ctrl":
      case "control":
        result.ctrl = true;
        break;
      case "shift":
        result.shift = true;
        break;
      case "alt":
      case "option":
        result.alt = true;
        break;
      default:
        // 未知修饰键：整条和弦作废，宁可不绑也不要误绑
        return null;
    }
  }
  return result.key ? result : null;
}

/**
 * 事件的主键是否匹配 token。
 *
 * 先比 `event.key`（大小写无关），再退回 `event.code`——中文/俄文等
 * 非拉丁布局下 `event.key` 拿到的是本地字符，只有 `code` 是稳定的。
 */
function keyMatches(event: KeyboardEvent, token: string): boolean {
  if (event.key && event.key.toLowerCase() === token) return true;
  const code = event.code;
  if (!code) return false;
  if (/^[a-z]$/.test(token)) return code === `Key${token.toUpperCase()}`;
  if (/^[0-9]$/.test(token)) return code === `Digit${token}`;
  return code.toLowerCase() === token;
}

function chordMatches(event: KeyboardEvent, chord: Chord): boolean {
  return (
    event.metaKey === chord.meta &&
    event.ctrlKey === chord.ctrl &&
    event.shiftKey === chord.shift &&
    event.altKey === chord.alt &&
    keyMatches(event, chord.key)
  );
}

export interface MatchOptions {
  /** 覆盖平台判定；不传时按运行环境推断。 */
  mac?: boolean;
}

/**
 * 键盘事件是否命中某组按键写法。
 *
 * `keys` 可以是逗号分隔的多个等价和弦；`null`/空串永远不命中。
 * 修饰键要求**完全一致**：`Mod+K` 不会被 ⌘⇧K 触发。
 */
export function matchKeyboardEvent(
  event: KeyboardEvent,
  keys: KeyChords | undefined,
  options: MatchOptions = {},
): boolean {
  if (!keys) return false;
  const mac = options.mac ?? isMacPlatform();
  return keys
    .split(",")
    .map((chord) => chord.trim())
    .filter(Boolean)
    .some((chord) => {
      const parsed = parseChord(chord, mac);
      return parsed ? chordMatches(event, parsed) : false;
    });
}

/* ────────────────────────────────────────────────────────────────────
 * 展示
 * ──────────────────────────────────────────────────────────────── */

/**
 * 空格是唯一需要翻译的键名（其余是符号或拉丁字母，两种语言写法一致），
 * 所以两张表都存这个哨兵，`formatChord` 渲染时才翻。
 */
const SPACE_KEY = "keys.space";

const MAC_KEY_SYMBOLS: Record<string, string> = {
  enter: "⏎",
  escape: "⎋",
  backspace: "⌫",
  delete: "⌦",
  tab: "⇥",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  " ": SPACE_KEY,
};

const OTHER_KEY_LABELS: Record<string, string> = {
  enter: "Enter",
  escape: "Esc",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  " ": SPACE_KEY,
};

function formatChord(chord: string, mac: boolean): string {
  const parsed = parseChord(chord, mac);
  if (!parsed) return "";
  const named = mac
    ? (MAC_KEY_SYMBOLS[parsed.key] ?? parsed.key.toUpperCase())
    : (OTHER_KEY_LABELS[parsed.key] ?? parsed.key.toUpperCase());
  const key = named === SPACE_KEY ? t(SPACE_KEY) : named;

  if (mac) {
    // Apple HIG 的修饰键顺序：⌃ ⌥ ⇧ ⌘
    const prefix =
      (parsed.ctrl ? "⌃" : "") +
      (parsed.alt ? "⌥" : "") +
      (parsed.shift ? "⇧" : "") +
      (parsed.meta ? "⌘" : "");
    return prefix + key;
  }

  const parts: string[] = [];
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  if (parsed.meta) parts.push("Win");
  parts.push(key);
  return parts.join("+");
}

/**
 * 给人看的按键串：mac 下 `⌘⇧K`，其余平台 `Ctrl+Shift+K`。
 * 多个等价写法用 ` / ` 连接。未绑定返回空串。
 */
export function formatKeys(
  keys: KeyChords | undefined,
  options: MatchOptions = {},
): string {
  if (!keys) return "";
  const mac = options.mac ?? isMacPlatform();
  return keys
    .split(",")
    .map((chord) => formatChord(chord.trim(), mac))
    .filter(Boolean)
    .join(" / ");
}

/** 取某条命令在当前平台上的按键（可被用户自定义键位覆盖）。 */
export function commandKeys(
  id: CommandId,
  options: MatchOptions & {
    keymap?: Partial<Record<CommandId, PlatformKeys>>;
  } = {},
): KeyChords {
  const mac = options.mac ?? isMacPlatform();
  const platformKeys = options.keymap?.[id] ?? COMMAND_BY_ID[id].defaultKeys;
  return mac ? platformKeys.mac : platformKeys.other;
}

/** 命令在当前平台上的显示串，命令面板与菜单右侧直接用。 */
export function commandKeysLabel(
  id: CommandId,
  options: MatchOptions & {
    keymap?: Partial<Record<CommandId, PlatformKeys>>;
  } = {},
): string {
  return formatKeys(commandKeys(id, options), options);
}

/* ────────────────────────────────────────────────────────────────────
 * 上下文判定
 * ──────────────────────────────────────────────────────────────── */

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

/* ────────────────────────────────────────────────────────────────────
 * Hook
 * ──────────────────────────────────────────────────────────────── */

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
      const scopes = current.scopes;
      const inTerminal = isTerminalTarget(keyboardEvent.target);
      const typing = !inTerminal && isTypingTarget(keyboardEvent.target);

      for (const command of COMMANDS) {
        const handler = handlersRef.current[command.id];
        if (!handler) continue;
        if (scopes && !scopes.includes(command.scope)) continue;
        // 终端优先：终端里的 textarea 也算 typing，但只看 allowInTerminal
        if (inTerminal && !command.allowInTerminal) continue;
        if (typing && !command.allowWhileTyping) continue;

        const keys =
          current.keymap?.[command.id]?.[mac ? "mac" : "other"] ??
          command.defaultKeys[mac ? "mac" : "other"];
        if (!matchKeyboardEvent(keyboardEvent, keys, { mac })) continue;

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
