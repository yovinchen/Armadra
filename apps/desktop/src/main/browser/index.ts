import { Menu, clipboard, type WebContents } from "electron";

import type { DriveEvent } from "../../shell-core/browser/drive";
import {
  allowGuestNavigation,
  decidePopup,
} from "../../shell-core/browser/navigation";
import {
  guestContextMenu,
  inspectElementPoint,
} from "../../shell-core/browser/context-menu";
import { publishEvent, setPublisher } from "./bus";
import { attachCount, sentMethods } from "./cdp";
import { startDriveServer, type DriveServer } from "./drive-server";
import {
  allGuests,
  guestByWebContentsId,
  guestsOfNode,
  isRegisteredGuest,
  onGuestLost,
  registerGuest,
  unregisterGuest,
} from "./registry";
import { tellRenderer } from "./renderer";
import {
  clearChooser,
  configureStaging,
  forgetNodeTransfers,
  watchDownloads,
} from "./transfers";
import { openDialogs, runVerb } from "./verbs";

/**
 * The browser node's assembly (W3.3 / W3.4).
 *
 * Everything with a rule worth stating is in `shell-core/browser/` or in one of
 * the modules beside this file; this one holds them together and is the only
 * place here that touches app-level Electron objects.
 */

let server: DriveServer | null = null;

export interface BrowserWiring {
  readonly driveAddress: string;
  readonly driveToken: string;
}

/**
 * Starts the drive channel and returns the two values `runtime-process.ts` puts
 * in the Runtime's spawn environment. There is no other way for the Runtime to
 * learn them: not a file, not a well-known port, not a constant.
 */
export async function installBrowser(dataDir: string): Promise<BrowserWiring> {
  configureStaging(dataDir);
  server = await startDriveServer(runVerb, (notice, nodeId, detail) => {
    if (notice === "lease") {
      // Straight through to the node's badge. The shell does not decide who
      // holds a lease and does not cache one; it carries the Runtime's answer
      // to the only process that can draw it.
      tellRenderer({ kind: "lease", nodeId, lease: detail });
      return;
    }
    if (notice !== "revoke") return;
    const reason =
      typeof detail === "object" && detail !== null && "reason" in detail
        ? String((detail as { reason: unknown }).reason)
        : "agent control ended";
    revokeNode(nodeId, reason);
  });
  setPublisher((event) => server?.publish(event));

  // A guest going away for ANY reason drops the lease. The registry calls this
  // BEFORE it forgets the entry, so the detach still has something to detach.
  onGuestLost((nodeId, reason) => {
    if (guestsOfNode(nodeId).length === 0) {
      forgetNodeTransfers(nodeId);
      openDialogs.delete(nodeId);
    }
    publishEvent({ type: "event", event: "guestLost", nodeId, reason });
  });

  return { driveAddress: server.address, driveToken: server.token };
}

export function publish(event: DriveEvent): void {
  publishEvent(event);
}

export function driveConnected(): boolean {
  return server?.connected() ?? false;
}

export function stopBrowser(): void {
  server?.close();
  server = null;
  setPublisher(() => {});
}

/* ------------------------------ registration ------------------------------ */

/** `browser:register`. The renderer calls it on the guest's `dom-ready`. */
export function handleRegister(raw: unknown): { ok: boolean; reason?: string } {
  const outcome = registerGuest(raw);
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  const registration = raw as {
    webContentsId: number;
    hostX?: number;
    hostY?: number;
  };
  const entry = guestByWebContentsId(registration.webContentsId);
  setHostRect(
    registration.webContentsId,
    registration.hostX,
    registration.hostY,
  );
  if (entry) wireGuest(entry.contents, outcome.nodeId);
  publishEvent({
    type: "event",
    event: "registered",
    nodeId: outcome.nodeId,
    tabId: outcome.tabId,
    url: entry && !entry.contents.isDestroyed() ? entry.contents.getURL() : "",
  });
  return { ok: true };
}

/** `browser:unregister`. */
export function handleUnregister(raw: unknown): { ok: boolean } {
  const id =
    typeof raw === "number"
      ? raw
      : typeof raw === "object" && raw !== null
        ? (raw as { webContentsId?: unknown }).webContentsId
        : undefined;
  if (typeof id !== "number") return { ok: false };
  unregisterGuest(id, "unregistered");
  return { ok: true };
}

/**
 * A person took the page back, or the Runtime's lease machine says the lease
 * ended. Both DETACH; neither merely stops showing a badge. A Stop that only
 * hides the chip is a Critical-class bug, and this function is the reason it
 * cannot be written by accident — every revocation path calls it.
 */
export function revokeNode(nodeId: string, reason: string): void {
  for (const entry of guestsOfNode(nodeId)) entry.session?.detach(reason);
  clearChooser(nodeId);
  openDialogs.delete(nodeId);
}

/** For the acceptance gate: what has been attached and what has been sent. */
export function driveCounters(): {
  attaches: number;
  methods: readonly string[];
  guests: number;
} {
  return {
    attaches: attachCount(),
    methods: sentMethods(),
    guests: allGuests().length,
  };
}

/* -------------------------------- per guest -------------------------------- */

const wired = new WeakSet<WebContents>();

function wireGuest(contents: WebContents, nodeId: string): void {
  if (wired.has(contents)) return;
  wired.add(contents);

  // The AUTHORITATIVE navigation gate. The renderer has one too, and this is
  // not it: a `will-navigate` listener in the page sees what the embedder is
  // told, while this one runs where the navigation is decided.
  contents.on("will-navigate", (event, url) => {
    if (!allowGuestNavigation(url)) event.preventDefault();
  });
  contents.on("will-frame-navigate", (event) => {
    if (!allowGuestNavigation(event.url)) event.preventDefault();
  });

  // A guest never gets a real window. An http(s) target from a guest this shell
  // registered becomes another node or tab on the canvas instead; anything else
  // is dropped in silence, because an unregistered guest is not something the
  // canvas knows how to place.
  contents.setWindowOpenHandler(({ url }) => {
    const decision = decidePopup(url, isRegisteredGuest(contents));
    if (decision.report)
      tellRenderer({ kind: "popup", nodeId, url: decision.url });
    return { action: "deny" };
  });

  contents.on("did-navigate", (_event, url) => {
    publishEvent({ type: "event", event: "navigated", nodeId, url });
  });
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame)
      publishEvent({ type: "event", event: "navigated", nodeId, url });
  });

  // A person touching the page is what preempts an agent. This replaces the old
  // frame stream's upstream input as the source of "a human did something
  // here": it fires in the main process for real keyboard and mouse input into
  // the guest, which no longer travels through the Runtime at all.
  contents.on("before-input-event", () => {
    publishEvent({ type: "event", event: "humanInput", nodeId });
  });
  contents.on("focus", () => {
    publishEvent({ type: "event", event: "humanFocus", nodeId });
  });

  contents.on("context-menu", (_event, params) => {
    showGuestMenu(contents, nodeId, params as unknown as ContextMenuParams);
  });

  watchDownloads(
    contents.session,
    (webContentsId) => guestByWebContentsId(webContentsId)?.nodeId ?? null,
    (download) => {
      publishEvent({
        type: "event",
        event: "download",
        nodeId: download.nodeId,
        id: download.id,
        state: download.state,
        suggestedFilename: download.suggestedFilename,
        bytes: download.bytes,
      });
    },
  );
}

/* ------------------------------ context menu ------------------------------- */

interface ContextMenuParams {
  x: number;
  y: number;
  isEditable: boolean;
  selectionText: string;
  linkURL: string;
  editFlags: { canCut?: boolean; canCopy?: boolean; canPaste?: boolean };
}

/** The canvas zoom, kept current by the renderer so the inspect conversion has
 * a scale to divide by. One number, used for nothing else. */
let canvasZoom = 1;

export function setCanvasZoom(zoom: unknown): void {
  if (typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0)
    canvasZoom = zoom;
}

function showGuestMenu(
  contents: WebContents,
  nodeId: string,
  params: ContextMenuParams,
): void {
  const template = guestContextMenu({
    isEditable: params.isEditable,
    selectionText: params.selectionText,
    linkURL: params.linkURL,
    editFlags: params.editFlags,
    developerTools: true,
  });
  Menu.buildFromTemplate(
    template.map((item) => {
      if (item.type === "separator") return { type: "separator" as const };
      if (item.role) {
        return {
          role: item.role as "cut" | "copy" | "paste" | "selectAll",
          enabled: item.enabled ?? true,
        };
      }
      return {
        label: labelFor(item.id ?? ""),
        click: () => act(item.id ?? ""),
      };
    }),
  ).popup();

  function act(id: string): void {
    switch (id) {
      case "copyLink":
        clipboard.writeText(params.linkURL);
        return;
      case "openLinkInNewTab":
        if (allowGuestNavigation(params.linkURL)) {
          tellRenderer({ kind: "popup", nodeId, url: params.linkURL });
        }
        return;
      case "back":
        if (contents.navigationHistory.canGoBack())
          contents.navigationHistory.goBack();
        return;
      case "forward":
        if (contents.navigationHistory.canGoForward())
          contents.navigationHistory.goForward();
        return;
      case "reload":
        contents.reload();
        return;
      case "inspectElement": {
        // `params.x/y` are HOST WINDOW coordinates (webview-probe §4), while
        // `inspectElement` wants the guest's. Subtracting the element's host
        // origin and dividing by the canvas zoom is the whole conversion;
        // skipping it opens DevTools on the wrong element at every zoom but 1.
        const point = inspectElementPoint(
          params,
          hostRectOf(contents),
          canvasZoom,
        );
        contents.inspectElement(point.x, point.y);
        return;
      }
      default:
    }
  }
}

function labelFor(id: string): string {
  switch (id) {
    case "copyLink":
      return "Copy Link";
    case "openLinkInNewTab":
      return "Open Link in New Tab";
    case "back":
      return "Back";
    case "forward":
      return "Forward";
    case "reload":
      return "Reload";
    default:
      return "Inspect Element";
  }
}

/**
 * Where this guest's `<webview>` sits in its host window.
 *
 * Published by the renderer with each registration, because only the page knows
 * where React Flow put the element. Absent, the origin is the window's own,
 * which is right for a guest that fills the window and merely imprecise for one
 * that does not.
 */
const hostRects = new Map<number, { x: number; y: number }>();

export function setHostRect(
  webContentsId: unknown,
  x: unknown,
  y: unknown,
): void {
  if (typeof webContentsId !== "number") return;
  if (typeof x !== "number" || typeof y !== "number") return;
  hostRects.set(webContentsId, { x, y });
}

function hostRectOf(contents: WebContents): { x: number; y: number } {
  return hostRects.get(contents.id) ?? { x: 0, y: 0 };
}
