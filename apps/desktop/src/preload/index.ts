import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  DESKTOP_DOCUMENT_ATTRIBUTE,
  IPC,
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
const onBrowserDrive = subscribe<[unknown]>(IPC.browserDrive.channel);

export interface ArmadraDesktopApi {
  readonly transport: {
    endpoints(): Promise<TransportEndpoints>;
  };
  readonly app: {
    locale(): Promise<string>;
  };
  readonly window: {
    isFocused(): Promise<boolean>;
  };
  readonly dialog: {
    pickDirectory(options?: unknown): Promise<string[]>;
    pickFiles(options?: unknown): Promise<string[]>;
  };
  readonly shell: {
    openExternal(url: string): Promise<void>;
  };
  readonly updates: {
    state(): Promise<unknown>;
    check(): Promise<unknown>;
    dismiss(): Promise<unknown>;
    cancel(): Promise<unknown>;
    download(): Promise<unknown>;
    install(): Promise<unknown>;
    restartReport(): Promise<unknown>;
    onProgress(listener: (progress: unknown) => void): () => void;
  };
  readonly shortcuts: {
    apply(bindings: unknown): Promise<unknown>;
    onTriggered(listener: (id: string) => void): () => void;
  };
  readonly browser: {
    register(registration: unknown): Promise<unknown>;
    unregister(nodeId: string): Promise<unknown>;
    onDrive(listener: (command: unknown) => void): () => void;
  };
  /**
   * The absolute path of a dropped or picked `File`. The page hands the path
   * to the Runtime, which is the process allowed to read it; the bytes never
   * travel through the renderer. Replaces the Tauri drag-drop event, and is
   * why the window is not sandboxed.
   */
  readonly pathForFile: (file: File) => string;
}

const api: ArmadraDesktopApi = {
  transport: {
    endpoints: () => ipcRenderer.invoke(IPC.transportEndpoints.channel),
  },
  app: {
    locale: () => ipcRenderer.invoke(IPC.appLocale.channel),
  },
  window: {
    isFocused: () => ipcRenderer.invoke(IPC.windowIsFocused.channel),
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
  },
  updates: {
    state: () => ipcRenderer.invoke(IPC.updatesState.channel),
    check: () => ipcRenderer.invoke(IPC.updatesCheck.channel),
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
    unregister: (nodeId) =>
      ipcRenderer.invoke(IPC.browserUnregister.channel, nodeId),
    onDrive: (listener) => onBrowserDrive(listener),
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld("armadra", api);

/**
 * Mark the document as desktop-hosted, synchronously and before any of the
 * page's own scripts run. This replaces the Tauri shell's `data-tauri`
 * attribute (`src-tauri/src/main.rs:53-55`), which `apps/web/src/styles/tokens.css`
 * keys its window-chrome rules off. W1.0 only adds the new attribute; the
 * front end still reads `data-tauri` until W2.1 switches it over.
 */
function markDesktopDocument(): void {
  document.documentElement?.setAttribute(DESKTOP_DOCUMENT_ATTRIBUTE, "");
}

markDesktopDocument();
// A preload can run before `documentElement` exists; the second call is the
// one that lands then, and setting an attribute twice is free.
document.addEventListener("DOMContentLoaded", markDesktopDocument);
