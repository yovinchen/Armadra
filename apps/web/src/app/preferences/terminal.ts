import { readStored, storedBoolean, storedEnum, storedNumber } from "./storage";

const TERM_FONT_FAMILY_KEY = "armadra.terminal.fontFamily";
const TERM_FONT_SIZE_KEY = "armadra.terminal.fontSize";
const TERM_LINE_HEIGHT_KEY = "armadra.terminal.lineHeight";
const TERM_LETTER_SPACING_KEY = "armadra.terminal.letterSpacing";
const TERM_CURSOR_STYLE_KEY = "armadra.terminal.cursorStyle";
const TERM_CURSOR_BLINK_KEY = "armadra.terminal.cursorBlink";
const TERM_OPTION_META_KEY = "armadra.terminal.macOptionIsMeta";
const TERM_COPY_ON_SELECT_KEY = "armadra.terminal.copyOnSelect";
const TERM_WEBGL_KEY = "armadra.terminal.webgl";

/* ------------------------------- 终端外观 --------------------------------- */

export const TERMINAL_CURSOR_STYLES = ["block", "bar", "underline"] as const;
export type TerminalCursorStyle = (typeof TERMINAL_CURSOR_STYLES)[number];

/**
 * 终端外观偏好（计划书 §18.3）。
 *
 * 单独成型是因为 `TerminalSurface` 要把整块当依赖：任何一项变化都要
 * 重设 xterm options 再 fit 一次，而不是每项各挂一个 effect。
 * `fontFamily` 为空表示「跟随 `--font-code`」。
 */
export interface TerminalPreferences {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  /** macOS 上 Option 当 Meta；默认关，否则 ⌥ 组合字符打不出来（§18.3 键盘行）。 */
  macOptionIsMeta: boolean;
  /** 选中即复制。默认关：选错一次就会把剪贴板冲掉。 */
  copyOnSelect: boolean;
  /** WebGL 渲染器；默认关，DOM 渲染器在画布缩放下更清晰（§18.2 规则 5）。 */
  webgl: boolean;
}

export const TERMINAL_FONT_SIZE_RANGE = [10, 20] as const;
export const TERMINAL_LINE_HEIGHT_RANGE = [1, 1.6] as const;

/**
 * 默认字号与行高（契约 §3.4，2026-09-19：13/1.2 → 12/1.15）。
 *
 * 一个 960×600 的终端在 12px 下排得下约 120×36——120 列正好是 CLI 排版的
 * 惯用宽度，13px 只有约 110 列，很多工具的表格会被折行。
 *
 * **只是默认值**：`storedNumber` 先读 localStorage，已经调过字号的用户
 * 一个字都不会被改（`readStored` 拿到值就不看这里）。
 */
export const TERMINAL_DEFAULT_FONT_SIZE = 12;
export const TERMINAL_DEFAULT_LINE_HEIGHT = 1.15;

export const TERMINAL_KEYS: Record<keyof TerminalPreferences, string> = {
  fontFamily: TERM_FONT_FAMILY_KEY,
  fontSize: TERM_FONT_SIZE_KEY,
  lineHeight: TERM_LINE_HEIGHT_KEY,
  letterSpacing: TERM_LETTER_SPACING_KEY,
  cursorStyle: TERM_CURSOR_STYLE_KEY,
  cursorBlink: TERM_CURSOR_BLINK_KEY,
  macOptionIsMeta: TERM_OPTION_META_KEY,
  copyOnSelect: TERM_COPY_ON_SELECT_KEY,
  webgl: TERM_WEBGL_KEY,
};

export function storedTerminalPreferences(): TerminalPreferences {
  return {
    fontFamily: readStored(TERM_FONT_FAMILY_KEY) ?? "",
    fontSize: storedNumber(
      TERM_FONT_SIZE_KEY,
      TERMINAL_DEFAULT_FONT_SIZE,
      TERMINAL_FONT_SIZE_RANGE[0],
      TERMINAL_FONT_SIZE_RANGE[1],
    ),
    lineHeight: storedNumber(
      TERM_LINE_HEIGHT_KEY,
      TERMINAL_DEFAULT_LINE_HEIGHT,
      TERMINAL_LINE_HEIGHT_RANGE[0],
      TERMINAL_LINE_HEIGHT_RANGE[1],
    ),
    letterSpacing: storedNumber(TERM_LETTER_SPACING_KEY, 0, -2, 4),
    cursorStyle: storedEnum(
      TERM_CURSOR_STYLE_KEY,
      TERMINAL_CURSOR_STYLES,
      "block",
    ),
    cursorBlink: storedBoolean(TERM_CURSOR_BLINK_KEY, true),
    macOptionIsMeta: storedBoolean(TERM_OPTION_META_KEY, false),
    copyOnSelect: storedBoolean(TERM_COPY_ON_SELECT_KEY, false),
    webgl: storedBoolean(TERM_WEBGL_KEY, false),
  };
}
