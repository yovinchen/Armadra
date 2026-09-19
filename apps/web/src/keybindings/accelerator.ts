/**
 * 和弦写法 → `shortcuts:apply` 线上的 accelerator 写法。
 *
 * 系统热键由操作系统注册，而系统不认识这套键位表的写法，所以中间必须有一次
 * 翻译。两边的差别不大但都不能错：
 *
 * | 这里            | accelerator       |
 * | --------------- | ----------------- |
 * | `Mod`           | `CmdOrCtrl`       |
 * | `Alt` / `Option`| `Alt`             |
 * | `Meta` / `Cmd`  | `Super`           |
 * | `Comma`         | `Comma`           |
 * | `k`             | `KeyK`… 不，`K`   |
 *
 * 一条翻不出来的和弦返回 `null` 而不是一个「差不多」的串：装错一个全局热键
 * 是从整台机器上抢走一个组合键，宁可不装。壳那边
 * （`apps/desktop/src/shell-core/accelerator.ts`）把剩下的差异补完，两道判定
 * 的样本在 `apps/desktop/src/shell-core/shortcut-rules.test.ts` 里对齐。
 */

/**
 * 主键 → accelerator 里的写法。
 *
 * 键位表里同一个键有两种写法：`Comma` 这样的 token，和 `,` 这样的字面量
 * （录制写 token，手改的配置里两种都可能出现）。两种都收，值是同一个。
 */
const KEY_NAMES: Record<string, string> = {
  " ": "Space",
  space: "Space",
  ",": "Comma",
  comma: "Comma",
  ".": "Period",
  period: "Period",
  "/": "Slash",
  slash: "Slash",
  "\\": "Backslash",
  backslash: "Backslash",
  ";": "Semicolon",
  semicolon: "Semicolon",
  "'": "Quote",
  quote: "Quote",
  "`": "Backquote",
  backquote: "Backquote",
  "-": "Minus",
  minus: "Minus",
  "=": "Equal",
  equal: "Equal",
  "[": "BracketLeft",
  bracketleft: "BracketLeft",
  "]": "BracketRight",
  bracketright: "BracketRight",
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  tab: "Tab",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
};

const MODIFIERS: Record<string, string> = {
  mod: "CmdOrCtrl",
  cmd: "Super",
  command: "Super",
  meta: "Super",
  ctrl: "Control",
  control: "Control",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
};

function keyName(token: string): string | null {
  const named = KEY_NAMES[token.toLowerCase()];
  if (named) return named;
  if (/^[a-z]$/i.test(token)) return token.toUpperCase();
  if (/^[0-9]$/.test(token)) return token;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(token)) return token.toUpperCase();
  // 剩下的都是这份表里根本不该出现的写法。
  return null;
}

/**
 * 一条和弦的 accelerator 写法，翻不出来时 `null`。
 *
 * 只接受**带修饰键**的组合：一个无修饰的全局热键会让这台机器上再也打不出
 * 那个字符——包括在别的应用里。
 */
export function toAccelerator(chord: string): string | null {
  const parts = chord
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const key = keyName(parts[parts.length - 1]!);
  if (!key) return null;
  const modifiers: string[] = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier || modifiers.includes(modifier)) return null;
    modifiers.push(modifier);
  }
  return [...modifiers, key].join("+");
}

/**
 * 一组等价写法里第一条能翻出来的。
 *
 * 键位表允许 `Backspace,Delete` 这样的多写法，系统热键只能注册一个；取第一条
 * 可用的，而不是全都注册——后者会悄悄多占用户没打算给出去的组合键。
 */
export function acceleratorFor(keys: string | null | undefined): string {
  if (!keys) return "";
  for (const chord of keys.split(",")) {
    const accelerator = toAccelerator(chord.trim());
    if (accelerator) return accelerator;
  }
  return "";
}
