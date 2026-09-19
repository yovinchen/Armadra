import { BrowserWindow, app } from "electron";
import { join } from "node:path";
import { traceLifecycle } from "./trace";
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

  current = window;
  return window;
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
