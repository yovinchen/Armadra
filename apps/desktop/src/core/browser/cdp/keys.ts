/**
 * 按键与组合键：哪些能按，按下去是哪个 key / code / 虚拟键码。
 *
 * 白名单（`allowlist.ts` 的 `Input.dispatchKeyEvent`）与 `press` 动词读的是
 * 同一张表，所以「help 里写了、白名单不放」这种漂移不会再有。
 *
 * 放行按「键 + 修饰键」逐项判断，而不是分别判断键和修饰键：
 *
 *   * 具名键（Enter、Tab、方向键……）和 F1–F12，带什么修饰键都行；
 *   * 字母和数字**必须**带 Ctrl、Meta 或 Alt 之一。光秃秃的一个字母是打字，
 *     打字走 `Input.insertText`，在那里它只是文字，永远成不了组合键；
 *   * 带 Ctrl / Meta 的 C、V、X 不放：复制、粘贴、剪切碰的是这台机器的剪贴板，
 *     粘贴更是把人剪贴板里的东西送进一个网页；
 *   * 带 Ctrl / Meta 的 W、Q、T、N 不放：它们在浏览器与桌面壳里是关窗口、
 *     退出、开标签、开窗口，不是网页的快捷键。
 */

export const MODIFIER_ALT = 1;
export const MODIFIER_CTRL = 2;
export const MODIFIER_META = 4;
export const MODIFIER_SHIFT = 8;

/** 具名键：键名、code、Windows 虚拟键码。 */
const NAMED: Record<string, readonly [string, number]> = {
  Enter: ["Enter", 13],
  Tab: ["Tab", 9],
  Escape: ["Escape", 27],
  Backspace: ["Backspace", 8],
  Delete: ["Delete", 46],
  ArrowUp: ["ArrowUp", 38],
  ArrowDown: ["ArrowDown", 40],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowRight: ["ArrowRight", 39],
  Home: ["Home", 36],
  End: ["End", 35],
  PageUp: ["PageUp", 33],
  PageDown: ["PageDown", 34],
  Space: ["Space", 32],
};

for (let n = 1; n <= 12; n += 1) NAMED[`F${n}`] = [`F${n}`, 111 + n];

/** 具名键的列表，help 与测试用。 */
export const NAMED_KEYS: readonly string[] = Object.freeze(Object.keys(NAMED));

/** 带 Ctrl / Meta 时不放行的字母。理由见文件头。 */
const HELD_BACK = new Set(["c", "v", "x", "w", "q", "t", "n"]);

export interface KeyDefinition {
  readonly key: string;
  readonly code: string;
  readonly windowsVirtualKeyCode: number;
}

/** 一个键的定义；不认识的键是 `undefined`。 */
export function keyDefinition(key: string): KeyDefinition | undefined {
  const named = NAMED[key];
  if (named !== undefined) {
    return { key, code: named[0], windowsVirtualKeyCode: named[1] };
  }
  if (/^[a-zA-Z]$/.test(key)) {
    const upper = key.toUpperCase();
    return {
      key: key.toLowerCase(),
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
    };
  }
  if (/^[0-9]$/.test(key)) {
    return {
      key,
      code: `Digit${key}`,
      windowsVirtualKeyCode: key.charCodeAt(0),
    };
  }
  return undefined;
}

/** 这个「键 + 修饰键」组合能不能按。白名单和 `press` 都问它。 */
export function isAllowedChord(key: string, modifiers: number): boolean {
  if (!Number.isInteger(modifiers) || modifiers < 0 || modifiers > 15)
    return false;
  if (NAMED[key] !== undefined) return true;
  const definition = keyDefinition(key);
  if (definition === undefined) return false;
  const command = modifiers & (MODIFIER_CTRL | MODIFIER_META);
  if ((modifiers & (MODIFIER_ALT | MODIFIER_CTRL | MODIFIER_META)) === 0)
    return false;
  if (command !== 0 && HELD_BACK.has(definition.key)) return false;
  return true;
}

/**
 * 解析 `Control+Shift+z`、`Meta+Enter`、`F5` 这样的写法。修饰键名大小写都行，
 * 也认 ctrl / cmd / option 这些人常写的别名。
 */
export function parseChord(
  text: string,
): { key: string; modifiers: number } | undefined {
  const parts = text.split("+").map((part) => part.trim());
  // `Control++` 这种以加号为键的写法不支持：加号是打字。
  if (parts.some((part) => part === "")) return undefined;
  const last = parts.pop();
  if (last === undefined) return undefined;
  let modifiers = 0;
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "alt":
      case "option":
        modifiers |= MODIFIER_ALT;
        break;
      case "ctrl":
      case "control":
        modifiers |= MODIFIER_CTRL;
        break;
      case "meta":
      case "cmd":
      case "command":
        modifiers |= MODIFIER_META;
        break;
      case "shift":
        modifiers |= MODIFIER_SHIFT;
        break;
      default:
        return undefined;
    }
  }
  const named = Object.keys(NAMED).find(
    (name) => name.toLowerCase() === last.toLowerCase(),
  );
  return { key: named ?? last, modifiers };
}

/**
 * 编辑命令。macOS 上合成的 Meta+A 不会自己变成全选——那边的编辑快捷键走
 * 系统的按键绑定，CDP 事件要带上 `commands` 才生效；别的平台带上也无害。
 * 只有这四个：它们都不碰剪贴板，也都不带文字。
 */
export const BROWSER_COMMANDS: readonly string[] = Object.freeze([
  "selectAll",
  "deleteBackward",
  "undo",
  "redo",
]);

export function commandsFor(key: string, modifiers: number): string[] {
  if ((modifiers & (MODIFIER_CTRL | MODIFIER_META)) === 0) return [];
  const shift = (modifiers & MODIFIER_SHIFT) !== 0;
  switch (key.toLowerCase()) {
    case "a":
      return shift ? [] : ["selectAll"];
    case "z":
      return [shift ? "redo" : "undo"];
    case "y":
      return shift ? [] : ["redo"];
    default:
      return [];
  }
}
