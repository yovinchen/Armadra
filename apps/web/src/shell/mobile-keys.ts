/**
 * 手机软键盘工具条上的那几个键（客户端平台设计，移动端能力矩阵）。
 *
 * 触摸键盘上没有 Esc、Tab、方向键，也没有 Ctrl 修饰键，可这几样正是 CLI 里
 * 用得最多的。这张表把它们变成直接写进 PTY 的字节序列。
 *
 * Ctrl 刻意不是「粘住等下一次按键」的修饰键：系统键盘的按键不经过这个工具条，
 * 粘住了也修饰不到它们。按 Ctrl 展开的是真正会用到的那几个控制码，按一下发
 * 一个，然后收起来——这也是触摸终端普遍的做法。
 */

/** 转义符与控制码都用字符码拼，源码里不出现不可见字符。 */
const ESC = String.fromCharCode(0x1b);

/** `Ctrl+A` 是 0x01、`Ctrl+Z` 是 0x1a——就是字母序号。 */
export function controlCode(letter: string): string {
  const code = letter.toUpperCase().charCodeAt(0);
  if (code < 65 || code > 90) throw new Error("control keys are A–Z");
  return String.fromCharCode(code - 64);
}

export interface MobileKey {
  /** i18n 键，不是文案。 */
  labelKey: string;
  /** 写进 PTY 的原始序列。 */
  data: string;
}

/**
 * 常驻的一排。方向键用 `CSI A/B/C/D`（普通光标键模式）：应用光标键模式下的
 * `SS3` 形式只有部分全屏程序认，`CSI` 两种模式的 shell 都认。
 */
export const MOBILE_KEYS: MobileKey[] = [
  { labelKey: "mobile.key.escape", data: ESC },
  { labelKey: "mobile.key.tab", data: "\t" },
  { labelKey: "mobile.key.left", data: `${ESC}[D` },
  { labelKey: "mobile.key.down", data: `${ESC}[B` },
  { labelKey: "mobile.key.up", data: `${ESC}[A` },
  { labelKey: "mobile.key.right", data: `${ESC}[C` },
];

/** 按 Ctrl 展开的一排：CLI 里真正会用到的控制码。 */
export const MOBILE_CONTROL_KEYS: MobileKey[] = [
  "C",
  "D",
  "Z",
  "L",
  "R",
  "A",
  "E",
  "U",
  "K",
].map((letter) => ({
  labelKey: `mobile.key.ctrl${letter}`,
  data: controlCode(letter),
}));
