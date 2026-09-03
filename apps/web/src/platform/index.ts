/**
 * Desktop capabilities with a browser fallback (plan §5).
 *
 * Every function below is written as `isTauri() ? <desktop branch> : <web
 * fallback>`. The desktop branches are lazily imported so a plain `vite dev`
 * build never pulls the Tauri IPC modules into the initial chunk.
 */

type TauriGlobals = {
  __TAURI_INTERNALS__?: unknown;
};

export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  return (window as Window & TauriGlobals).__TAURI_INTERNALS__ !== undefined;
}

/**
 * Opens the system folder picker. Resolves to `null` when the user cancels —
 * and always on the web, where no picker exists (callers fall back to the
 * manual path field of the New Workspace modal).
 */
export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false });
    // `multiple: false` narrows to `string | null`, but the union type keeps
    // the array arm; collapse it defensively.
    if (Array.isArray(picked)) return picked[0] ?? null;
    return typeof picked === "string" ? picked : null;
  } catch (cause) {
    console.error("pickDirectory failed", cause);
    return null;
  }
}

/** Opens a URL outside the app window. */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch (cause) {
    console.error("openExternal failed", cause);
  }
}

export type FileDropPosition = { x: number; y: number };
export type FileDropHandler = (
  paths: string[],
  position: FileDropPosition,
) => void;

/**
 * Subscribes to OS-level file drops onto the window. Returns the unsubscribe
 * function; on the web this is a no-op because the browser only exposes
 * `DataTransfer` drops, which the canvas handles itself (B2).
 *
 * Positions are physical device pixels in Tauri; they are converted to CSS
 * pixels here so callers can feed them straight into `elementFromPoint` /
 * `screenToFlowPosition`.
 */
export function onFileDrop(callback: FileDropHandler): () => void {
  if (!isTauri()) return () => undefined;
  let unlisten: (() => void) | null = null;
  let cancelled = false;

  void (async () => {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths ?? [];
        if (paths.length === 0) return;
        const ratio = window.devicePixelRatio || 1;
        const position = event.payload.position;
        callback(paths, {
          x: position.x / ratio,
          y: position.y / ratio,
        });
      });
      if (cancelled) stop();
      else unlisten = stop;
    } catch (cause) {
      console.error("onFileDrop failed", cause);
    }
  })();

  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = null;
  };
}

/* ------------------------------- 系统通知 -------------------------------- */

export interface NotifyOptions {
  /** 点击通知时的回调（浏览器分支才有；Tauri 只把窗口拉到前面）。 */
  onClick?: () => void;
}

/** 浏览器分支只问一次权限；被拒绝之后不再骚扰。 */
let webPermission: NotificationPermission | null = null;

async function ensureWebPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (webPermission === null) webPermission = Notification.permission;
  if (webPermission === "granted") return true;
  if (webPermission === "denied") return false;
  try {
    webPermission = await Notification.requestPermission();
  } catch {
    webPermission = "denied";
  }
  return webPermission === "granted";
}

/**
 * 发一条系统通知（§5.4）。桌面端走 Tauri 的 notification 插件，
 * 浏览器走 `Notification`（首次会问权限）。任何一步失败都静默返回：
 * 通知是锦上添花，不能让状态流因为它抛异常。
 */
export async function notify(
  title: string,
  body: string,
  options: NotifyOptions = {},
): Promise<void> {
  if (isTauri()) {
    try {
      const plugin = await import("@tauri-apps/plugin-notification");
      const granted =
        (await plugin.isPermissionGranted()) ||
        (await plugin.requestPermission()) === "granted";
      if (!granted) return;
      plugin.sendNotification({ title, body });
    } catch (cause) {
      console.error("notify failed", cause);
    }
    return;
  }

  if (!(await ensureWebPermission())) return;
  try {
    const notification = new Notification(title, { body });
    notification.onclick = () => {
      window.focus();
      options.onClick?.();
      notification.close();
    };
  } catch (cause) {
    console.error("notify failed", cause);
  }
}

/** 测试用：忘掉已经问过的浏览器权限。 */
export function resetNotifyPermission(): void {
  webPermission = null;
}
