import type { ITerminalOptions } from "@xterm/xterm";

import type { TerminalPreferences } from "@/app/preferences-store";

/** 偏好 → xterm 的外观 options（§18.3 设置项行）。 */
export function terminalAppearance(
  preferences: TerminalPreferences,
  element: HTMLElement,
): ITerminalOptions {
  return {
    fontFamily: preferences.fontFamily.trim() || terminalFontFamily(element),
    fontSize: preferences.fontSize,
    lineHeight: preferences.lineHeight,
    letterSpacing: preferences.letterSpacing,
    cursorStyle: preferences.cursorStyle,
    cursorBlink: preferences.cursorBlink,
    macOptionIsMeta: preferences.macOptionIsMeta,
    theme: terminalTheme(element),
  };
}

/* -------------------------------- 主题读取 -------------------------------- */

function cssValue(
  element: HTMLElement,
  name: string,
  fallback: string,
): string {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value || fallback;
}

function terminalFontFamily(element: HTMLElement): string {
  return cssValue(
    element,
    "--font-code",
    "ui-monospace, Menlo, Consolas, monospace",
  );
}

/**
 * 整张调色板都从 token 取（§4.3 规则一：功能代码里不出现字面色值）。
 *
 * `--term-*` 只在 `:root` 声明一次：`--term-bg` 在两套主题下都是深色，
 * ANSI 配色本来就是按深底设计的，跟着浅色主题翻转反而会让 TUI 读不了。
 * 兜底值只在 `getComputedStyle` 拿不到时用（jsdom、样式表还没加载）。
 */
export function terminalTheme(element: HTMLElement) {
  const token = (name: string, fallback: string) =>
    cssValue(element, name, fallback);
  const background = token("--term-bg", "#0a0a0a");
  return {
    background,
    foreground: token("--term-fg", "#e6e6e6"),
    cursor: token("--brand", "#0a84ff"),
    cursorAccent: background,
    selectionBackground: token("--term-selection", "#3a5a8c66"),
    black: token("--term-ansi-black", "#151515"),
    red: token("--term-ansi-red", "#ff453a"),
    green: token("--term-ansi-green", "#32d74b"),
    yellow: token("--term-ansi-yellow", "#ffd60a"),
    blue: token("--term-ansi-blue", "#0a84ff"),
    magenta: token("--term-ansi-magenta", "#bf5af2"),
    cyan: token("--term-ansi-cyan", "#6ac4dc"),
    white: token("--term-ansi-white", "#e6e6e6"),
    brightBlack: token("--term-ansi-bright-black", "#6b6b6b"),
    brightRed: token("--term-ansi-bright-red", "#ff6f66"),
    brightGreen: token("--term-ansi-bright-green", "#5ee07a"),
    brightYellow: token("--term-ansi-bright-yellow", "#ffe45e"),
    brightBlue: token("--term-ansi-bright-blue", "#4fa3ff"),
    brightMagenta: token("--term-ansi-bright-magenta", "#d18bf7"),
    brightCyan: token("--term-ansi-bright-cyan", "#8fd8e8"),
    brightWhite: token("--term-ansi-bright-white", "#ffffff"),
  };
}
