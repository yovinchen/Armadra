import { app, dialog, ipcMain } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ALL_CHANNELS,
  IMPLEMENTED_CHANNELS,
  IPC,
  NOT_IMPLEMENTED,
  type TransportEndpoints,
  ipcError,
} from "../shared/ipc";
import { dataDir } from "../shell-core/paths";
import { HOST_ENDPOINT, configFromEnvironment } from "./host";
import {
  DesktopLifecycle,
  quitFailureDialog,
  runQuitSequence,
} from "./lifecycle";
import {
  RuntimeProcess,
  externalRuntimeBase,
  ownedRuntimeAddress,
  waitForRuntime,
} from "./runtime-process";
import { traceLifecycle } from "./trace";
import {
  createMainWindow,
  getMainWindow,
  loadRenderer,
  markQuitting,
  revealWindow,
} from "./window";
import {
  ownsRuntime,
  publishedRuntimeBases,
} from "../shell-core/runtime/identity";

/**
 * The application's assembly. Everything with a rule worth stating lives in
 * `shell-core/` (pure) or in a named module beside this one; this file is the
 * Electron plumbing around them, the same division `src-tauri/src/lib.rs:1-7`
 * drew between `lib.rs` and `main.rs`.
 */

const lifecycle = new DesktopLifecycle();
const runtime = new RuntimeProcess();
const development = !app.isPackaged;

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
    [IPC.appLocale.channel]: () => app.getLocale(),
    [IPC.windowIsFocused.channel]: () => getMainWindow()?.isFocused() ?? false,
  };
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
      throw Object.assign(
        new Error(`${spec.channel} is not implemented yet`),
        ipcError(NOT_IMPLEMENTED, `${spec.channel} is not implemented yet`),
      );
    });
  }
}

/**
 * Where the page should send its traffic.
 *
 * In W1.1 the shell has not taken over the page's transport yet: the Runtime
 * it owns still listens on a Unix socket, so the address returned here is the
 * EXTERNAL Runtime's — the one `armadra.sh` or `cargo run` put on a loopback
 * port, read from `endpoints.json` where available. W1.2 is where the shell
 * serves the page itself and these become its own bases.
 */
async function transportEndpoints(): Promise<TransportEndpoints> {
  const directory = dataDir();
  const published = await readPublishedBases(directory);
  // The documented default port is the fallback, not a guess dressed up as an
  // answer: without `endpoints.json` there is nothing else the page could try.
  const fallback = externalRuntimeBase();
  return {
    httpBase: published?.http ?? fallback,
    wsBase: published?.websocket ?? fallback.replace(/^http/, "ws"),
    hostBase: HOST_ENDPOINT,
    dataDir: directory,
  };
}

async function readPublishedBases(
  directory: string,
): Promise<{ http: string; websocket: string } | undefined> {
  try {
    return publishedRuntimeBases(
      await readFile(join(directory, "endpoints.json"), "utf8"),
    );
  } catch {
    return undefined;
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
  app.quit();
}

/* --------------------------------- startup -------------------------------- */

async function start(): Promise<void> {
  traceLifecycle("setup");
  registerIpc();

  const window = createMainWindow();
  void loadRenderer(window);

  // The Host's launch configuration is resolved even when the Host itself is
  // unavailable: a shell that cannot describe its Host is a configuration
  // error worth reporting, not a reason to refuse to open a window.
  try {
    const origin = development ? "http://127.0.0.1:1420" : "tauri://localhost";
    lifecycle.configureHost(
      configFromEnvironment(development, origin, dataDir()),
    );
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
}

app.whenReady().then(() => {
  traceLifecycle("ready");
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
