import { BrowserWindow, app } from "electron";
import { join } from "node:path";
import { traceLifecycle } from "./trace";
import { createCrashReloadPolicy } from "../shell-core/crash-reload";
import { closeAction, rendererTarget } from "../shell-core/window-rules";

/**
 * The main window, and the one rule about talking to it.
 *
 * EVERY place in the main process that pushes IPC to the renderer must resolve
 * the window AT SEND TIME through `sendToWindow()` — never capture a
 * `BrowserWindow` in a closure at init. On macOS the window can be closed
 * (the app stays alive, and so do the Runtime, the Host and the user's
 * terminals) and recreated from the dock; a captured reference then points at
 * a destroyed window and every send is silently dropped. nodeterm shipped that
 * bug — agent status badges died after a close→reopen cycle — and its
 * `main-window.ts:1-6` is where this rule is written down.
 */

let current: BrowserWindow | null = null;
/** Set once the quit sequence starts, so `close` stops meaning `hide`. */
let quitting = false;

/**
 * What to do to every window this module makes — the per-window wiring other
 * modules own, `before-input-event` above all.
 *
 * A hook rather than a direct call because macOS recreates the window from the
 * dock after a close, and anything installed only on the FIRST window silently
 * stops working after that cycle. It also keeps the dependency one-way:
 * `menu.ts` reaches into this module, and this module must not reach back.
 */
const created: ((window: BrowserWindow) => void)[] = [];

export function onWindowCreated(
  listener: (window: BrowserWindow) => void,
): void {
  created.push(listener);
}

export function markQuitting(): void {
  quitting = true;
}

export function isQuitting(): boolean {
  return quitting;
}

export function getMainWindow(): BrowserWindow | null {
  return current && !current.isDestroyed() ? current : null;
}

/** Resolves the window at send time. A closed window drops the message. */
export function sendToWindow(channel: string, ...args: unknown[]): void {
  getMainWindow()?.webContents.send(channel, ...args);
}

export function createMainWindow(): BrowserWindow {
  const darwin = process.platform === "darwin";
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    // The canvas is the product; the window opens on it rather than on a
    // white flash while the bundle parses.
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 24 },
    ...(darwin ? { vibrancy: "sidebar" as const, transparent: false } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // NOT sandboxed: the preload needs `webUtils.getPathForFile` to turn a
      // dropped File into the absolute path the Runtime opens (§2.3), and
      // `webUtils` is unavailable in a sandboxed preload.
      sandbox: false,
      // Browser nodes (§4) are <webview> guests.
      webviewTag: true,
    },
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("close", (event) => {
    traceLifecycle("foreground close requested");
    const action = closeAction(
      process.platform,
      quitting,
      window.isFullScreen(),
    );
    if (action === "default") return;
    event.preventDefault();
    if (action === "hide") {
      window.hide();
      return;
    }
    window.once("leave-full-screen", () => window.hide());
    window.setFullScreen(false);
  });

  window.on("closed", () => {
    // Guard: a late 'closed' from a replaced window must not clear its successor.
    if (current === window) current = null;
  });

  // A dead renderer is a blank window over a Runtime that is still running and
  // still holding the user's terminals; reloading gets the canvas back. The
  // policy is what stops that from becoming a loop — see `crash-reload.ts`.
  const crashes = createCrashReloadPolicy();
  window.webContents.on("render-process-gone", (_event, details) => {
    traceLifecycle(`renderer gone: ${details.reason}`);
    if (!crashes.shouldReload(details.reason, Date.now())) return;
    if (window.isDestroyed()) return;
    void loadRenderer(window);
  });

  for (const listener of created) listener(window);

  current = window;
  return window;
}

/**
 * What ⌘W and the menu's Close item mean. Going through `close()` rather than
 * `hide()` keeps ONE place deciding — `closeAction` above — so the fullscreen
 * rule (electron/electron#20263) cannot be bypassed by a second caller.
 */
export function closeWindow(): void {
  getMainWindow()?.close();
}

/** Brings the window back from hidden or minimized, creating it if it is gone. */
export function revealWindow(): BrowserWindow | null {
  if (quitting) return null;
  const existing = getMainWindow();
  const window = existing ?? createMainWindow();
  if (existing === null) void loadRenderer(window);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

export async function loadRenderer(window: BrowserWindow): Promise<void> {
  const target = rendererTarget(
    process.env.ELECTRON_RENDERER_URL,
    app.isPackaged,
    join(__dirname, "../renderer/index.html"),
  );
  if (target.kind === "url") await window.loadURL(target.url);
  else await window.loadFile(target.path);
}
