/**
 * The chords Armadra's MAIN process claims out of `before-input-event`.
 *
 * **This module is the closed list.** A chord only appears here because the
 * application menu would otherwise eat it above the page: an accelerator on a
 * `Menu` item is handled before the web contents ever see the keystroke, so
 * without an intercept the page's own dispatcher can never run for it. Every
 * other shortcut in Armadra reaches the renderer on its own and must NOT be
 * listed — an entry here takes its chord away from the page app-wide, and the
 * settings page's conflict recorder cannot see main-process intercepts, so the
 * user would be told the key is free while it silently does nothing.
 *
 * Two rules, both enforced by `keydown-intercept.test.ts`:
 *
 *   1. A claimed chord implies `preventDefault` — the key is ours, so neither
 *      the menu nor the page may also act on it.
 *   2. A claimed chord is FORWARDED to the page as an intent
 *      (`window:key-intent`). The shell performs only the part that is its own
 *      business (the window); anything about the canvas stays a canvas command,
 *      exactly as `shortcuts.rs:143-148` argued for global hotkeys. A second,
 *      divergent implementation in the shell is the failure mode being avoided.
 *
 * W2.1 claims exactly one chord: ⌘W, whose shell half is "close the window",
 * which on macOS means hide (`window-rules.ts`).
 */

/** What a claimed chord asks for. One member today, by design. */
export type KeyIntent = "close-window";

/** The subset of Electron's `Input` the decision reads (so tests need no
 * Electron, and so the decision cannot accidentally depend on window state). */
export interface KeydownInput {
  readonly type: string;
  readonly key: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

/**
 * PURE. What this input means, or `null` to leave the key completely alone —
 * no `preventDefault`, so the page and, failing that, the menu get it.
 *
 * The modifier test is EXACT on all four flags. ⌘⇧W is the menu's "Close All
 * Windows" and ⌘⌥W is nothing, so neither may be swallowed by a loose match;
 * and `w` is a character people type, so a branch without a primary-modifier
 * requirement would eat ordinary typing.
 */
export function keydownIntercept(
  input: KeydownInput,
  platform: string,
): KeyIntent | null {
  if (input.type !== "keyDown") return null;
  const primary = platform === "darwin" ? input.meta : input.control;
  const other = platform === "darwin" ? input.control : input.meta;
  if (!primary || other || input.shift || input.alt) return null;
  if (input.key.toLowerCase() === "w") return "close-window";
  return null;
}

/**
 * Every intent this build can claim. The test pins it, so adding a chord is a
 * deliberate edit to a list somebody reviewed rather than a line buried in a
 * branch.
 */
export const CLAIMED_INTENTS: readonly KeyIntent[] = ["close-window"];
