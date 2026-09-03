/**
 * 终端兼容性的纯逻辑（计划书 §18）。
 *
 * xterm 实例、DOM、WebSocket 都留在 `TerminalSurface`；这里只放能在
 * jsdom 里直接断言的三张表：
 *
 *  1. **fit 守卫**（§18.2 规则 2）——「跳动」的根因是 `fit()` → `resize` →
 *     整屏重绘 → 容器尺寸再变的反馈环。切断它的唯一办法是：算出来的
 *     列/行和当前一样就什么都不做。
 *  2. **按键策略**（§18.3 键盘行）——注册表里 `allowInTerminal` 的那几条
 *     归应用，其余一律进终端；⌘C 只在有选区时拦，⌘V 交给 xterm 的粘贴。
 *  3. **标题自动跟随**（§18.3 标题行）——用户手动改过名之后，OSC 0/2
 *     不再覆盖标题。
 */

import { COMMANDS, isMacPlatform, type CommandSpec } from "@/keybindings";

export { isMacPlatform };

/* --------------------------------- fit 守卫 -------------------------------- */

export interface Dimensions {
  cols: number;
  rows: number;
}

/**
 * `proposeDimensions()` 的结果值不值得真的 `fit()`。
 *
 * `null`（容器还没量出尺寸、字体还没加载）一律不 fit：这时候 fit 会把
 * 终端压成 1×1，等 ResizeObserver 下一次触发再来。亚像素抖动经
 * `Math.round` 之后落回同一组整数，于是也被这里挡掉。
 */
export function shouldRefit(
  proposed: Dimensions | null | undefined,
  current: Dimensions,
): boolean {
  if (!proposed) return false;
  const cols = Math.round(proposed.cols);
  const rows = Math.round(proposed.rows);
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return false;
  if (cols < 1 || rows < 1) return false;
  return cols !== current.cols || rows !== current.rows;
}

/* ------------------------------- 按键策略 --------------------------------- */

/**
 * 一次 keydown 的归属：
 *  - `app`：全局快捷键，`useKeybindings` 处理，不进终端。
 *  - `copy`：有选区的 ⌘C / Ctrl+Shift+C，我们自己写剪贴板。
 *  - `paste`：⌘V / Ctrl+Shift+V，交给 xterm 的 paste（应用开了 2004
 *    就自动变成括号粘贴）。
 *  - `terminal`：其余全部原样进终端（Ctrl+C/Z/D、方向键、F1–F12…）。
 */
export type KeyDisposition = "app" | "copy" | "paste" | "terminal";

/** 只用到 KeyboardEvent 的这几位，测试里给个字面量即可。 */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  type?: string;
}

export interface KeyContext {
  mac: boolean;
  /** 终端里当前是否有选区（决定 ⌘C 是复制还是 SIGINT）。 */
  hasSelection: boolean;
}

/**
 * 应用要截走的组合键。从注册表现算，避免这里和 `keybindings.ts` 各写一份：
 * `allowInTerminal` 为真 = 焦点在终端里也归应用。
 */
export function appChordsInTerminal(
  commands: readonly CommandSpec[] = COMMANDS,
  mac = isMacPlatform(),
): Set<string> {
  const chords = new Set<string>();
  for (const command of commands) {
    if (!command.allowInTerminal) continue;
    const keys = mac ? command.defaultKeys.mac : command.defaultKeys.other;
    if (!keys) continue;
    for (const chord of keys.split(",")) {
      const normalized = normalizeChord(chord, mac);
      if (normalized) chords.add(normalized);
    }
  }
  return chords;
}

/** `Mod+Shift+K` → `meta+shift+k`（mac）/ `ctrl+shift+k`（其余）。 */
function normalizeChord(chord: string, mac: boolean): string | null {
  const parts = chord
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key) return null;
  const modifiers = new Set<string>();
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "mod") modifiers.add(mac ? "meta" : "ctrl");
    else modifiers.add(lower);
  }
  return chordString(modifiers, key);
}

function chordString(modifiers: Set<string>, key: string): string {
  const order = ["ctrl", "alt", "shift", "meta"].filter((name) =>
    modifiers.has(name),
  );
  return [...order, canonicalKey(key)].join("+");
}

/** 键名归一：`Comma` / `,` / `ArrowLeft` 都要落到同一个串上。 */
function canonicalKey(key: string): string {
  const named: Record<string, string> = {
    comma: ",",
    period: ".",
    slash: "/",
    space: " ",
    esc: "escape",
    return: "enter",
  };
  const lower = key.toLowerCase();
  return named[lower] ?? lower;
}

export function eventChord(event: KeyLike): string {
  const modifiers = new Set<string>();
  if (event.ctrlKey) modifiers.add("ctrl");
  if (event.altKey) modifiers.add("alt");
  if (event.shiftKey) modifiers.add("shift");
  if (event.metaKey) modifiers.add("meta");
  return chordString(modifiers, event.key);
}

/**
 * 一次 keydown 归谁。`chords` 由 `appChordsInTerminal()` 预先算好并缓存，
 * 每次按键重算一遍整张注册表太贵。
 */
export function keyDisposition(
  event: KeyLike,
  context: KeyContext,
  chords: Set<string>,
): KeyDisposition {
  // 合成中的按键（IME）永远不归应用，也不该被 xterm 当普通键处理。
  if (event.key === "Process" || event.key === "Unidentified")
    return "terminal";

  const primary = context.mac ? event.metaKey : event.ctrlKey && event.shiftKey;
  const lower = event.key.toLowerCase();

  if (primary && lower === "c" && context.hasSelection) return "copy";
  if (primary && lower === "v") return "paste";

  return chords.has(eventChord(event)) ? "app" : "terminal";
}

/* ------------------------------- 标题自动 --------------------------------- */

/**
 * OSC 0/2 能不能覆盖节点标题。
 *
 * 节点 schema 里没有 `titleAuto` 位，也不允许加（迁移已冻结），所以规则
 * 从标题本身推：只要它还等于新建时的默认名（`终端` / `Claude Code` …），
 * 就认为用户没改过名，OSC 可以接管；一旦不等，说明改过，从此不再覆盖。
 */
export function titleIsAuto(
  currentTitle: string,
  defaults: readonly (string | undefined)[],
): boolean {
  const title = currentTitle.trim();
  if (!title) return true;
  return defaults.some(
    (value) => value !== undefined && value.trim() === title,
  );
}

/**
 * 每个节点最后一次由 OSC 写进去的标题。
 *
 * 节点 schema 冻结了、加不了 `titleAuto` 位，所以这份记忆只能放在客户端。
 * **必须跨刷新活着**（2026-09-04 Phase 4 复跑时发现）：只放进程内的 Map 的话，
 * 刷一次页面这张表就空了，而节点标题早已被上一轮 OSC 写成了命令名——
 * 于是 `shouldApplyOscTitle` 判成「用户改过名」，这个终端**从此再也不跟随
 * 标题**。localStorage 正好：按节点 id 存，只是一份提示，丢了最多退回旧行为。
 */
const OSC_TITLE_KEY = "aicc.oscTitles";

function readOscTitles(): Map<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(OSC_TITLE_KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return new Map();
    return new Map(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] =>
          typeof entry[1] === "string",
        ),
    );
  } catch {
    // 隐私模式 / 配额满 / 坏 JSON：退回进程内的那份，行为和以前一样。
    return new Map();
  }
}

const oscTitles = readOscTitles();

function persistOscTitles(): void {
  try {
    globalThis.localStorage?.setItem(
      OSC_TITLE_KEY,
      JSON.stringify(Object.fromEntries(oscTitles)),
    );
  } catch {
    // 存不下就算了：这只是个提示，不是数据。
  }
}

/**
 * 收到 OSC 0/2 时该不该改节点标题（§18.3 标题行）。
 *
 * 「用户改过名」= 当前标题既不是新建时的默认名，也不是我们上一次写进去的
 * OSC 标题。这样既不会覆盖手动改的名字，又允许 OSC 连续更新自己写的那个。
 */
export function shouldApplyOscTitle(
  nodeId: string,
  currentTitle: string,
  defaults: readonly (string | undefined)[],
): boolean {
  const title = currentTitle.trim();
  if (titleIsAuto(title, defaults)) return true;
  return oscTitles.get(nodeId) === title;
}

/**
 * 记几条就够了：一条记录几十字节，而且只有开过终端的节点才有。超了就按
 * 插入顺序丢最早的那些——它们对应的节点多半早就删了。
 */
const MAX_OSC_TITLES = 200;

export function rememberOscTitle(nodeId: string, title: string): void {
  // 先删再插：`Map` 按插入顺序遍历，重新插入才能把它挪到队尾。
  oscTitles.delete(nodeId);
  oscTitles.set(nodeId, title.trim());
  while (oscTitles.size > MAX_OSC_TITLES) {
    const oldest = oscTitles.keys().next();
    if (oldest.done) break;
    oscTitles.delete(oldest.value);
  }
  persistOscTitles();
}

/**
 * 节点真的被删掉时才调（终端组件卸载**不算**：热重载、StrictMode 的二次挂载
 * 都会走那条路，而节点还在——忘掉之后这个终端就再也不跟随标题了）。
 */
export function forgetOscTitle(nodeId: string): void {
  if (!oscTitles.delete(nodeId)) return;
  persistOscTitles();
}
