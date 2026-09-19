/**
 * Desktop capabilities with a browser fallback (plan §5).
 *
 * Every function below is written as `isDesktop() ? <desktop branch> : <web
 * fallback>`, and the desktop branch itself forks once more: the Electron
 * shell answers on `window.armadra` (迁移设计 §2.2 的那张表), while the Tauri
 * shell still answers through `@tauri-apps/*`. Both are live — the Tauri shell
 * is kept until W5 — so a capability that works in one and not the other is a
 * regression, not a migration step.
 *
 * The Tauri branches stay lazily imported so a plain `vite dev` build never
 * pulls the Tauri IPC modules into the initial chunk; the Electron branch
 * needs no import at all, because the preload put everything on `window`.
 */

type TauriGlobals = {
  __TAURI_INTERNALS__?: unknown;
};

/** The Electron bridge, or `undefined` outside that shell. */
function bridge(): Window["armadra"] {
  return typeof window === "undefined" ? undefined : window.armadra;
}

function isTauriShell(): boolean {
  if (typeof window === "undefined") return false;
  return (window as Window & TauriGlobals).__TAURI_INTERNALS__ !== undefined;
}

/**
 * 在**某个**桌面壳里（Electron 或 Tauri）。
 *
 * 两个壳同时存在的这段时间里，调用处关心的几乎总是「有没有壳」，而不是
 * 「是哪一个壳」——能不能弹系统选择器、要不要画拖拽区、`global` 作用域的
 * 热键页要不要显示。哪个壳的分支由本文件各个能力自己决定。
 */
export function isDesktop(): boolean {
  return bridge() !== undefined || isTauriShell();
}

/**
 * @deprecated 用 `isDesktop()`。名字留在这里只是为了那些还没读到这一行的
 * 代码；它从 W2.1 起对 Electron 壳也返回 true，所以名字已经在说谎了。
 */
export const isTauri = isDesktop;

/**
 * Opens the system folder picker. Resolves to `null` when the user cancels —
 * and always on the web, where no picker exists (callers fall back to the
 * manual path field of the New folder dialog).
 *
 * `canCreateDirectories` is macOS-only and on by default, but it is spelled out
 * here because the New folder flow leans on it: the panel's own "New Folder"
 * button is how the user creates the directory they are about to open.
 */
export async function pickDirectory(): Promise<string | null> {
  const shell = bridge();
  if (shell) {
    try {
      return (await shell.dialog.pickDirectory())[0] ?? null;
    } catch (cause) {
      console.error("pickDirectory failed", cause);
      return null;
    }
  }
  if (!isTauriShell()) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      canCreateDirectories: true,
    });
    // `multiple: false` narrows to `string | null`, but the union type keeps
    // the array arm; collapse it defensively.
    if (Array.isArray(picked)) return picked[0] ?? null;
    return typeof picked === "string" ? picked : null;
  } catch (cause) {
    console.error("pickDirectory failed", cause);
    return null;
  }
}

/**
 * Opens the system file picker. Resolves to the absolute paths that were
 * chosen, or an empty list when the user cancels — and always on the web,
 * where callers fall back to an `<input type="file">`.
 *
 * Paths rather than bytes, on purpose. The caller that needs this is the
 * controlled browser's file chooser, and what the Runtime accepts there is a
 * workspace-relative path it resolves on the execution host itself (browser
 * completion design §2.3); handing it bytes would mean writing a copy into
 * the project before the page could see the file.
 */
export async function pickFiles(options: {
  multiple: boolean;
  defaultPath?: string;
}): Promise<string[]> {
  const shell = bridge();
  if (shell) {
    try {
      return await shell.dialog.pickFiles(options);
    } catch (cause) {
      console.error("pickFiles failed", cause);
      return [];
    }
  }
  if (!isTauriShell()) return [];
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: options.multiple,
      ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
    });
    if (Array.isArray(picked)) return picked;
    return typeof picked === "string" ? [picked] : [];
  } catch (cause) {
    console.error("pickFiles failed", cause);
    return [];
  }
}

/** Opens a URL outside the app window. */
export async function openExternal(url: string): Promise<void> {
  const shell = bridge();
  if (shell) {
    try {
      await shell.shell.openExternal(url);
    } catch (cause) {
      // 壳按 scheme 白名单拒绝时也走这里（`scheme_not_allowed`）。不回退到
      // `window.open`：那会把壳刚拦下来的东西交给 webview 再试一次。
      console.error("openExternal failed", cause);
    }
    return;
  }
  if (!isTauriShell()) {
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
 * 两个壳的机制完全不同，落点坐标的口径也不同：
 *
 * - **Electron**：拖放就是普通的 DOM `drop` 事件，`event.clientX/Y` 已经是
 *   CSS 像素，绝对路径由 `webUtils.getPathForFile(file)` 取（preload 暴露成
 *   `window.armadra.pathForFile`）。**不做物理像素换算**——这里没有那一步。
 * - **Tauri**：webview 收不到 `DataTransfer`，壳用自己的事件给路径，坐标是
 *   物理设备像素，所以要按 `devicePixelRatio` 换回 CSS 像素。
 */
export function onFileDrop(callback: FileDropHandler): () => void {
  const shell = bridge();
  if (shell) {
    const onDrop = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      const paths = files
        .map((file) => {
          try {
            return shell.pathForFile(file);
          } catch {
            return "";
          }
        })
        // 一个拿不到路径的 File（比如浏览器节点里生成的 Blob）不是这条路要
        // 处理的东西，交给画布自己的 `DataTransfer` 分支。
        .filter((path) => path !== "");
      if (paths.length === 0) return;
      event.preventDefault();
      callback(paths, { x: event.clientX, y: event.clientY });
    };
    // `dragover` 必须 preventDefault，否则 `drop` 根本不会触发。
    const onDragOver = (event: DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files"))
        event.preventDefault();
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }

  if (!isTauriShell()) return () => undefined;
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
  /** 点击通知时的回调。 */
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
 * 发一条系统通知（§5.4）。
 *
 * **一条路，不分壳**：`Notification` 在打包的 Electron 渲染进程里和在浏览器
 * 里是同一个 API，所以壳专用分支被删掉了（盘点第 23 项）。留着它的代价不是
 * 多几行——Tauri 那条路的点击回调落在壳里，页面这边的 `onClick` 会静默失效，
 * 于是「点通知跳到那个节点」在桌面端从来没生效过。
 *
 * 主进程自己也能发通知（`apps/desktop/src/main/notifications.ts`），那是给
 * 页面根本没在跑的时候用的（更新流程），和这里不是一回事。
 *
 * 任何一步失败都静默返回：通知是锦上添花，不能让状态流因为它抛异常。
 */
export async function notify(
  title: string,
  body: string,
  options: NotifyOptions = {},
): Promise<void> {
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
