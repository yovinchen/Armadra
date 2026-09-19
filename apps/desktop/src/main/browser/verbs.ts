import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import {
  BROWSER_KEYS,
  MAX_INSERT_TEXT,
} from "../../shell-core/browser/allowlist";
import { DRIVE_CODES, type DriveRequest } from "../../shell-core/browser/drive";
import { allowGuestNavigation } from "../../shell-core/browser/navigation";
import {
  discardedMessage,
  notDrivableMessage,
} from "../../shell-core/browser/registration";
import {
  parseRef,
  staleRefMessage,
  unknownRefMessage,
  verifyIdentity,
  type RefRecord,
} from "../../shell-core/browser/refs";
import {
  jailMessage,
  jailReadPath,
  jailWritePath,
} from "../../shell-core/browser/workspace-path";
import { CdpRefusal, type GuestSession } from "./cdp";
import { drivableSession, guestsOfNode } from "./registry";
import {
  acceptStagedDownload,
  clearChooser,
  pendingChooser,
  rejectStagedDownload,
  stagedDownloads,
} from "./transfers";
import { askRenderer } from "./renderer";
import { onDomainEvent } from "./domain-events";

/**
 * The seventeen verbs, executed against a guest.
 *
 * Three rules run through all of them, and they are the reason this file is not
 * a thin wrapper over CDP:
 *
 *   1. **A stale ref is refused, never re-resolved.** A ref that silently
 *      re-resolves after a navigation is how an agent clicks "Delete account"
 *      while meaning "Next page".
 *   2. **`read` reports whether a field is filled, never what is in it**, and
 *      never mentions an element that is `hidden`, `aria-hidden` or
 *      `display:none`. That filtering is inside the frozen scripts, where it
 *      cannot be bypassed by a different caller.
 *   3. **Answers carry re-measured values.** A scroll reports the distance the
 *      page actually moved, not the distance that was asked for; a click
 *      reports the URL after the click. An answer that echoes the request is an
 *      answer that cannot tell the reader the page ignored them.
 */

type Args = Record<string, unknown>;

function text(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(args: Args, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function flag(args: Args, name: string): boolean {
  return args[name] === true;
}

function list(args: Args, name: string): string[] {
  const value = args[name];
  if (Array.isArray(value))
    return value.filter((e): e is string => typeof e === "string");
  return typeof value === "string" ? [value] : [];
}

function refuse(code: string, message: string): never {
  throw new CdpRefusal(code, message);
}

/* ------------------------------- targeting -------------------------------- */

interface Located {
  readonly x: number;
  readonly y: number;
  readonly role: string;
  readonly name: string;
  readonly visible: boolean;
  readonly disabled: boolean;
  /** Present only when the target was a ref: the enumeration index, which the
   * element-detail scripts take. */
  readonly index?: number;
}

interface Resolved {
  found: boolean;
  invalid?: boolean;
  role: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
  disabled: boolean;
}

function center(box: Resolved): { x: number; y: number } {
  return { x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) };
}

/**
 * Turns `--ref` / `--selector` / `--x --y` into a point in the guest's
 * viewport, re-measured right now.
 *
 * A ref is checked twice: the table says whether it belongs to this navigation
 * generation, and the resolver says whether the element it points at is still
 * the element the ref described. Either check failing is a refusal.
 */
async function locate(session: GuestSession, args: Args): Promise<Located> {
  const x = num(args, "x");
  const y = num(args, "y");
  if (x !== undefined && y !== undefined) {
    const viewport = await session.refreshViewport();
    if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) {
      refuse(DRIVE_CODES.badArgument, "that point is outside the visible page");
    }
    return { x, y, role: "point", name: "", visible: true, disabled: false };
  }

  const wanted = text(args, "ref");
  if (wanted) {
    const ordinal = parseRef(wanted);
    if (ordinal === null)
      refuse(DRIVE_CODES.badArgument, `${wanted} is not a ref`);
    const found = session.refs.lookup(ordinal);
    if (!found.ok) {
      refuse(
        DRIVE_CODES.staleRef,
        found.reason === "stale"
          ? staleRefMessage(ordinal)
          : unknownRefMessage(ordinal),
      );
    }
    return await locateRef(session, found.record);
  }

  const selector = text(args, "selector");
  if (!selector)
    refuse(
      DRIVE_CODES.badArgument,
      "give a --ref, a --selector or --x and --y",
    );
  const box = await session.run<Resolved>("resolveSelector", selector);
  if (!box?.found) {
    if (box?.invalid)
      refuse(DRIVE_CODES.badArgument, "that is not a valid CSS selector");
    refuse(DRIVE_CODES.notFound, `nothing on this page matches ${selector}`);
  }
  if (!box.visible)
    refuse(DRIVE_CODES.notFound, `${selector} is on the page but not visible`);
  return {
    ...center(box),
    role: box.role,
    name: box.name,
    visible: true,
    disabled: box.disabled,
  };
}

async function locateRef(
  session: GuestSession,
  record: RefRecord,
): Promise<Located> {
  const box = await session.run<Resolved>("resolveRef", record.index);
  if (!box?.found || !verifyIdentity(record, box)) {
    refuse(DRIVE_CODES.staleRef, staleRefMessage(record.ordinal));
  }
  if (!box.visible) {
    refuse(
      DRIVE_CODES.notFound,
      `@${record.ordinal} is on the page but not visible`,
    );
  }
  return {
    ...center(box),
    role: box.role,
    name: box.name,
    visible: true,
    disabled: box.disabled,
    index: record.index,
  };
}

/* --------------------------------- input ---------------------------------- */

async function clickAt(
  session: GuestSession,
  point: { x: number; y: number },
): Promise<void> {
  const common = { x: point.x, y: point.y, button: "left", clickCount: 1 };
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...common,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...common,
  });
}

/** Where the page is, after whatever just happened. Always re-read. */
async function pageState(
  session: GuestSession,
): Promise<{ url: string; title: string; generation: number }> {
  const seen = await session.run<{ title: string; url: string }>("readTitle");
  return {
    url: seen?.url ?? "",
    title: seen?.title ?? "",
    generation: session.refs.currentGeneration(),
  };
}

/* --------------------------------- verbs ---------------------------------- */

export interface VerbContext {
  readonly nodeId: string;
  readonly tabId: string;
  readonly session: GuestSession;
}

type Handler = (context: VerbContext, args: Args) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  navigate: async ({ session }, args) => {
    const action = text(args, "action") ?? "goto";
    if (action === "back" || action === "forward")
      return history(session, action);
    if (action === "reload") {
      await session.send("Page.reload", {});
      await settle(session);
      return pageState(session);
    }
    const url = text(args, "url");
    if (!url) refuse(DRIVE_CODES.badArgument, "navigate needs a --url");
    if (!allowGuestNavigation(url)) {
      refuse(
        DRIVE_CODES.refused,
        "a browser node only opens http and https addresses",
      );
    }
    await session.send("Page.navigate", { url });
    await settle(session);
    return pageState(session);
  },

  back: ({ session }) => history(session, "back"),
  forward: ({ session }) => history(session, "forward"),

  read: async ({ session }, args) => {
    const mode = text(args, "mode") ?? "text";
    const limit = Math.max(1, Math.min(num(args, "limit") ?? 40, 500));
    const bytes = Math.max(
      1_024,
      Math.min(num(args, "maxBytes") ?? 24_576, 1_048_576),
    );
    type Read = Record<string, unknown>;
    if (mode === "title")
      return { mode, ...(await session.run<Read>("readTitle")) };
    if (mode === "text")
      return { mode, ...(await session.run<Read>("readText", bytes)) };
    if (mode === "links")
      return { mode, ...(await session.run<Read>("readLinks", limit)) };
    if (mode !== "map" && mode !== "elements") {
      refuse(DRIVE_CODES.badArgument, `unknown read mode ${mode}`);
    }
    const seen = await session.run<{
      elements: Array<{
        index: number;
        role: string;
        name: string;
        detail: string;
      }>;
      title: string;
      url: string;
    }>("readMap", limit);
    const minted = session.refs.mint(seen?.elements ?? []);
    return {
      mode: "map",
      title: seen?.title ?? "",
      url: seen?.url ?? "",
      elements: minted.map((record, position) => ({
        ref: `@${record.ordinal}`,
        role: record.role,
        name: record.name,
        detail: seen.elements[position]?.detail ?? "",
      })),
    };
  },

  click: async ({ session }, args) => {
    const target = await locate(session, args);
    if (target.disabled)
      refuse(DRIVE_CODES.refused, "that control is disabled");
    await clickAt(session, target);
    await settle(session);
    const state = await pageState(session);
    return { ...state, role: target.role, name: target.name };
  },

  type: async ({ session }, args) => {
    const body = typeof args.text === "string" ? args.text : "";
    if (body.length > MAX_INSERT_TEXT) {
      refuse(
        DRIVE_CODES.badArgument,
        "that is more text than one type may send",
      );
    }
    const target = await locate(session, args);
    if (target.disabled) refuse(DRIVE_CODES.refused, "that field is disabled");
    await clickAt(session, target);
    const focused = await session.run<{ found: boolean; editable: boolean }>(
      "activeField",
    );
    if (!focused?.found || !focused.editable) {
      refuse(DRIVE_CODES.refused, "that is not a field text can be typed into");
    }
    if (flag(args, "replace")) {
      await session.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        commands: ["selectAll"],
      });
      await session.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        commands: ["deleteBackward"],
      });
    }
    if (body.length > 0) await session.send("Input.insertText", { text: body });
    if (flag(args, "submit")) await pressKey(session, "Enter", 0, 1);
    await settle(session);
    const after = await session.run<{ found: boolean; filled: boolean }>(
      "activeField",
    );
    const state = await pageState(session);
    return {
      ...state,
      chars: [...body].length,
      filled: after?.filled === true,
    };
  },

  press: async ({ session }, args) => {
    const key = text(args, "key") ?? "";
    if (!BROWSER_KEYS.includes(key)) {
      refuse(
        DRIVE_CODES.badArgument,
        `press takes one of ${BROWSER_KEYS.join(", ")}; text goes through type`,
      );
    }
    const repeat = Math.max(1, Math.min(num(args, "repeat") ?? 1, 32));
    const modifiers = Math.max(0, Math.min(num(args, "modifiers") ?? 0, 15));
    await pressKey(session, key, modifiers, repeat);
    await settle(session);
    return { key, times: repeat, ...(await pageState(session)) };
  },

  select: async ({ session }, args) => {
    const target = await locate(session, args);
    if (target.index === undefined && !text(args, "selector")) {
      refuse(DRIVE_CODES.badArgument, "select needs a --ref or a --selector");
    }
    const detail = await session.run<{
      found: boolean;
      tag: string;
      options: Array<{ value: string; label: string; selected: boolean }>;
    }>("describeElement", target.index ?? -1);
    if (!detail?.found || detail.tag !== "select") {
      refuse(DRIVE_CODES.refused, "that is not a dropdown");
    }
    const wanted = new Set([...list(args, "values"), ...list(args, "labels")]);
    if (wanted.size === 0)
      refuse(DRIVE_CODES.badArgument, "select needs a --value or a --label");
    // A native dropdown is an OS control that swallows synthesized keys, so
    // the option is reached by keyboard on the CLOSED element: focus it, then
    // step with ArrowDown until the selection is the wanted one. Every step is
    // an Input event; nothing here assigns to `value`, which would be a write
    // from a script and is not something the frozen table can do.
    await clickAt(session, target);
    for (let step = 0; step < detail.options.length; step += 1) {
      const current = await session.run<{
        options: Array<{ value: string; label: string; selected: boolean }>;
      }>("describeElement", target.index ?? -1);
      const selected = current.options.find((option) => option.selected);
      if (
        selected &&
        (wanted.has(selected.value) || wanted.has(selected.label))
      ) {
        await pressKey(session, "Enter", 0, 1);
        return { chosen: [selected.label || selected.value] };
      }
      await pressKey(session, "ArrowDown", 0, 1);
    }
    refuse(DRIVE_CODES.notFound, "that dropdown has no such option");
  },

  scroll: async ({ session }, args) => {
    const before = await session.run<{
      top: number;
      left: number;
      height: number;
    }>("scrollPosition");
    const toRef = text(args, "ref") ?? text(args, "selector");
    if (toRef) {
      // "Scroll to an element" is a wheel aimed at the difference between where
      // the element is and where the middle of the viewport is: a measured
      // move, not a script calling `scrollIntoView`.
      const target = await locate(session, args);
      const viewport = session.viewport();
      const delta = Math.round(target.y - viewport.height / 2);
      await wheel(session, delta);
    } else {
      const direction = text(args, "direction") ?? "down";
      const viewport = session.viewport();
      const amount = num(args, "amount");
      const page = Math.max(120, Math.round(viewport.height * 0.8));
      const delta =
        direction === "top"
          ? -before.height
          : direction === "bottom"
            ? before.height
            : direction === "up"
              ? -(amount ?? page)
              : (amount ?? page);
      await wheel(session, delta);
    }
    const after = await session.run<{
      top: number;
      left: number;
      height: number;
      viewportHeight: number;
    }>("scrollPosition");
    // The MEASURED move, which is what a page that refused to scroll reports
    // as zero rather than as the number that was asked for.
    return {
      moved: after.top - before.top,
      position: after.top,
      extent: Math.max(0, after.height - after.viewportHeight),
    };
  },

  wait: async ({ session }, args) => {
    const timeout = Math.max(
      0,
      Math.min(num(args, "timeoutMs") ?? 15_000, 30_000),
    );
    const selector = text(args, "selector");
    const urlContains = text(args, "urlContains");
    const titleContains = text(args, "titleContains");
    if (!selector && !urlContains && !titleContains) {
      refuse(
        DRIVE_CODES.badArgument,
        "wait needs a --selector, --url-contains or --title-contains",
      );
    }
    const started = Date.now();
    for (;;) {
      const probe = await session.run<{
        invalid: boolean;
        present: boolean;
        visible: boolean;
        title: string;
        url: string;
      }>("waitProbe", selector ?? "");
      if (probe?.invalid)
        refuse(DRIVE_CODES.badArgument, "that is not a valid CSS selector");
      const matched =
        (selector ? probe.visible : true) &&
        (urlContains ? probe.url.includes(urlContains) : true) &&
        (titleContains ? probe.title.includes(titleContains) : true);
      const waited = Date.now() - started;
      if (matched)
        return {
          matched: true,
          waitedMs: waited,
          url: probe.url,
          title: probe.title,
        };
      if (waited >= timeout) {
        return {
          matched: false,
          waitedMs: waited,
          url: probe.url,
          title: probe.title,
        };
      }
      await sleep(100);
    }
  },

  capture: async ({ session }, args) => capture(session, args),

  upload: async ({ session, nodeId }, args) => upload(session, nodeId, args),

  download: async ({ nodeId }, args) => {
    const id = text(args, "id");
    if (!id) return { downloads: stagedDownloads(nodeId) };
    const root = text(args, "workspaceRoot");
    if (!root) refuse(DRIVE_CODES.badArgument, "no workspace to save into");
    if (flag(args, "accept")) return acceptStagedDownload(nodeId, id, root);
    return rejectStagedDownload(nodeId, id);
  },

  tabs: async ({ nodeId }, args) => {
    const wanted = text(args, "switch");
    const opened = text(args, "new");
    if (opened && !allowGuestNavigation(opened)) {
      refuse(
        DRIVE_CODES.refused,
        "a browser node only opens http and https addresses",
      );
    }
    if (wanted || opened) {
      await askRenderer({
        kind: "tabs",
        nodeId,
        action: wanted ? "switch" : "new",
        tabId: wanted ?? "",
        url: opened ?? "",
      });
    }
    return tabList(nodeId);
  },

  close: async ({ nodeId }, args) => {
    const tabId = text(args, "tab");
    if (!tabId) refuse(DRIVE_CODES.badArgument, "close needs a --tab");
    const tabs = guestsOfNode(nodeId).filter(
      (guest) => guest.surface === "canvas",
    );
    if (!tabs.some((guest) => guest.tabId === tabId)) {
      refuse(DRIVE_CODES.notFound, `this node has no tab ${tabId}`);
    }
    if (tabs.length <= 1) {
      refuse(
        DRIVE_CODES.refused,
        "the last tab stays open; closing a node is not a verb",
      );
    }
    await askRenderer({
      kind: "tabs",
      nodeId,
      action: "close",
      tabId,
      url: "",
    });
    return tabList(nodeId);
  },

  dialog: async ({ session, nodeId }, args) => {
    const accept = flag(args, "accept");
    const chooser = pendingChooser(nodeId);
    if (chooser) {
      refuse(
        DRIVE_CODES.refused,
        "this page is asking for files; answer it with upload, not dialog",
      );
    }
    const open = openDialogs.get(nodeId);
    if (!open) refuse(DRIVE_CODES.notFound, "no dialog is open on this page");
    const wanted = text(args, "id");
    if (wanted && wanted !== open.id) {
      refuse(DRIVE_CODES.notFound, `no dialog ${wanted} is open on this page`);
    }
    await session.send("Page.handleJavaScriptDialog", {
      accept,
      ...(accept && open.kind === "prompt" && text(args, "text")
        ? { promptText: text(args, "text") }
        : {}),
    });
    openDialogs.delete(nodeId);
    return { kind: open.kind, message: open.message, accepted: accept };
  },

  // The lease is the Runtime's, entirely. It reaches the shell only as the
  // revocation that detaches a debugger, which is `revokeNode`, not a verb.
  lease: async () =>
    refuse(DRIVE_CODES.unknownVerb, "the lease is not a shell verb"),
};

/* ------------------------------- helpers ---------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** A short settle after anything that may navigate. Not a guarantee — `wait`
 * is the verb for that — just enough that the re-measured answer is about the
 * page the action produced rather than the one it left. */
async function settle(session: GuestSession): Promise<void> {
  await sleep(150);
  await session.refreshViewport().catch(() => undefined);
}

async function pressKey(
  session: GuestSession,
  key: string,
  modifiers: number,
  repeat: number,
): Promise<void> {
  const code = key === "Space" ? "Space" : key;
  for (let i = 0; i < repeat; i += 1) {
    await session.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      code,
      windowsVirtualKeyCode: VIRTUAL_KEYS[key] ?? 0,
      modifiers,
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: VIRTUAL_KEYS[key] ?? 0,
      modifiers,
    });
  }
}

const VIRTUAL_KEYS: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  Space: 32,
};

async function wheel(session: GuestSession, deltaY: number): Promise<void> {
  const viewport = session.viewport();
  const x = Math.max(0, Math.round(viewport.width / 2));
  const y = Math.max(0, Math.round(viewport.height / 2));
  // Chromium clamps a single wheel event, so a long move is several.
  let remaining = deltaY;
  const step = remaining < 0 ? -400 : 400;
  for (let i = 0; i < 40 && Math.abs(remaining) > 1; i += 1) {
    const delta = Math.abs(remaining) < Math.abs(step) ? remaining : step;
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY: delta,
    });
    remaining -= delta;
    await sleep(16);
  }
}

async function history(
  session: GuestSession,
  action: "back" | "forward",
): Promise<unknown> {
  const history = (await session.send("Page.getNavigationHistory", {})) as {
    currentIndex: number;
    entries: Array<{ id: number; url: string }>;
  };
  const index = history.currentIndex + (action === "back" ? -1 : 1);
  const entry = history.entries[index];
  if (!entry) {
    refuse(
      DRIVE_CODES.refused,
      action === "back"
        ? "there is nothing to go back to"
        : "there is nothing to go forward to",
    );
  }
  await session.send("Page.navigateToHistoryEntry", { entryId: entry.id });
  await settle(session);
  return pageState(session);
}

function tabList(nodeId: string): unknown {
  const tabs = guestsOfNode(nodeId)
    .filter((guest) => guest.surface === "canvas")
    .map((guest) => ({
      id: guest.tabId,
      active: guest.active,
      url: guest.contents.isDestroyed() ? "" : guest.contents.getURL(),
      title: guest.contents.isDestroyed() ? "" : guest.contents.getTitle(),
    }));
  return { tabs, activeTabId: tabs.find((tab) => tab.active)?.id ?? "" };
}

/** Open JavaScript dialogs, one per node. Filled by the drive assembly's
 * `Page.javascriptDialogOpening` subscription. */
export const openDialogs = new Map<
  string,
  { id: string; kind: string; message: string; defaultPrompt: string }
>();

/* -------------------------------- capture --------------------------------- */

async function capture(session: GuestSession, args: Args): Promise<unknown> {
  const root = text(args, "workspaceRoot");
  const requested = text(args, "path");
  if (!root) refuse(DRIVE_CODES.badArgument, "no workspace to write into");
  if (!requested) refuse(DRIVE_CODES.badArgument, "capture needs a --path");
  const format = text(args, "format") === "jpeg" ? "jpeg" : "png";
  // The directory is created BEFORE the jail check so `realpath` of the parent
  // has something to resolve — and it is created only under a path that is
  // already inside the workspace by lexical resolution, which the jail then
  // re-checks for real.
  const provisional = jailWritePath(root, requested);
  if (!provisional.ok && provisional.reason === "missingParent") {
    const lexical = jailWritePath(root, dirname(requested) || ".");
    if (lexical.ok) mkdirSync(lexical.path, { recursive: true });
  }
  const jailed = jailWritePath(root, requested);
  if (!jailed.ok) refuse(DRIVE_CODES.refused, jailMessage(jailed.reason));

  const metrics = await session.layoutMetrics();
  const clip = flag(args, "fullPage")
    ? {
        // OUR measurement, never anything the caller sent.
        x: 0,
        y: 0,
        width: Math.min(metrics.contentWidth, 16_384),
        height: Math.min(metrics.contentHeight, 16_384),
        scale: 1,
      }
    : undefined;
  const shot = (await session.send("Page.captureScreenshot", {
    format,
    ...(clip ? { clip, captureBeyondViewport: undefined } : {}),
  })) as { data: string };
  const bytes = Buffer.from(shot.data, "base64");
  writeFileSync(jailed.path, bytes, { mode: 0o600, flag: "w" });
  return {
    // The file, not the bytes: base64 in a reply is a screenshot pasted into a
    // model's context window, and it exists here only long enough to be written.
    path: jailed.path,
    width: Math.round(clip?.width ?? metrics.viewport.width),
    height: Math.round(clip?.height ?? metrics.viewport.height),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/* -------------------------------- upload ---------------------------------- */

async function upload(
  session: GuestSession,
  nodeId: string,
  args: Args,
): Promise<unknown> {
  const root = text(args, "workspaceRoot");
  if (!root) refuse(DRIVE_CODES.badArgument, "no workspace to read from");
  const wanted = list(args, "paths");
  if (wanted.length === 0)
    refuse(DRIVE_CODES.badArgument, "upload needs at least one --path");
  if (wanted.length > 20)
    refuse(DRIVE_CODES.refused, "at most twenty files at a time");
  const paths: string[] = [];
  for (const each of wanted) {
    const jailed = jailReadPath(root, each);
    // The WHOLE batch is refused, not the offending file: a partial upload is
    // a form somebody submits believing it carries what they named.
    if (!jailed.ok) refuse(DRIVE_CODES.refused, jailMessage(jailed.reason));
    paths.push(jailed.path);
  }

  // A chooser the page ALREADY opened is answered directly.
  const open = pendingChooser(nodeId);
  if (open) return answerChooser(session, nodeId, open.backendNodeId, paths);

  // Otherwise the input is clicked so the page opens one. This is the only way
  // in: `DOM.setFileInputFiles` needs the input's backend node id, and the
  // single read that would hand one over for an arbitrary selector is
  // `DOM.getDocument(depth: -1)` — the full-DOM read the allowlist exists to
  // refuse. `Page.fileChooserOpened` carries the id for the element the page
  // itself asked about, which is a much narrower thing to be given.
  const target = await locate(session, args);
  if (target.index !== undefined) {
    const detail = await session.run<{ found: boolean; accepts: boolean }>(
      "describeElement",
      target.index,
    );
    if (!detail?.found)
      refuse(DRIVE_CODES.staleRef, "that element is no longer on the page");
    if (!detail.accepts)
      refuse(DRIVE_CODES.refused, "that is not a file input");
  }
  await clickAt(session, target);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const chooser = pendingChooser(nodeId);
    if (chooser)
      return answerChooser(session, nodeId, chooser.backendNodeId, paths);
    await sleep(100);
  }
  refuse(DRIVE_CODES.notFound, "that control did not open a file chooser");
}

async function answerChooser(
  session: GuestSession,
  nodeId: string,
  backendNodeId: number,
  paths: string[],
): Promise<unknown> {
  await session.send("DOM.setFileInputFiles", { files: paths, backendNodeId });
  clearChooser(nodeId);
  // File NAMES, never the paths: the reply goes into a model's context, and
  // the absolute path of somebody's project is not something a page's form
  // needed in order to be filled in.
  return { answeredChooser: true, paths: paths.map((each) => basename(each)) };
}

/* ------------------------------- dispatch --------------------------------- */

/**
 * Runs one verb. Every refusal from here is `{ code, message }`, and the two
 * "you cannot drive this" cases produce the SAME sentence on purpose.
 */
export async function runVerb(request: DriveRequest): Promise<unknown> {
  const handler = HANDLERS[request.verb];
  if (!handler) refuse(DRIVE_CODES.unknownVerb, "that is not a browser verb");
  const found = drivableSession(request.nodeId);
  if (!found)
    refuse(DRIVE_CODES.notDrivable, notDrivableMessage(request.nodeId));
  const { entry, session } = found;
  if (entry.contents.isDestroyed()) {
    refuse(DRIVE_CODES.discarded, discardedMessage(request.nodeId));
  }
  session.clearRevocation();
  if (session.listener === null) {
    session.listener = (method, params) =>
      onDomainEvent(entry.nodeId, method, params);
  }
  await session.attach();
  return handler(
    { nodeId: entry.nodeId, tabId: entry.tabId, session },
    request.args,
  );
}
