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
 * What Armadra excludes, and why:
 *
 *   * arbitrary page-side evaluation — `Runtime.evaluate`, `compileScript`,
 *     `runScript`, `addBinding` — and the whole `Debugger` domain, which is a
 *     second route to the same thing;
 *   * `Fetch`, because request interception is a proxy standing in the middle
 *     of the user's own session;
 *   * `Security`, which can switch off certificate errors;
 *   * `Storage`, `IndexedDB` and `DOMStorage`, the token stores this entire
 *     design exists to keep out;
 *   * `DOM.getOuterHTML`, `DOM.getAttributes` and `DOM.describeNode`, the
 *     full-DOM read arriving by another door — hidden inputs and inline
 *     scripts are exactly where sites keep tokens;
 *   * `Page.bringToFront`, because a page that can raise itself can steal a
 *     click the user aimed somewhere else;
 *   * every cookie method, and every Network method that returns a body.
 *
 * What the developer surface (`read --mode console|network`, `wait --idle`)
 * needed, and why it is safe to have:
 *
 *   * `Log.enable` and `Network.enable` are SUBSCRIPTIONS. What they deliver
 *     are events, and the only reader of those events is `devlog.ts`, which
 *     keeps a method, an address with its secrets blanked, a status, a type, a
 *     size, a duration and a failure reason — never a header, never a body.
 *     `Network.enable` is further pinned to `maxPostDataSize: 0`, so a request
 *     body is not even carried on the event.
 *   * Every Network method that RETURNS something — a body, a post payload, a
 *     cookie, a certificate — or that changes the traffic stays out, named one
 *     by one in {@link FORBIDDEN_METHODS} so that adding one is a failing test.
 *     {@link NETWORK_METHODS} is the whole of that domain here.
 *
 * And for the snapshot: `Accessibility.getFullAXTree` hands back what a screen
 * reader sees, which includes the value of a text field. The renderer
 * (`snapshot.ts`) drops it and says filled or empty, the same rule the frozen
 * readers keep.
 *
 * A refusal deliberately does not say why. An allowlist that explains itself is
 * a probing aid.
 */

import { BROWSER_COMMANDS, NAMED_KEYS, isAllowedChord } from "./keys";
import { isArmadraScript } from "./scripts";

/**
 * Keys `press` may send without a modifier. Letters and digits are keys only
 * inside a chord (`keys.ts` decides which chords); a bare printable character
 * goes through `Input.insertText`, where it is text and can never be a chord.
 */
export const BROWSER_KEYS: readonly string[] = NAMED_KEYS;

export { BROWSER_COMMANDS };

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

/** Exactly these keys and nothing else. */
function only(p: Params, keys: readonly string[]): boolean {
  return Object.keys(p).every((key) => keys.includes(key));
}

/** One node, named by `nodeId` or `backendNodeId` — never by an `objectId`,
 * which could name anything the page ever handed out. */
function oneNode(p: Params, extra: readonly string[] = []): boolean {
  const byId = isFiniteNumber(p.nodeId);
  const byBackend = isFiniteNumber(p.backendNodeId);
  if (byId === byBackend) return false;
  return only(p, ["nodeId", "backendNodeId", ...extra]);
}

function isFrameId(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
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
  // Subscriptions for the developer surface; see the file header.
  ["Log.enable", (p) => Object.keys(p).length === 0],
  ["Log.disable", (p) => Object.keys(p).length === 0],
  [
    "Network.enable",
    (p) => only(p, ["maxPostDataSize"]) && p.maxPostDataSize === 0,
  ],
  ["Network.disable", (p) => Object.keys(p).length === 0],
  // Out-of-process iframes. Auto-attach hands back one flat session per frame
  // target; nothing waits for a debugger, so no page is ever paused by it.
  [
    "Target.setAutoAttach",
    (p) =>
      typeof p.autoAttach === "boolean" &&
      p.waitForDebuggerOnStart === false &&
      p.flatten === true &&
      only(p, ["autoAttach", "waitForDebuggerOnStart", "flatten"]),
  ],

  /* ------------------------------ reading -------------------------------- */
  [
    "DOM.getDocument",
    (p) => {
      const depth = p.depth;
      if (
        depth !== undefined &&
        (!isFiniteNumber(depth) || depth < 0 || depth > 1)
      ) {
        return false;
      }
      return p.pierce !== true;
    },
  ],
  [
    "DOM.resolveNode",
    (p) => isFiniteNumber(p.nodeId) || typeof p.backendNodeId === "number",
  ],
  // Node ids only: where an element is, not what it says.
  [
    "DOM.querySelector",
    (p) =>
      isFiniteNumber(p.nodeId) &&
      typeof p.selector === "string" &&
      p.selector.length <= 1_000 &&
      only(p, ["nodeId", "selector"]),
  ],
  ["DOM.getContentQuads", (p) => oneNode(p)],
  ["DOM.getBoxModel", (p) => oneNode(p)],
  ["DOM.scrollIntoViewIfNeeded", (p) => oneNode(p)],
  // Focus without a click: a native dropdown clicked open is an OS popup that
  // swallows synthesized keys, so `select` focuses it and steps it closed.
  ["DOM.focus", (p) => oneNode(p)],
  ["DOM.getFrameOwner", (p) => isFrameId(p.frameId) && only(p, ["frameId"])],
  ["Page.getFrameTree", (p) => Object.keys(p).length === 0],
  [
    "Accessibility.getFullAXTree",
    (p) =>
      (p.frameId === undefined || isFrameId(p.frameId)) &&
      (p.depth === undefined || isFiniteNumber(p.depth)) &&
      only(p, ["frameId", "depth"]),
  ],
  [
    "Accessibility.getPartialAXTree",
    (p) =>
      oneNode(p, ["fetchRelatives"]) &&
      (p.fetchRelatives === undefined || p.fetchRelatives === false),
  ],
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
  ["Page.reload", (p) => only(p, ["ignoreCache"])],
  ["Page.stopLoading", (p) => Object.keys(p).length === 0],
  [
    "Page.navigateToHistoryEntry",
    (p) => isFiniteNumber(p.entryId) && Object.keys(p).length === 1,
  ],

  /* -------------------------------- input -------------------------------- */
  [
    "Input.dispatchMouseEvent",
    (p) => {
      const types = [
        "mousePressed",
        "mouseReleased",
        "mouseMoved",
        "mouseWheel",
      ];
      if (typeof p.type !== "string" || !types.includes(p.type)) return false;
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) return false;
      // Coordinates must land inside a viewport this shell measured itself.
      // The bound is applied by `isAllowed` below, from the viewport the
      // session measured — never from anything a caller claimed.
      return only(p, [
        "type",
        "x",
        "y",
        "button",
        "buttons",
        "clickCount",
        "modifiers",
        "deltaX",
        "deltaY",
      ]);
    },
  ],
  [
    "Input.dispatchKeyEvent",
    (p) => {
      const types = ["keyDown", "keyUp", "rawKeyDown", "char"];
      if (typeof p.type !== "string" || !types.includes(p.type)) return false;
      // One exception to "no text": a lone `char` event carrying ONE
      // character, no key, no modifier, no command. That is exactly one
      // character of `Input.insertText`, which is allowed anyway — and it is
      // the only input a closed native dropdown answers on every platform
      // (type-ahead), where arrow keys on macOS open an OS menu instead.
      if (p.type === "char" && "text" in p) {
        return (
          typeof p.text === "string" &&
          [...p.text].length === 1 &&
          only(p, ["type", "text"])
        );
      }
      // The one field that would turn a key event into arbitrary typing.
      if ("text" in p) return false;
      if ("unmodifiedText" in p) return false;
      // Key AND modifiers, as one pair: `keys.ts` decides which chords exist.
      const modifiers = p.modifiers === undefined ? 0 : p.modifiers;
      if (typeof modifiers !== "number") return false;
      if (p.key !== undefined && !isAllowedChord(String(p.key), modifiers))
        return false;
      if (p.commands !== undefined) {
        if (!Array.isArray(p.commands)) return false;
        if (!p.commands.every((c) => BROWSER_COMMANDS.includes(String(c))))
          return false;
      }
      return only(p, [
        "type",
        "key",
        "code",
        "windowsVirtualKeyCode",
        "modifiers",
        "commands",
      ]);
    },
  ],
  // `drag`: an HTML5 drag the page started comes back as its own drag data
  // and is dropped with it. Never with `files`, which would hand a page files
  // from this machine that nobody chose.
  [
    "Input.setInterceptDrags",
    (p) => typeof p.enabled === "boolean" && only(p, ["enabled"]),
  ],
  [
    "Input.dispatchDragEvent",
    (p) => {
      if (
        !["dragEnter", "dragOver", "drop", "dragCancel"].includes(
          String(p.type),
        )
      )
        return false;
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) return false;
      if (!isObject(p.data)) return false;
      const data = p.data;
      if (
        data.files !== undefined &&
        !(Array.isArray(data.files) && data.files.length === 0)
      )
        return false;
      if (!Array.isArray(data.items) || data.items.length > 32) return false;
      return (
        only(data, ["items", "files", "dragOperationsMask"]) &&
        only(p, ["type", "x", "y", "data", "modifiers"])
      );
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
      if (format !== undefined && format !== "png" && format !== "jpeg")
        return false;
      if (
        p.captureBeyondViewport !== undefined &&
        typeof p.captureBeyondViewport !== "boolean"
      )
        return false;
      if (p.clip !== undefined) {
        if (!isObject(p.clip)) return false;
        const clip = p.clip;
        const fields = ["x", "y", "width", "height", "scale"];
        if (!Object.keys(clip).every((key) => fields.includes(key)))
          return false;
        if (!fields.slice(0, 4).every((key) => isFiniteNumber(clip[key])))
          return false;
      }
      return only(p, [
        "format",
        "quality",
        "clip",
        "captureBeyondViewport",
        "fromSurface",
      ]);
    },
  ],
  // A PDF comes back inline. `transferMode: ReturnAsStream` would need
  // `IO.read`, and the header / footer templates are markup the printer
  // renders — neither is something a verb needs.
  [
    "Page.printToPDF",
    (p) =>
      only(p, [
        "landscape",
        "printBackground",
        "scale",
        "paperWidth",
        "paperHeight",
        "marginTop",
        "marginBottom",
        "marginLeft",
        "marginRight",
        "pageRanges",
        "preferCSSPageSize",
      ]),
  ],
  // `resize`. Bounded, desktop-shaped, and gone the moment the debugger
  // detaches — which is the moment a person takes the page back.
  [
    "Emulation.setDeviceMetricsOverride",
    (p) =>
      isFiniteNumber(p.width) &&
      isFiniteNumber(p.height) &&
      p.width >= 200 &&
      p.width <= 3_840 &&
      p.height >= 200 &&
      p.height <= 2_160 &&
      p.deviceScaleFactor === 0 &&
      p.mobile === false &&
      only(p, ["width", "height", "deviceScaleFactor", "mobile"]),
  ],
  ["Emulation.clearDeviceMetricsOverride", (p) => Object.keys(p).length === 0],

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
export const ALLOWED_METHODS: readonly string[] = Object.freeze([
  ...ALLOWED.keys(),
]);

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
  "Runtime.getProperties",
  "DOM.getOuterHTML",
  "DOM.getAttributes",
  "DOM.describeNode",
  "DOM.getFlattenedDocument",
  "DOM.setAttributeValue",
  "DOM.setOuterHTML",
  "DOM.setNodeValue",
  "DOM.removeNode",
  "Page.bringToFront",
  "Page.getResourceContent",
  "Page.searchInResource",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.setDocumentContent",
  "Target.attachToTarget",
  "Target.createTarget",
  "Target.sendMessageToTarget",
  "Network.getAllCookies",
  "Network.getCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Network.getResponseBody",
  "Network.getRequestPostData",
  "Network.getResponseBodyForInterception",
  "Network.takeResponseBodyForInterceptionAsStream",
  "Network.searchInResponseBody",
  "Network.loadNetworkResource",
  "Network.replayXHR",
  "Network.setExtraHTTPHeaders",
  "Network.setRequestInterception",
  "Network.setUserAgentOverride",
  "Network.setBlockedURLs",
  "Network.emulateNetworkConditions",
  "Network.getCertificate",
]);

/**
 * The whole of the `Network` domain an agent may reach: two subscriptions.
 * `sole-call-site.test.ts` pins the table to exactly these.
 */
export const NETWORK_METHODS: readonly string[] = Object.freeze([
  "Network.enable",
  "Network.disable",
]);

export const FORBIDDEN_DOMAINS: readonly string[] = Object.freeze([
  "Debugger",
  "Fetch",
  "Security",
  "Storage",
  "IndexedDB",
  "DOMStorage",
  "IO",
  "CacheStorage",
  "ServiceWorker",
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
  if (
    (method === "Input.dispatchMouseEvent" ||
      method === "Input.dispatchDragEvent") &&
    viewport
  ) {
    const x = shaped.x as number;
    const y = shaped.y as number;
    if (x < 0 || y < 0 || x > viewport.width || y > viewport.height)
      return false;
  }
  return true;
}
