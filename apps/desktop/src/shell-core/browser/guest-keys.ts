/**
 * Who gets a keystroke that landed inside a guest: the web page, or Armadra.
 *
 * A `<webview>` is a separate renderer, so a chord typed while the page has
 * focus never reaches the host page's dispatcher — the one capture-phase
 * `keydown` listener in `apps/web/src/keybindings/use-keybindings.ts` is in a
 * different process and simply never runs. The symptom is the whole reason
 * this module exists: ⌘K, ⌘P and ⌘T do nothing until you first click back
 * onto the canvas.
 *
 * The main process is the only place both sides are visible, and
 * `before-input-event` on the guest's own `webContents` is the only hook that
 * sees the key before the page does. So the routing decision is made here,
 * and it is PURE so it can be pinned chord by chord without an Electron
 * window.
 *
 * ## The rule, and why it is an exemption list rather than an allowlist
 *
 * Every chord carrying the primary modifier (⌘ on macOS, Ctrl elsewhere) goes
 * to Armadra, EXCEPT the ones a web page is entitled to.
 *
 * The inverse — an allowlist of Armadra's own chords — was the obvious first
 * shape and it is wrong: the host keymap is user-configurable (any command in
 * `commands.ts` can be rebound in settings), and the main process does not
 * have the keymap. An enumerated list here would silently diverge the moment
 * somebody rebinds a command, and the failure is invisible: the key would
 * reach the page and do nothing, with no error anywhere.
 *
 * The exemption list does not have that problem, because it is not derived
 * from Armadra's bindings at all. It is what every browser gives the document
 * and what a person typing into a web form expects to keep working: clipboard
 * and selection, undo, find, print, save, and page zoom. Those are fixed by
 * the web platform, not by our settings page.
 *
 * Chords WITHOUT the primary modifier are never taken. Plain keys are typing,
 * and Esc, Tab and the arrows belong to whatever the page is doing with them.
 */

/** The subset of Electron's `Input` this decision reads. */
export interface GuestKeyInput {
  readonly type: string;
  readonly key: string;
  /** The physical key (`KeyK`, `Digit1`). Carried through because the host's
   * chord matcher falls back to it whenever `key` is a character a modifier
   * changed (`chords.ts`'s `keyMatches`). */
  readonly code?: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

/** Where one keystroke goes. */
export type GuestKeyRoute =
  /** Left with the web page. No `preventDefault`. */
  | "page"
  /** A chord the SHELL claims (`keydown-intercept.ts`); the existing
   *  `window:key-intent` round trip runs, exactly as it does for the host
   *  window. ⌘W inside a guest used to do nothing at all. */
  | "intent"
  /** Replayed into the host page's dispatcher (`browser:key`). */
  | "host";

/**
 * Keys a web page keeps even with the primary modifier held.
 *
 * Lowercased `key` values. `z` covers ⌘⇧Z too — redo is the same entitlement
 * as undo. `g` is find-next, which is useless without find. The digits and
 * `+ - =` are page zoom, and the arrows are document start/end on macOS.
 */
const PAGE_KEEPS: ReadonlySet<string> = new Set([
  // clipboard + selection
  "c",
  "x",
  "v",
  "a",
  // history of the text field, not of the canvas
  "z",
  // find, find-next: inside a page that is what the chord means, and the
  // canvas's own search is reachable from a canvas that has focus
  "f",
  "g",
  // save: "save page as" is the page's, and the host's ⌘S needs an editor
  // focused — which it cannot be while the key is arriving from a guest
  "s",
  // page zoom (⌘1–⌘9 are NOT here: those are tab chords, not zoom)
  "0",
  "+",
  "-",
  "=",
  // document start/end
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "home",
  "end",
]);

/**
 * PURE. Where this keystroke goes.
 *
 * `platform` is `process.platform`, passed in so the decision can be tested
 * for both families from one process.
 */
export function guestKeyRoute(
  input: GuestKeyInput,
  platform: string,
): GuestKeyRoute {
  if (input.type !== "keyDown") return "page";
  const primary = platform === "darwin" ? input.meta : input.control;
  const other = platform === "darwin" ? input.control : input.meta;
  // Both primary modifiers at once is not a chord either side binds; leaving
  // it with the page is the answer that cannot take a key away by accident.
  if (!primary || other) return "page";
  const key = input.key.toLowerCase();
  // The shell's own closed list first: it is a strict subset of what would
  // otherwise be forwarded, and its round trip is the one that must run.
  if (!input.shift && !input.alt && key === "w") return "intent";
  if (PAGE_KEEPS.has(key)) return "page";
  return "host";
}

/** What `browser:key` carries. Serializable, and only what a `KeyboardEvent`
 * needs to be rebuilt in the host page. */
export interface ForwardedChord {
  readonly nodeId: string;
  readonly key: string;
  readonly code: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

/** PURE. The payload for a keystroke that routed to `host`. */
export function forwardedChord(
  input: GuestKeyInput,
  nodeId: string,
): ForwardedChord {
  return {
    nodeId,
    key: input.key,
    code: input.code ?? "",
    meta: input.meta,
    control: input.control,
    shift: input.shift,
    alt: input.alt,
  };
}
