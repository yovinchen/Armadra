/**
 * The page's accelerator syntax → Electron's.
 *
 * `apps/web/src/keybindings/accelerator.ts` translates a chord from the keymap
 * into the accelerator syntax of the shell that came before, and that is what `shortcuts:apply` carries —
 * the page half of the feature is explicitly not being changed in this batch
 * (migration design §5, W2.1), so the shell is the side that adapts.
 *
 * The two syntaxes agree on modifiers (`CmdOrCtrl`, `Super`, `Control`,
 * `Shift`, `Alt` are all Electron spellings too) and on letters, digits and
 * function keys. They disagree about everything else the page can emit:
 *
 * | page            | Electron |
 * | --------------- | -------- |
 * | `ArrowUp`       | `Up`     |
 * | `Comma`         | `,`      |
 * | `BracketLeft`   | `[`      |
 * | `Enter`         | `Return` |
 *
 * A token this table does not know returns `null`, and `null` is refused as
 * `invalid` rather than registered. Guessing would mean taking a combination
 * away from the whole machine and binding it to something the user did not ask
 * for — the one outcome a global hotkey must never produce.
 */

/** Electron's spelling for every key `apps/web`'s `KEY_NAMES` can produce. */
const KEYS: Record<string, string> = {
  Space: "Space",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Enter: "Return",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
};

/** The modifier tokens both syntaxes spell the same way. */
const MODIFIERS = new Set(["CmdOrCtrl", "Super", "Control", "Shift", "Alt"]);

function electronKey(token: string): string | null {
  const named = KEYS[token];
  if (named) return named;
  if (/^[A-Z0-9]$/.test(token)) return token;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(token)) return token;
  return null;
}

/**
 * One accelerator, or `null` when any part of it is unrecognized.
 *
 * A modifier may not repeat and must come before the key, which is how the
 * page emits them; anything else is a hand-edited settings document, and this
 * is the last place that can refuse it before the OS is asked.
 */
export function toElectronAccelerator(accelerator: string): string | null {
  const parts = accelerator.split("+");
  if (parts.length === 0 || parts.some((part) => part.trim() !== part))
    return null;
  const last = parts[parts.length - 1];
  if (last === undefined) return null;
  const key = electronKey(last);
  if (!key) return null;
  const modifiers: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (!MODIFIERS.has(part) || modifiers.includes(part)) return null;
    modifiers.push(part);
  }
  return [...modifiers, key].join("+");
}
