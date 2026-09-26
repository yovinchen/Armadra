import { verbSpec } from "../verb-spec";
import { CdpRefusal, DRIVE_CODES, refuse } from "./codes";
import { parseLevel } from "./devlog";
import { capture, pdf, upload } from "./files";
import { choose, fillFields, typeInto } from "./forms";
import {
  arrive,
  chordOf,
  clickAt,
  dragBetween,
  moveTo,
  pressKey,
  sleep,
  wheel,
} from "./input";
import {
  actionable,
  findTarget,
  hasTarget,
  label,
  pointOf,
  refOrSelector,
  type Target,
} from "./locate";
import { allowGuestNavigation } from "./navigation";
import { refName } from "./refs";
import type { CdpSession } from "./session";
import { diffLines, takeSnapshot, type Snapshot } from "./snapshot";

/**
 * The verbs, executed against a page.
 *
 * One implementation for both backends: a `<webview>` guest in the desktop
 * window and a target in a headless Chromium this core started are driven by
 * the same CDP sequences. What the two do differently is held by
 * {@link VerbHost} — everything a verb needs that is NOT a CDP command: the
 * tab list, the staged downloads, the file chooser, the open dialog, and the
 * two things a headed guest does its own way (printing, resizing).
 *
 * Three rules run through all of them, and they are the reason this file is
 * not a thin wrapper over CDP:
 *
 *   1. **A ref is found again once, by what it described, or refused**
 *      (`refs.ts`). Never silently re-pointed at whatever sits where it was.
 *   2. **A field reports whether it is filled, never what is in it.** The
 *      snapshot renderer and the frozen readers both keep that rule.
 *   3. **Answers carry re-measured values.** A scroll reports the distance the
 *      page actually moved, not the distance that was asked for; a click
 *      reports the URL after the click. An answer that echoes the request is an
 *      answer that cannot tell the reader the page ignored them.
 */

type Args = Record<string, unknown>;

/** One tab of a browser node, as a verb reports it. */
export interface VerbTab {
  readonly id: string;
  readonly active: boolean;
  readonly url: string;
  readonly title: string;
}

/** A JavaScript dialog the page is holding open. */
export interface VerbDialog {
  readonly id: string;
  readonly kind: string;
  readonly message: string;
  readonly defaultPrompt: string;
}

/**
 * Everything a verb needs that is not a CDP command.
 *
 * Each method is about ONE node — the host is constructed per request, around
 * the node (and tab) the caller named — so nothing below has to pass a node id
 * into a registry and nothing can reach a node it was not handed.
 */
export interface VerbHost {
  readonly nodeId: string;
  readonly tabId: string;
  readonly session: CdpSession;

  /** `{ tabs, activeTabId }`, re-measured. */
  listTabs(): VerbTab[];
  /** Asks for a tab change. The verb's answer is the re-measured list, so a
   * request that did not land is visible without an acknowledgement. */
  requestTab(
    action: "switch" | "new" | "close",
    tabId: string,
    url: string,
  ): Promise<void>;

  listDownloads(): unknown;
  acceptDownload(id: string, workspaceRoot: string): Promise<unknown> | unknown;
  rejectDownload(id: string): Promise<unknown> | unknown;

  pendingChooser(): { readonly backendNodeId: number } | undefined;
  clearChooser(): void;

  openDialog(): VerbDialog | undefined;
  clearDialog(): void;

  /** A host whose browser prints its own way. Absent: CDP `Page.printToPDF`. */
  printToPdf?(options: { landscape: boolean }): Promise<Buffer>;
  /** A host that owns the viewport size itself (headless). Absent: CDP
   * device-metrics emulation, which ends when the debugger detaches. */
  resize?(size: { width: number; height: number } | null): Promise<void>;
}

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

/** Where the page is, after whatever just happened. Always re-read. */
async function pageState(
  session: CdpSession,
): Promise<{ url: string; title: string; generation: number; dialog?: true }> {
  // The action opened a dialog: the page answers nothing until it is handled,
  // and that is the news.
  if (session.dialogOpen())
    return {
      url: "",
      title: "",
      generation: session.refs.currentGeneration(),
      dialog: true,
    };
  const seen = await session
    .run<{ title: string; url: string }>("readTitle")
    .catch(() => undefined);
  return {
    url: seen?.url ?? "",
    title: seen?.title ?? "",
    generation: session.refs.currentGeneration(),
  };
}

function aimed(target: Target): Record<string, unknown> {
  return {
    role: target.role,
    name: target.name,
    target: label(target),
    ...(target.note === undefined ? {} : { note: target.note }),
  };
}

/* --------------------------------- verbs ---------------------------------- */

type Handler = (host: VerbHost, args: Args) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  navigate: async ({ session }, args) => {
    const action = text(args, "action") ?? "goto";
    if (action === "back" || action === "forward")
      return history(session, action);
    if (action === "reload") {
      await session.send("Page.reload", {});
      await loaded(session);
      return pageState(session);
    }
    if (action === "stop") {
      await session.send("Page.stopLoading", {});
      await settle(session);
      return { ...(await pageState(session)), stopped: true };
    }
    if (action !== "goto")
      refuse(
        DRIVE_CODES.badArgument,
        `--action 只能是 back、forward、reload 或 stop，不是 ${action}`,
      );
    const url = text(args, "url");
    if (!url) refuse(DRIVE_CODES.badArgument, "navigate 需要 --url");
    if (!allowGuestNavigation(url)) {
      refuse(DRIVE_CODES.refused, "浏览器节点只打开 http 与 https 地址");
    }
    const answer = (await session.send("Page.navigate", { url })) as {
      errorText?: string;
    };
    if (typeof answer?.errorText === "string" && answer.errorText !== "")
      refuse(DRIVE_CODES.failed, `打不开这个地址：${answer.errorText}`);
    await loaded(session);
    return pageState(session);
  },

  back: ({ session }) => history(session, "back"),
  forward: ({ session }) => history(session, "forward"),

  read: async ({ session }, args) => {
    const mode = text(args, "mode") ?? "snapshot";
    const limit = Math.max(1, Math.min(num(args, "limit") ?? 40, 500));
    const bytes = Math.max(
      512,
      Math.min(num(args, "maxBytes") ?? 16_384, 1_048_576),
    );
    type Read = Record<string, unknown>;
    switch (mode) {
      case "snapshot": {
        const depth = num(args, "depth");
        const shot = await takeSnapshot(session, {
          interactive: flag(args, "interactive"),
          ...(depth === undefined ? {} : { depth: Math.max(1, depth) }),
          maxBytes: bytes,
        });
        return { mode, ...shot, interactive: flag(args, "interactive") };
      }
      case "title":
        return { mode, ...(await session.run<Read>("readTitle")) };
      case "text":
        return { mode, ...(await session.run<Read>("readText", bytes)) };
      case "links":
        return { mode, ...(await session.run<Read>("readLinks", limit)) };
      case "console": {
        const level = parseLevel(text(args, "level"));
        if (text(args, "level") !== undefined && level === undefined)
          refuse(
            DRIVE_CODES.badArgument,
            "--level 只能是 error、warning、info、log 或 debug",
          );
        const read = session.devlog.consoleEntries({
          ...(level === undefined ? {} : { level }),
          ...(text(args, "filter") === undefined
            ? {}
            : { filter: text(args, "filter")! }),
          limit,
        });
        if (flag(args, "clear")) session.devlog.clearConsole();
        return { mode, ...read };
      }
      case "network": {
        const read = session.devlog.networkEntries({
          ...(text(args, "filter") === undefined
            ? {}
            : { filter: text(args, "filter")! }),
          ...(text(args, "type") === undefined
            ? {}
            : { type: text(args, "type")! }),
          failed: flag(args, "failed"),
          limit,
        });
        if (flag(args, "clear")) session.devlog.clearNetwork();
        return { mode, ...read };
      }
      default:
        return refuse(
          DRIVE_CODES.badArgument,
          `没有 ${mode} 这种读法；可用 snapshot、text、links、title、console、network`,
        );
    }
  },

  click: async ({ session }, args) => {
    const target = await findTarget(session, args);
    const point = await arrive(session, () => pointOf(session, target));
    await actionable(session, target);
    await clickAt(session, point, flag(args, "double") ? 2 : 1);
    await settle(session);
    return { ...(await pageState(session)), ...aimed(target) };
  },

  hover: async ({ session }, args) => {
    const target = await findTarget(session, args);
    const point = await pointOf(session, target);
    await actionable(session, target);
    await moveTo(session, point);
    await settle(session);
    return { ...(await pageState(session)), ...aimed(target) };
  },

  drag: async ({ session }, args) => {
    const fromRef = text(args, "from");
    const toRef = text(args, "to");
    if (!fromRef || !toRef)
      refuse(DRIVE_CODES.badArgument, "drag 需要 --from 与 --to");
    const from = await refOrSelector(session, fromRef);
    const to = await refOrSelector(session, toRef);
    await pointOf(session, from);
    await pointOf(session, to);
    // Arriving at the start may end a hover and move things; bringing the
    // end into view may have scrolled the start away. Measure both again.
    const start = await arrive(session, () => pointOf(session, from));
    await actionable(session, from);
    const end = await pointOf(session, to);
    await dragBetween(session, start, end);
    await settle(session);
    return {
      ...(await pageState(session)),
      from: label(from),
      to: label(to),
    };
  },

  type: async ({ session }, args) => {
    const body = typeof args.text === "string" ? args.text : "";
    const target = hasTarget(args)
      ? await findTarget(session, args)
      : undefined;
    const typed = await typeInto(session, target, body, {
      replace: flag(args, "replace"),
      submit: flag(args, "submit"),
    });
    await settle(session);
    return {
      ...(await pageState(session)),
      ...typed,
      ...(target === undefined ? {} : aimed(target)),
    };
  },

  fill: async ({ session }, args) => {
    const done = await fillFields(session, list(args, "fields"));
    await settle(session);
    return { ...(await pageState(session)), ...done };
  },

  select: async ({ session }, args) => {
    const target = await findTarget(session, args);
    const wanted = [...list(args, "values"), ...list(args, "labels")];
    const chosen = await choose(session, target, wanted);
    await settle(session);
    return { chosen, ...aimed(target) };
  },

  press: async ({ session }, args) => {
    const key = text(args, "key");
    if (!key) refuse(DRIVE_CODES.badArgument, "press 需要 --key");
    const chord = chordOf(key, num(args, "modifiers") ?? 0);
    const repeat = Math.max(1, Math.min(num(args, "repeat") ?? 1, 32));
    await pressKey(session, chord, repeat);
    await settle(session);
    return { key, times: repeat, ...(await pageState(session)) };
  },

  scroll: async ({ session }, args) => {
    const before = await session.run<{
      top: number;
      left: number;
      height: number;
      width: number;
    }>("scrollPosition");
    let target: Target | undefined;
    if (hasTarget(args)) {
      // An element is brought into view by the page's own scrolling, in
      // whatever container (or iframe) it is in; the answer measures the page.
      target = await findTarget(session, args);
      await pointOf(session, target);
    } else {
      const direction = text(args, "direction") ?? "down";
      const viewport = session.viewport();
      const amount = num(args, "amount");
      const pageY = Math.max(120, Math.round(viewport.height * 0.8));
      const pageX = Math.max(120, Math.round(viewport.width * 0.8));
      switch (direction) {
        case "top":
          await wheel(session, 0, -before.height);
          break;
        case "bottom":
          await wheel(session, 0, before.height);
          break;
        case "up":
          await wheel(session, 0, -(amount ?? pageY));
          break;
        case "down":
          await wheel(session, 0, amount ?? pageY);
          break;
        case "left":
          await wheel(session, -(amount ?? pageX), 0);
          break;
        case "right":
          await wheel(session, amount ?? pageX, 0);
          break;
        default:
          refuse(
            DRIVE_CODES.badArgument,
            "--direction 只能是 up、down、left、right、top 或 bottom",
          );
      }
    }
    await sleep(120);
    const after = await session.run<{
      top: number;
      left: number;
      height: number;
      width: number;
      viewportHeight: number;
      viewportWidth: number;
    }>("scrollPosition");
    // The MEASURED move, which is what a page that refused to scroll reports
    // as zero rather than as the number that was asked for.
    return {
      moved: Math.round(after.top - before.top),
      movedX: Math.round(after.left - before.left),
      position: Math.round(after.top),
      extent: Math.max(0, Math.round(after.height - after.viewportHeight)),
      ...(target === undefined ? {} : aimed(target)),
    };
  },

  wait: async ({ session }, args) => waitFor(session, args),

  capture: async ({ session }, args) => capture(session, args),

  pdf: async (host, args) => pdf(host, args),

  resize: async (host, args) => {
    const reset = flag(args, "reset");
    const width = num(args, "width");
    const height = num(args, "height");
    if (!reset && (width === undefined || height === undefined))
      refuse(
        DRIVE_CODES.badArgument,
        "resize 需要 --width 与 --height，或 --reset",
      );
    if (
      !reset &&
      (width! < 200 || width! > 3_840 || height! < 200 || height! > 2_160)
    )
      refuse(
        DRIVE_CODES.badArgument,
        "宽度要在 200–3840、高度在 200–2160 之间",
      );
    const size = reset ? null : { width: width!, height: height! };
    if (host.resize !== undefined) await host.resize(size);
    else if (size === null)
      await host.session.send("Emulation.clearDeviceMetricsOverride", {});
    else
      await host.session.send("Emulation.setDeviceMetricsOverride", {
        ...size,
        deviceScaleFactor: 0,
        mobile: false,
      });
    await settle(host.session);
    const viewport = await host.session.refreshViewport();
    return { width: viewport.width, height: viewport.height, reset };
  },

  upload: async (host, args) => upload(host, args),

  download: async (host, args) => {
    const id = text(args, "id");
    if (!id) return { downloads: host.listDownloads() };
    const root = text(args, "workspaceRoot");
    if (!root) refuse(DRIVE_CODES.badArgument, "没有可写入的工作区");
    if (flag(args, "accept")) return host.acceptDownload(id, root);
    return host.rejectDownload(id);
  },

  tabs: async (host, args) => {
    const wanted = text(args, "switch");
    const opened = text(args, "new");
    if (opened && !allowGuestNavigation(opened)) {
      refuse(DRIVE_CODES.refused, "浏览器节点只打开 http 与 https 地址");
    }
    if (wanted && !host.listTabs().some((tab) => tab.id === wanted))
      refuse(DRIVE_CODES.notFound, `这个节点没有标签页 ${wanted}`);
    if (wanted || opened) {
      await host.requestTab(
        wanted ? "switch" : "new",
        wanted ?? "",
        opened ?? "",
      );
    }
    return tabList(host);
  },

  close: async (host, args) => {
    const tabId = text(args, "tab");
    if (!tabId) refuse(DRIVE_CODES.badArgument, "close 需要 --tab");
    const tabs = host.listTabs();
    if (!tabs.some((tab) => tab.id === tabId)) {
      refuse(DRIVE_CODES.notFound, `这个节点没有标签页 ${tabId}`);
    }
    if (tabs.length <= 1) {
      refuse(DRIVE_CODES.refused, "最后一个标签页不关；关节点不是浏览器动词");
    }
    await host.requestTab("close", tabId, "");
    return tabList(host);
  },

  dialog: async (host, args) => {
    const accept = flag(args, "accept");
    const chooser = host.pendingChooser();
    if (chooser) {
      refuse(
        DRIVE_CODES.refused,
        "页面在要文件；请用 upload 回答，不是 dialog",
      );
    }
    const open = host.openDialog();
    if (!open) refuse(DRIVE_CODES.notFound, "这个页面没有打开的对话框");
    const wanted = text(args, "id");
    if (wanted && wanted !== open.id) {
      refuse(DRIVE_CODES.notFound, `没有打开的对话框 ${wanted}`);
    }
    await host.session.send("Page.handleJavaScriptDialog", {
      accept,
      ...(accept && open.kind === "prompt" && text(args, "text")
        ? { promptText: text(args, "text") }
        : {}),
    });
    host.clearDialog();
    await settle(host.session);
    return { kind: open.kind, message: open.message, accepted: accept };
  },

  // The lease is the core's, entirely. It reaches a backend only as the
  // revocation that detaches a debugger, which is not a verb.
  lease: async () => refuse(DRIVE_CODES.unknownVerb, "租约不是页面动词"),
};

/** Whether a name is one this file executes. */
export function isVerb(name: string): boolean {
  return Object.hasOwn(HANDLERS, name);
}

/** The names this file executes, for the one-list consistency test. */
export function implementedVerbs(): string[] {
  return Object.keys(HANDLERS);
}

/* ------------------------------- helpers ---------------------------------- */

/** A short settle after anything that may navigate. Not a guarantee — `wait`
 * is the verb for that — just enough that the re-measured answer is about the
 * page the action produced rather than the one it left. */
async function settle(session: CdpSession): Promise<void> {
  await sleep(150);
  if (session.dialogOpen()) return;
  await session.refreshViewport().catch(() => undefined);
}

/** After a navigation: until the new document is at least interactive. */
async function loaded(session: CdpSession): Promise<void> {
  await sleep(100);
  for (let i = 0; i < 80; i += 1) {
    const probe = await session
      .run<{ ready?: string }>("waitProbe", "")
      .catch(() => undefined);
    if (probe?.ready === "complete" || probe?.ready === "interactive") break;
    await sleep(100);
  }
  await session.refreshViewport().catch(() => undefined);
}

async function history(
  session: CdpSession,
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
      action === "back" ? "已经退到最前" : "没有可前进的页面",
    );
  }
  await session.send("Page.navigateToHistoryEntry", { entryId: entry.id });
  await loaded(session);
  return pageState(session);
}

function tabList(host: VerbHost): unknown {
  const tabs = host.listTabs();
  return { tabs, activeTabId: tabs.find((tab) => tab.active)?.id ?? "" };
}

/** Whether a text is on the page, cross-origin iframes included. */
async function textOnPage(
  session: CdpSession,
  needle: string,
): Promise<boolean> {
  const main = await session
    .run<{ found: boolean }>("hasText", needle)
    .catch(() => undefined);
  if (main?.found === true) return true;
  for (const child of session.childFrames()) {
    const inner = await session
      .run<{ found: boolean }>("hasText", needle, child.sessionId)
      .catch(() => undefined);
    if (inner?.found === true) return true;
  }
  return false;
}

async function waitFor(session: CdpSession, args: Args): Promise<unknown> {
  const timeout = Math.max(
    0,
    Math.min(num(args, "timeoutMs") ?? 15_000, 30_000),
  );
  const selector = text(args, "selector");
  const urlContains = text(args, "urlContains");
  const titleContains = text(args, "titleContains");
  const present = text(args, "text");
  const gone = text(args, "textGone");
  const idle = flag(args, "idle");
  if (
    !selector &&
    !urlContains &&
    !titleContains &&
    !present &&
    !gone &&
    !idle
  ) {
    refuse(
      DRIVE_CODES.badArgument,
      "wait 需要 --text、--text-gone、--idle、--selector、--url-contains 或 --title-contains",
    );
  }
  const started = Date.now();
  for (;;) {
    const probe = await session.run<{
      invalid: boolean;
      visible: boolean;
      title: string;
      url: string;
    }>("waitProbe", selector ?? "");
    if (probe?.invalid)
      refuse(DRIVE_CODES.badArgument, `${selector} 不是有效的 CSS 选择器`);
    const matched =
      (selector ? probe.visible : true) &&
      (urlContains ? probe.url.includes(urlContains) : true) &&
      (titleContains ? probe.title.includes(titleContains) : true) &&
      (present ? await textOnPage(session, present) : true) &&
      (gone ? !(await textOnPage(session, gone)) : true) &&
      (idle
        ? session.devlog.inFlight() === 0 && session.devlog.quietFor() >= 500
        : true);
    const waited = Date.now() - started;
    if (matched || waited >= timeout) {
      return {
        matched,
        waitedMs: waited,
        url: probe.url,
        title: probe.title,
        ...(idle ? { inFlight: session.devlog.inFlight() } : {}),
      };
    }
    await sleep(100);
  }
}

/* ------------------------------ the diff ---------------------------------- */

/** What the page is read with for a diff: the same whole-page snapshot a
 * plain `read` gives, with room enough that a long page is not "changed" just
 * because its tail fell off. */
const BASELINE_BYTES = 256 * 1024;
/** What an action's answer may carry of it. */
const TAIL_BYTES = 8 * 1024;

function capped(
  lines: readonly string[],
  budget: number,
): { lines: string[]; cut: boolean } {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    used += Buffer.byteLength(line, "utf8") + 3;
    if (used > budget) return { lines: out, cut: true };
    out.push(line);
  }
  return { lines: out, cut: false };
}

/**
 * `--snapshot`: what the action changed, so the next step does not need a
 * `read`. Against the previous whole-page snapshot of the same page it is a
 * diff; after a navigation, or with no previous snapshot, it is the page.
 */
async function afterSnapshot(
  session: CdpSession,
): Promise<Record<string, unknown>> {
  const previous = session.lastSnapshot;
  const shot: Snapshot = await takeSnapshot(session, {
    interactive: false,
    maxBytes: BASELINE_BYTES,
  });
  if (
    previous === undefined ||
    previous.generation !== session.refs.currentGeneration()
  ) {
    const tail = capped(shot.lines, TAIL_BYTES);
    return {
      snapshot: {
        kind: "full",
        lines: tail.lines,
        truncated: tail.cut || shot.truncated,
      },
    };
  }
  const { added, removed } = diffLines(previous.lines, shot.lines);
  const plus = capped(added, TAIL_BYTES / 2);
  const minus = capped(removed, TAIL_BYTES / 2);
  return {
    snapshot: {
      kind: "diff",
      added: plus.lines,
      removed: minus.lines,
      truncated: plus.cut || minus.cut || shot.truncated,
    },
  };
}

/* ------------------------------- dispatch --------------------------------- */

/** Verbs that still work while a page holds a JavaScript dialog open. */
const DURING_DIALOG = new Set(["dialog", "tabs", "download", "lease", "close"]);

/**
 * Runs one verb against one host.
 *
 * Whether the caller MAY do this was decided in `core/browser` long before
 * here; what is left is the page. Every refusal is a {@link CdpRefusal}, which
 * is `{ code, message }` by the time it reaches a wire.
 */
export async function runVerbOnHost(
  host: VerbHost,
  verb: string,
  args: Args,
): Promise<unknown> {
  const handler = HANDLERS[verb];
  if (!handler) refuse(DRIVE_CODES.unknownVerb, "没有这个浏览器动词");
  // A page holding an alert open answers nothing else — every script call
  // would hang behind the modal — so the verb is refused up front, with the
  // dialog's own text, instead of timing out forty seconds later.
  const dialog = host.openDialog();
  const readsBuffers =
    verb === "read" && (args.mode === "console" || args.mode === "network");
  const blocked = dialog !== undefined || host.session.dialogOpen();
  if (blocked && !DURING_DIALOG.has(verb) && !readsBuffers) {
    refuse(
      DRIVE_CODES.dialogPending,
      dialog === undefined
        ? "页面弹着对话框；先用 dialog --accept 或 --dismiss 处理"
        : `页面弹着 ${dialog.kind} 对话框：${dialog.message.slice(0, 300)}；先用 dialog --accept 或 --dismiss 处理`,
    );
  }
  const result = await handler(host, args);
  if (args.snapshot === true && verbSpec(verb)?.changesPage === true) {
    if (host.session.dialogOpen()) return result;
    const extra = await afterSnapshot(host.session).catch(() => ({}));
    return { ...(result as Record<string, unknown>), ...extra };
  }
  return result;
}

export { CdpRefusal, refName };
