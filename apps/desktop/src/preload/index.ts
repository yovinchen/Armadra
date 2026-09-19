import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  DESKTOP_DOCUMENT_ATTRIBUTE,
  IPC,
  type BrowserControl,
  type BrowserDriveCommand,
  type BrowserRegistration,
  type BrowserView,
  type PickOptions,
  type ShortcutBinding,
  type ShortcutOutcome,
  type NativeTicketAnswer,
  type TransportEndpoints,
} from "../shared/ipc";

/**
 * The only bridge between the page and the shell. `contextIsolation: true` and
 * `nodeIntegration: false` mean the renderer has no `require`, no `process`
 * and no Electron of its own; everything it may do is on the object below,
 * and that object is exactly the table in `src/shared/ipc.ts`.
 */

/**
 * Fan a single `ipcRenderer` listener per channel out to many page
 * subscribers. Without this, every node that subscribes adds its own
 * `ipcRenderer` listener and Node's MaxListeners warning (>10) fires as soon
 * as a board has eleven of anything. Returns an unsubscribe.
 */
function subscribe<A extends unknown[]>(channel: string) {
  const listeners = new Set<(...args: A) => void>();
  let handler: ((event: unknown, ...args: A) => void) | null = null;
  return (listener: (...args: A) => void): (() => void) => {
    if (!handler) {
      handler = (_event, ...args) => listeners.forEach((each) => each(...args));
      ipcRenderer.on(channel, handler);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && handler) {
        ipcRenderer.removeListener(channel, handler);
        handler = null;
      }
    };
  };
}

const onUpdatesProgress = subscribe<[unknown]>(IPC.updatesProgress.channel);
const onShortcutTriggered = subscribe<[string]>(IPC.shortcutsTriggered.channel);
const onBrowserDrive = subscribe<[BrowserDriveCommand]>(
  IPC.browserDrive.channel,
);
const onKeyIntent = subscribe<[string, string]>(IPC.windowKeyIntent.channel);
const onNotificationClick = subscribe<[{ nodeId: string }]>(
  IPC.windowNotificationClick.channel,
);

export interface ArmadraDesktopApi {
  readonly transport: {
    endpoints(): Promise<TransportEndpoints>;
    /**
     * The same answer, before the page's first `await`.
     *
     * `apps/web/src/api/request.ts` resolves the Runtime base while its module
     * is evaluating, which no promise can serve. The main process publishes a
     * snapshot before the window loads, so this never blocks on work — it
     * reads a value that is already decided.
     */
    endpointsSync(): TransportEndpoints;
  };
  /** One native Host session ticket. Pairing itself stays in the shell. */
  readonly identity: {
    ticket(): Promise<NativeTicketAnswer>;
  };
  readonly app: {
    locale(): Promise<string>;
  };
  readonly window: {
    isFocused(): Promise<boolean>;
    /**
     * A chord the main process claimed back from the application menu
     * (`shell-core/keydown-intercept.ts`), with the token its answer must
     * carry. The page is expected to call `resolveKeyIntent`; if it does not,
     * the shell performs its own half after a short wait.
     */
    onKeyIntent(listener: (intent: string, token: string) => void): () => void;
    /** Whether the page acted on a claimed chord. */
    resolveKeyIntent(token: string, handled: boolean): Promise<{ ok: boolean }>;
    /** A main-process notification was clicked; the page selects the node. */
    onNotificationClick(
      listener: (event: { nodeId: string }) => void,
    ): () => void;
  };
  readonly dialog: {
    pickDirectory(options?: PickOptions): Promise<string[]>;
    pickFiles(options?: PickOptions): Promise<string[]>;
  };
  readonly shell: {
    openExternal(url: string): Promise<void>;
    /**
     * Opens a file manager window on `path`. Refused with `path_not_allowed`
     * unless the path is inside the data or downloads directory — the page
     * names the path, so the main process decides which ones exist for it.
     */
    showItemInFolder(path: string): Promise<{ ok: boolean }>;
  };
  readonly updates: {
    state(): Promise<unknown>;
    /**
     * The Host's answer, handed over verbatim. The page already holds the
     * authenticated session that asked; the shell does not speak the Host
     * protocol, and treats what arrives as untrusted input regardless.
     */
    check(verdict: unknown): Promise<unknown>;
    dismiss(): Promise<unknown>;
    cancel(): Promise<unknown>;
    download(): Promise<unknown>;
    install(): Promise<unknown>;
    restartReport(): Promise<unknown>;
    onProgress(listener: (progress: unknown) => void): () => void;
  };
  readonly shortcuts: {
    apply(bindings: readonly ShortcutBinding[]): Promise<ShortcutOutcome[]>;
    onTriggered(listener: (id: string) => void): () => void;
  };
  /**
   * Browser nodes (W3.3 / W3.4).
   *
   * `register` hands the shell a `webContentsId` it then validates — the page
   * can name any number, and the main process checks that it is really a
   * `<webview>` before anything attaches a debugger to it. `view` carries only
   * geometry. `control` is the lease badge's Stop, which travels on to the
   * Runtime's lease machine rather than stopping at a component's state.
   */
  readonly browser: {
    register(
      registration: BrowserRegistration,
    ): Promise<{ ok: boolean; reason?: string }>;
    unregister(webContentsId: number): Promise<{ ok: boolean }>;
    view(view: BrowserView): Promise<{ ok: boolean }>;
    control(control: BrowserControl): Promise<{ ok: boolean }>;
    onDrive(listener: (command: BrowserDriveCommand) => void): () => void;
  };
  /**
   * The absolute path of a dropped or picked `File`. The page hands the path
   * to the Runtime, which is the process allowed to read it; the bytes never
   * travel through the renderer. Replaces the Rust shell's drag-drop event, and is
   * why the window is not sandboxed.
   */
  readonly pathForFile: (file: File) => string;
}

const api: ArmadraDesktopApi = {
  transport: {
    endpoints: () => ipcRenderer.invoke(IPC.transportEndpoints.channel),
    endpointsSync: () => ipcRenderer.sendSync(IPC.transportEndpoints.channel),
  },
  identity: {
    ticket: () => ipcRenderer.invoke(IPC.identityTicket.channel),
  },
  app: {
    locale: () => ipcRenderer.invoke(IPC.appLocale.channel),
  },
  window: {
    isFocused: () => ipcRenderer.invoke(IPC.windowIsFocused.channel),
    onKeyIntent: (listener) => onKeyIntent(listener),
    resolveKeyIntent: (token, handled) =>
      ipcRenderer.invoke(IPC.windowKeyIntentResult.channel, { token, handled }),
    onNotificationClick: (listener) => onNotificationClick(listener),
  },
  dialog: {
    pickDirectory: (options) =>
      ipcRenderer.invoke(IPC.dialogPickDirectory.channel, options),
    pickFiles: (options) =>
      ipcRenderer.invoke(IPC.dialogPickFiles.channel, options),
  },
  shell: {
    openExternal: (url) =>
      ipcRenderer.invoke(IPC.shellOpenExternal.channel, url),
    showItemInFolder: (path) =>
      ipcRenderer.invoke(IPC.shellShowItemInFolder.channel, path),
  },
  updates: {
    state: () => ipcRenderer.invoke(IPC.updatesState.channel),
    check: (verdict) => ipcRenderer.invoke(IPC.updatesCheck.channel, verdict),
    dismiss: () => ipcRenderer.invoke(IPC.updatesDismiss.channel),
    cancel: () => ipcRenderer.invoke(IPC.updatesCancel.channel),
    download: () => ipcRenderer.invoke(IPC.updatesDownload.channel),
    install: () => ipcRenderer.invoke(IPC.updatesInstall.channel),
    restartReport: () => ipcRenderer.invoke(IPC.updatesRestartReport.channel),
    onProgress: (listener) => onUpdatesProgress(listener),
  },
  shortcuts: {
    apply: (bindings) =>
      ipcRenderer.invoke(IPC.shortcutsApply.channel, bindings),
    onTriggered: (listener) => onShortcutTriggered(listener),
  },
  browser: {
    register: (registration) =>
      ipcRenderer.invoke(IPC.browserRegister.channel, registration),
    unregister: (webContentsId) =>
      ipcRenderer.invoke(IPC.browserUnregister.channel, webContentsId),
    view: (view) => ipcRenderer.invoke(IPC.browserView.channel, view),
    control: (control) =>
      ipcRenderer.invoke(IPC.browserControl.channel, control),
    onDrive: (listener) => onBrowserDrive(listener),
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld("armadra", api);

/**
 * Mark the document as desktop-hosted, synchronously and before any of the
 * page's own scripts run. `apps/web/src/styles/tokens.css` keys its
 * window-chrome rules off this attribute, and a browser never sees it — which
 * is what lets one stylesheet serve the shell and the web build both.
 */
function markDesktopDocument(): void {
  document.documentElement?.setAttribute(DESKTOP_DOCUMENT_ATTRIBUTE, "");
}

markDesktopDocument();
// A preload can run before `documentElement` exists; the second call is the
// one that lands then, and setting an attribute twice is free.
document.addEventListener("DOMContentLoaded", markDesktopDocument);
