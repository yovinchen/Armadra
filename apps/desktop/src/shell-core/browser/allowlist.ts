/**
 * The CDP allowlist: default deny, and the params are checked too.
 *
 * The table is `(method, validator)` pairs rather than a set of method names,
 * because for most of these domains the method is not the dangerous part. The
 * dangerous part is the argument — a `Page.navigate` to `file:///etc/passwd`, a
 * `Input.dispatchKeyEvent` carrying a `text` field that types whatever a
 * caller wants past the key list, a `DOM.getDocument` with `pierce: true` that
 * hands back every frame's tree in one call.
 *
 * What is EXCLUDED, and why (the same reasons nodeterm's
 * `browser-cdp-allowlist.ts:16-23` recorded, because they are still the
 * reasons):
 *
 *   * arbitrary page-side evaluation — `Runtime.evaluate`, `compileScript`,
 *     `runScript`, `addBinding` — and the whole `Debugger` domain, which is a
 *     second route to the same thing;
 *   * `Fetch`, because request interception is a proxy standing in the middle
 *     of the user's own session;
 *   * `Security`, which can switch off certificate errors;
 *   * `Storage`, `IndexedDB` and `DOMStorage`, the token stores this entire
 *     design exists to keep out;
 *   * `DOM.getOuterHTML` and `DOM.getAttributes`, the full-DOM read arriving
 *     by another door — hidden inputs and inline scripts are exactly where
 *     sites keep tokens;
 *   * `Page.bringToFront`, because a page that can raise itself can steal a
 *     click the user aimed somewhere else;
 *   * `Network.getAllCookies`, one call that empties the jar for every site.
 *
 * A refusal deliberately does not say why. An allowlist that explains itself is
 * a probing aid.
 */

import { isArmadraScript } from "./scripts";

/** Keys `press` may send. Anything else is not a key as far as this shell is
 * concerned — including every printable character, which goes through
 * `Input.insertText` instead, where it is text and can never be a chord. */
export const BROWSER_KEYS: readonly string[] = Object.freeze([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
]);

/** The only two editing commands. Neither carries text. */
export const BROWSER_COMMANDS: readonly string[] = Object.freeze([
  "selectAll",
  "deleteBackward",
]);

/** Longest single `Input.insertText`. A verb that wants more sends more calls,
 * which is bounded by the verb, not by this. */
export const MAX_INSERT_TEXT = 4_096;

type Params = Record<string, unknown>;
type Validator = (params: Params) => boolean;

function isObject(value: unknown): value is Params {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** http(s) only, and parseable. The same gate the navigation rules apply, kept
 * here too so the allowlist does not depend on a caller having run it. */
export function isNavigableUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 4_096) return false;
  try {
    const scheme = new URL(value).protocol;
    return scheme === "http:" || scheme === "https:";
  } catch {
    return false;
  }
}

/**
 * A `Runtime.callFunctionOn` argument list. At most one argument, and it must
 * be a plain scalar carried by value: no `objectId`, no `unserializableValue`,
 * nothing that could name something already in the page.
 */
function scalarArguments(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 1) return false;
  return value.every((entry) => {
    if (!isObject(entry)) return false;
    const keys = Object.keys(entry);
    if (keys.length !== 1 || keys[0] !== "value") return false;
    const scalar = entry.value;
    return (
      typeof scalar === "string" ||
      typeof scalar === "number" ||
      typeof scalar === "boolean"
    );
  });
}

/**
 * The table. Every entry states the whole of what it accepts; a params object
 * carrying a key the validator does not mention is still refused, because each
 * validator rejects unknown keys explicitly where it matters.
 */
const ALLOWED: ReadonlyMap<string, Validator> = new Map<string, Validator>([
  /* ------------------------------- lifecycle ------------------------------ */
  ["Page.enable", (p) => Object.keys(p).length === 0],
  ["Runtime.enable", (p) => Object.keys(p).length === 0],
  ["DOM.enable", (p) => Object.keys(p).length === 0],

  /* ------------------------------ reading -------------------------------- */
  [
    "DOM.getDocument",
    (p) => {
      const depth = p.depth;
      if (depth !== undefined && (!isFiniteNumber(depth) || depth < 0 || depth > 1)) {
        return false;
      }
      return p.pierce !== true;
    },
  ],
  ["DOM.resolveNode", (p) => isFiniteNumber(p.nodeId) || typeof p.backendNodeId === "number"],
  ["Runtime.releaseObject", (p) => typeof p.objectId === "string"],
  [
    "Runtime.callFunctionOn",
    (p) =>
      isArmadraScript(p.functionDeclaration) &&
      typeof p.objectId === "string" &&
      p.returnByValue === true &&
      p.awaitPromise !== true &&
      p.userGesture !== true &&
      scalarArguments(p.arguments),
  ],
  ["Page.getLayoutMetrics", (p) => Object.keys(p).length === 0],
  ["Page.getNavigationHistory", (p) => Object.keys(p).length === 0],

  /* ----------------------------- navigation ------------------------------ */
  ["Page.navigate", (p) => isNavigableUrl(p.url)],
  ["Page.reload", (p) => p.scriptToEvaluateOnLoad === undefined],
  [
    "Page.navigateToHistoryEntry",
    (p) => isFiniteNumber(p.entryId) && Object.keys(p).length === 1,
  ],

  /* -------------------------------- input -------------------------------- */
  [
    "Input.dispatchMouseEvent",
    (p) => {
      const types = ["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"];
      if (typeof p.type !== "string" || !types.includes(p.type)) return false;
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) return false;
      // Coordinates must land inside a viewport this shell measured itself.
      // The bound is supplied by the caller through `withViewport`, which is
      // the only way a coordinate is ever accepted.
      return true;
    },
  ],
  [
    "Input.dispatchKeyEvent",
    (p) => {
      const types = ["keyDown", "keyUp", "rawKeyDown", "char"];
      if (typeof p.type !== "string" || !types.includes(p.type)) return false;
      // The one field that would turn a key event into arbitrary typing.
      if ("text" in p) return false;
      if ("unmodifiedText" in p) return false;
      if (p.key !== undefined && !BROWSER_KEYS.includes(String(p.key))) return false;
      if (p.commands !== undefined) {
        if (!Array.isArray(p.commands)) return false;
        if (!p.commands.every((c) => BROWSER_COMMANDS.includes(String(c)))) return false;
      }
      return true;
    },
  ],
  [
    "Input.insertText",
    (p) =>
      typeof p.text === "string" &&
      p.text.length <= MAX_INSERT_TEXT &&
      Object.keys(p).length === 1,
  ],

  /* ------------------------------- capture ------------------------------- */
  [
    "Page.captureScreenshot",
    (p) => {
      const format = p.format;
      if (format !== undefined && format !== "png" && format !== "jpeg") return false;
      if (p.clip !== undefined) {
        if (!isObject(p.clip)) return false;
        const clip = p.clip;
        const fields = ["x", "y", "width", "height", "scale"];
        if (!Object.keys(clip).every((key) => fields.includes(key))) return false;
        if (!fields.slice(0, 4).every((key) => isFiniteNumber(clip[key]))) return false;
      }
      return true;
    },
  ],

  /* ------------------------- dialogs and choosers ------------------------ */
  [
    "Page.handleJavaScriptDialog",
    (p) =>
      typeof p.accept === "boolean" &&
      (p.promptText === undefined || typeof p.promptText === "string"),
  ],
  ["Page.setInterceptFileChooserDialog", (p) => typeof p.enabled === "boolean"],
  [
    "DOM.setFileInputFiles",
    (p) =>
      Array.isArray(p.files) &&
      p.files.every((file) => typeof file === "string") &&
      (typeof p.objectId === "string" || typeof p.backendNodeId === "number"),
  ],
]);

/** Every method name this shell may ever send. Used by the reachability test. */
export const ALLOWED_METHODS: readonly string[] = Object.freeze([...ALLOWED.keys()]);

/**
 * Domains and methods that must never appear in the table. Asserted by the
 * tests, so adding one is a failing build rather than a review somebody has to
 * catch.
 */
export const FORBIDDEN_METHODS: readonly string[] = Object.freeze([
  "Runtime.evaluate",
  "Runtime.compileScript",
  "Runtime.runScript",
  "Runtime.addBinding",
  "DOM.getOuterHTML",
  "DOM.getAttributes",
  "Page.bringToFront",
  "Network.getAllCookies",
  "Network.setCookie",
  "Network.deleteCookies",
]);

export const FORBIDDEN_DOMAINS: readonly string[] = Object.freeze([
  "Debugger",
  "Fetch",
  "Security",
  "Storage",
  "IndexedDB",
  "DOMStorage",
]);

/** What a refused command is told. It does not say which rule refused it. */
export function refusalMessage(method: string): string {
  return `browser: the command ${method} is not permitted for agent control`;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/**
 * Whether one command may be sent.
 *
 * `viewport` is what this shell measured for the guest, not anything a caller
 * claimed. When it is present, mouse coordinates must land inside it: an input
 * event outside the visible page is an event aimed at whatever the compositor
 * has there, which is not the page the verb named.
 */
export function isAllowed(
  method: unknown,
  params: unknown,
  viewport?: Viewport,
): boolean {
  if (typeof method !== "string") return false;
  const validator = ALLOWED.get(method);
  if (validator === undefined) return false;
  const shaped = params === undefined ? {} : params;
  if (!isObject(shaped)) return false;
  if (!validator(shaped)) return false;
  if (method === "Input.dispatchMouseEvent" && viewport) {
    const x = shaped.x as number;
    const y = shaped.y as number;
    if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return false;
  }
  return true;
}
