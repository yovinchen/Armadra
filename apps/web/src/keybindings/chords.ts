/**
 * 和弦：写法解析、事件匹配与显示（从 `keybindings.ts` 拆出）。
 *
 * 这一层只认字符串与 `KeyboardEvent`，不认命令表，也不认 React——
 * 冲突检测、录制、命令面板与那一个全局监听器都从这里取同一套规则，
 * 「设置页里显示的键」和「按下去真正生效的键」才不会各说各话。
 */
import { t } from "../app/preferences-store";

import type { KeyChords } from "./commands";

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
  const physical = /^(?:key([a-z])|digit([0-9]))$/.exec(lower);
  return physical
    ? (physical[1] ?? physical[2]!)
    : (TOKEN_TO_KEY[lower] ?? lower);
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

/** Native window/application shortcuts cannot be rebound to canvas actions. */
export function isWindowShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
  > & { code?: string },
  mac = isMacPlatform(),
): boolean {
  const key = /^Key[WQ]$/.test(event.code ?? "")
    ? event.code!.slice(3).toLowerCase()
    : event.key.toLowerCase();
  if (mac)
    return (
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      (key === "w" || key === "q")
    );
  return (
    !event.metaKey &&
    !event.shiftKey &&
    ((event.ctrlKey && !event.altKey && key === "w") ||
      (event.altKey && !event.ctrlKey && key === "f4"))
  );
}

export function isReservedChord(chord: string, mac = isMacPlatform()): boolean {
  const parsed = parseChord(chord, mac);
  return (
    !!parsed &&
    isWindowShortcut(
      {
        key: parsed.key,
        metaKey: parsed.meta,
        ctrlKey: parsed.ctrl,
        altKey: parsed.alt,
        shiftKey: parsed.shift,
      },
      mac,
    )
  );
}

/** Shared with conflict detection so modifier aliases/order match dispatch. */
export function chordSignature(
  chord: string,
  mac = isMacPlatform(),
): string | null {
  const parsed = parseChord(chord, mac);
  return parsed ? JSON.stringify(parsed) : null;
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
  return normaliseKeyToken(code) === token;
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
