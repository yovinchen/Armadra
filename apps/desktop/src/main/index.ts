import { app, dialog, ipcMain } from "electron";
import { join } from "node:path";
import {
  ALL_CHANNELS,
  IMPLEMENTED_CHANNELS,
  IPC,
  NOT_IMPLEMENTED,
  type PickOptions,
  type NativeTicketAnswer,
  type TransportEndpoints,
  ipcError,
  ipcRejection,
} from "../shared/ipc";
import { dataDir } from "../shell-core/paths";
import { DEFAULT_DEV_RENDERER_URL } from "../shell-core/window-rules";
import {
  iconPath,
  setAboutPanel,
  setApplicationName,
  setDockIcon,
} from "./branding";
import { HOST_ENDPOINT, configFromEnvironment } from "./host";
import { deviceName, issueNativeTicket } from "./host/ticket";
import {
  DesktopLifecycle,
  quitFailureDialog,
  runQuitSequence,
} from "./lifecycle";
import {
  RuntimeProcess,
  externalRuntimeBase,
  ownedRuntimeAddress,
  setPackagedShell,
  startsHost,
  waitForRuntime,
} from "./runtime-process";
import { type PageSource, startPageSource } from "./static-server";
import { traceLifecycle } from "./trace";
import { installUpdates } from "./updates";
import {
  endpointsSnapshot,
  fallbackEndpoints,
  publishEndpoints,
  resolveEndpoints,
} from "./transport";
import {
  applyContentSecurityPolicy,
  createMainWindow,
  getMainWindow,
  loadRenderer,
  markQuitting,
  onWindowCreated,
  revealWindow,
  setPageUrl,
} from "./window";
import {
  driveConnected,
  handleRegister,
  handleUnregister,
  installBrowser,
  publish,
  setCanvasZoom,
  setHostRect,
} from "./browser";
import { setDriveEnvironment } from "./runtime-process";
import { pickDirectory, pickFiles } from "./dialogs";
import { openExternal } from "./external";
import { installApplicationMenu, installKeydownIntercept } from "./menu";
import { applyShortcuts, releaseShortcuts } from "./shortcuts";
import { createTray, destroyTray } from "./tray";
import { ownsRuntime } from "../shell-core/runtime/identity";

/**
 * The application's assembly. Everything with a rule worth stating lives in
 * `shell-core/` (pure) or in a named module beside this one; this file is the
 * Electron plumbing around them, the same division the Rust shell
 * drew between `lib.rs` and `main.rs`.
 */

const lifecycle = new DesktopLifecycle();
const runtime = new RuntimeProcess();
const development = !app.isPackaged;
const updates = installUpdates(lifecycle, runtime);
/** Set by `start()` before any window exists; every origin decision reads it. */
let page: PageSource | null = null;

/* ------------------------------ the IPC table ----------------------------- */

/**
 * Registers every channel in the table. The three this batch implements get a
 * real handler; the rest reject with `{ code: "not_implemented" }`.
 *
 * A placeholder rather than an omission on purpose: an unregistered channel
 * surfaces in the page as `Error: No handler registered for '…'`, which reads
 * like a typo, while a `not_implemented` code says which batch owes the work.
 */
function registerIpc(): void {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    [IPC.transportEndpoints.channel]: transportEndpoints,
    [IPC.identityTicket.channel]: nativeTicket,
    [IPC.appLocale.channel]: () => app.getLocale(),
    [IPC.windowIsFocused.channel]: () => getMainWindow()?.isFocused() ?? false,
    // W2.2: the seven update channels. The updater is assembled here because
    // it is the one place that holds both the Host's lifecycle and the
    // Runtime — it has to stop both before an installer may run (§2.3).
    ...updates.handlers,
    [IPC.dialogPickDirectory.channel]: (options) =>
      pickDirectory(options as PickOptions | undefined),
    [IPC.dialogPickFiles.channel]: (options) =>
      pickFiles(options as PickOptions | undefined),
    [IPC.shellOpenExternal.channel]: (url) => openExternal(url),
    [IPC.shortcutsApply.channel]: (bindings) => applyShortcuts(bindings),
    // W3.3 / W3.4. Registration is validated in `main/browser/registry.ts`,
    // including the `getType() === 'webview'` check the page cannot be trusted
    // to have made: the id it sends later selects a webContents to attach a
    // debugger to.
    [IPC.browserRegister.channel]: (registration) =>
      handleRegister(registration),
    [IPC.browserUnregister.channel]: (id) => handleUnregister(id),
    [IPC.browserView.channel]: (view) => {
      const geometry = view as
        | {
            webContentsId?: unknown;
            hostX?: unknown;
            hostY?: unknown;
            zoom?: unknown;
          }
        | undefined;
      setHostRect(geometry?.webContentsId, geometry?.hostX, geometry?.hostY);
      setCanvasZoom(geometry?.zoom);
      return { ok: true };
    },
    // Stop travels ON, to the Runtime's lease machine. A Stop that stopped
    // here would hide a badge and leave a debugger attached, which is the one
    // failure the whole ownership design is written against.
    [IPC.browserControl.channel]: (control) => {
      const asked = control as
        | { nodeId?: unknown; action?: unknown }
        | undefined;
      if (
        typeof asked?.nodeId !== "string" ||
        typeof asked.action !== "string"
      ) {
        return { ok: false };
      }
      publish({
        type: "event",
        event: "control",
        nodeId: asked.nodeId,
        action: asked.action,
      });
      return { ok: driveConnected() };
    },
  };
  // The page decides its Runtime base before its first `await`, so the same
  // channel also answers synchronously from the snapshot taken at startup.
  ipcMain.on(IPC.transportEndpoints.channel, (event) => {
    event.returnValue = endpointsSnapshot(fallbackTransport);
  });
  // The table and the implementation list must agree: a handler added here
  // without being listed there (or the reverse) is how a channel quietly
  // becomes reachable, or quietly stops being.
  const declared = Object.keys(handlers).sort().join(",");
  if (declared !== [...IMPLEMENTED_CHANNELS].sort().join(",")) {
    throw new Error(
      "IMPLEMENTED_CHANNELS does not match the handlers registered here",
    );
  }
  for (const spec of ALL_CHANNELS) {
    if (spec.direction !== "invoke") continue;
    const handler = handlers[spec.channel];
    if (handler) {
      ipcMain.handle(spec.channel, (_event, ...args) => handler(...args));
      continue;
    }
    ipcMain.handle(spec.channel, () => {
      throw ipcRejection(
        NOT_IMPLEMENTED,
        `${spec.channel} is not implemented yet`,
      );
    });
  }
}

/**
 * Where the page should send its traffic.
 *
 * Both bases come from `endpoints.json`, whether this shell started the
 * Runtime or attached to somebody else's: the port is kernel-assigned either
 * way, so the published document is the only thing that knows it. The
 * documented default port is the fallback, not a guess dressed up as an
 * answer — without the document there is nothing else the page could try.
 */
function transportEndpoints(): Promise<TransportEndpoints> {
  return resolveEndpoints(dataDir(), externalRuntimeBase(), hostBase());
}

function fallbackTransport(): TransportEndpoints {
  return fallbackEndpoints(externalRuntimeBase(), hostBase(), dataDir());
}

/**
 * The Host this shell is talking to. What startup actually observed when there
 * is one, then what it asked for, then the documented port — a development
 * shell may have been sent elsewhere, and reporting the constant would send
 * the page to somebody else's Host.
 */
function hostBase(): string {
  const observed = lifecycle.observedHost()?.httpEndpoint;
  if (observed) return observed;
  return lifecycle.hostLaunchConfig()?.expectedHttpEndpoint ?? HOST_ENDPOINT;
}

/**
 * One native Host session ticket for the page (§4.4).
 *
 * The origin is the shell's own page origin, never one the page named, and
 * the Host is the instance startup verified. `armadra-host pair` itself stays
 * on this side of the bridge: the page gets a ticket, not the ability to pair.
 *
 * A refusal is RETURNED, not thrown. Electron serializes a rejected
 * `ipcMain.handle` to its message alone — `{ code, message }` would arrive as
 * prose the page has to parse — and "the Host is not up yet" is an answer the
 * page acts on, not a transport fault. The shape is the one AGENTS.md asks
 * for, carried in the result.
 */
async function nativeTicket(): Promise<NativeTicketAnswer> {
  const config = lifecycle.hostLaunchConfig();
  if (config === null)
    return { ok: false, error: ipcError("hostUnavailable", "no Host") };
  try {
    return {
      ok: true,
      ticket: await issueNativeTicket(
        config,
        lifecycle.observedHost(),
        deviceName(app.getLocale()),
      ),
    };
  } catch (thrown) {
    // Only the stable reason travels. Whatever the CLI wrote was already
    // dropped in `issueNativeTicket`; nothing here may add it back.
    const reason =
      thrown instanceof Error && "reason" in thrown
        ? String((thrown as { reason: unknown }).reason)
        : "cliFailed";
    return {
      ok: false,
      error: ipcError(reason, `no native session ticket (${reason})`),
    };
  }
}

/* ------------------------------- the quit path ---------------------------- */

let quitRequested = false;

async function requestQuit(): Promise<void> {
  if (!lifecycle.state.beginQuit()) return;
  quitRequested = true;
  const outcome = await runQuitSequence(lifecycle, runtime);
  if (!outcome.ok) {
    quitRequested = false;
    process.stderr.write(
      `Application shutdown incomplete: ${outcome.message}\n`,
    );
    revealWindow();
    const text = quitFailureDialog(outcome.message ?? "");
    dialog.showErrorBox(text.title, text.body);
    return;
  }
  markQuitting();
  // A global hotkey outlives the window but not the process, and the tray's
  // poll must not keep the loop alive past the last service stopping.
  releaseShortcuts();
  destroyTray();
  app.quit();
}

/* --------------------------------- startup -------------------------------- */

/**
 * The startup order, and why it is this order.
 *
 * 1. The page source first. Everything downstream is derived from its origin:
 *    the Host's `--allow-origin`, the CSP, and the ticket the page will spend.
 * 2. The Host, configured with that origin. It runs in the background — a
 *    shell whose Host is down still opens a window and says so.
 * 3. The Runtime, awaited when this shell owns it, because its port is
 *    kernel-assigned and the page cannot be loaded before the answer exists.
 * 4. The transport snapshot, then the window. The page reads its Runtime base
 *    synchronously at module load, so it must be published before the load.
 */
async function start(): Promise<void> {
  traceLifecycle("setup");
  // Where the managed binaries are is Electron's answer, not an environment
  // variable's: a double-clicked application inherits nobody's shell.
  setPackagedShell(app.isPackaged);
  registerIpc();

  // The drive channel binds BEFORE the Runtime is spawned, because its address
  // and one-time token only reach the Runtime through that spawn's environment.
  // A shell that cannot bind it opens anyway: browser nodes then answer
  // `browser_unavailable`, which is a named absence rather than a broken window.
  try {
    const wiring = await installBrowser(dataDir());
    setDriveEnvironment(wiring.driveAddress, wiring.driveToken);
    traceLifecycle("browser drive channel ready");
  } catch (error) {
    process.stderr.write(
      `Browser drive channel unavailable: ${error instanceof Error ? error.message : error}\n`,
    );
  }

  // The system integration (W2.1). All of it is installed before the window
  // exists: the intercept is a per-window hook, so registering it afterwards
  // would miss the first window, and the menu is process-wide.
  onWindowCreated(installKeydownIntercept);
  installApplicationMenu();
  createTray({
    runtimeBase: async () => (await transportEndpoints()).httpBase,
    quit: () => app.quit(),
  });

  page = await startPageSource(
    process.env.ELECTRON_RENDERER_URL,
    app.isPackaged,
    join(__dirname, "../renderer"),
    process.env.ARMADRA_DESKTOP_EXTERNAL_RENDERER === "1",
  );
  setPageUrl(page.url);
  // Only the Vite dev server serves inline scripts (the refresh preamble).
  applyContentSecurityPolicy(page.origin, {
    devServer: Boolean(process.env.ELECTRON_RENDERER_URL),
  });
  traceLifecycle(`page origin ${page.origin}`);

  // The Host's launch configuration is resolved even when the Host itself is
  // unavailable: a shell that cannot describe its Host is a configuration
  // error worth reporting, not a reason to refuse to open a window.
  //
  // `ARMADRA_CORE=ts` starts no Host at all: the TypeScript core absorbed the
  // Host's responsibilities, and a Host beside it would be a second writer of
  // one database — the arrangement the merge exists to remove.
  try {
    if (startsHost())
      lifecycle.configureHost({
        ...configFromEnvironment(development, page.origin, dataDir()),
        // Development also grants apps/web's own dev server, so the same Host
        // answers the shell's window and a browser tab on the same front end.
        // Neither can mint a ticket, which is what makes the grant cheap.
        additionalOrigins:
          development && page.origin !== DEFAULT_DEV_RENDERER_URL
            ? [DEFAULT_DEV_RENDERER_URL]
            : [],
      });
  } catch (error) {
    process.stderr.write(
      `Background ${error instanceof Error ? error.message : error}\n`,
    );
  }
  // Serialize startup with explicit quit, so a late startup cannot revive the
  // Host after the user requested all services to stop.
  void lifecycle.startHost().catch((error: unknown) => {
    process.stderr.write(
      `Background ${error instanceof Error ? error.message : error}\n`,
    );
  });

  if (ownsRuntime(development, process.env.ARMADRA_DESKTOP_OWNS_RUNTIME)) {
    const address = ownedRuntimeAddress();
    runtime.start(address);
    try {
      await waitForRuntime(runtime, address);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      // A Runtime that never became ours is not a degraded window, it is a
      // window whose every request will fail (用户实测反馈 F1 was read as
      // "install failed, 404"). Say so where the user is looking.
      dialog.showErrorBox("Armadra 后台未就绪", message);
    }
  }

  publishEndpoints(await transportEndpoints());
  void loadRenderer(createMainWindow());
}

// Must run before `app.whenReady()` resolves: Electron reads the process
// name for the Dock and the menu bar at ready time, so a call placed inside
// the callback below is already too late and the Dock keeps showing
// "Electron" for the rest of the run.
setApplicationName();

app.whenReady().then(() => {
  traceLifecycle("ready");
  // Development only — a packaged build's Dock icon and About panel icon
  // come from electron-builder's `mac.icon`, already inside the bundle;
  // `build/icons/` itself is not.
  if (development) {
    setDockIcon();
    setAboutPanel(iconPath());
  } else {
    setAboutPanel();
  }
  void start();
  traceLifecycle("enter event loop");

  // macOS: the dock icon reopens the window the close button only hid.
  app.on("activate", () => {
    traceLifecycle("reopen");
    revealWindow();
  });
});

app.on("before-quit", (event) => {
  if (lifecycle.state.canExit()) {
    traceLifecycle("exit");
    return;
  }
  traceLifecycle("exit requested; stopping services");
  // Nothing exits until the Host and the Runtime have both confirmed.
  event.preventDefault();
  if (!quitRequested) void requestQuit();
});

// Closing the last window is not quitting on any platform here: the Runtime,
// the Host and the user's terminals keep running, and the dock icon (macOS) or
// the tray (W2.1) brings the window back.
app.on("window-all-closed", () => {});

app.on("quit", () => {
  traceLifecycle("event loop returned");
});
