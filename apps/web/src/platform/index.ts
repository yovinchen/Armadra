/**
 * Desktop capabilities with a browser fallback (plan §5).
 *
 * Every function below is written as `isDesktop() ? <desktop branch> : <web
 * fallback>`. The desktop branch needs no import at all: the preload put the
 * whole IPC surface (迁移设计 §2.2 的那张表) on `window.armadra`, so a plain
 * `vite dev` build carries nothing shell-specific.
 */

/** The Electron bridge, or `undefined` outside that shell. */
function bridge(): Window["armadra"] {
  return typeof window === "undefined" ? undefined : window.armadra;
}

/**
 * 在桌面壳里。
 *
 * 调用处关心的是「有没有壳」——能不能弹系统选择器、要不要画拖拽区、
 * `global` 作用域的热键页要不要显示。
 */
export function isDesktop(): boolean {
  return bridge() !== undefined;
}

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
  return null;
}

/**
 * 在应用窗口之外打开一个 URL。返回**是否真的打开了**。
 *
 * 失败不再只写 `console.error` 就算了：壳按 scheme 白名单拒绝
 *（`scheme_not_allowed`）时，用户看到的是一个点了没反应的链接，而调用处
 * 只要拿得到 `false` 就能弹一条提示。仍然**不**回退到 `window.open`——
 * 那会把壳刚拦下来的东西交给 webview 再试一次。
 */
export async function openExternal(url: string): Promise<boolean> {
  const shell = bridge();
  if (shell) {
    try {
      await shell.shell.openExternal(url);
      return true;
    } catch (cause) {
      console.error("openExternal failed", cause);
      return false;
    }
  }
  return window.open(url, "_blank", "noopener") !== null;
}

/** `revealPath` 的三种结局，调用处按它选提示语。 */
export type RevealOutcome = "revealed" | "copied" | "failed";

/**
 * 在系统文件管理器里定位一个绝对路径（设置 → 数据的「显示数据目录」）。
 *
 * 壳里走 `shell:show-item-in-folder`，那条通道自己带根目录白名单；**不**走
 * `openExternal(file://…)`，因为那条路的 scheme 白名单只认 http/https，
 * 而为了这一个按钮去放宽它，等于给所有到 `openExternal` 的 URL 一起放宽。
 *
 * 浏览器里没有文件管理器可开，退而求其次：把路径复制到剪贴板，调用处照着
 * `"copied"` 说一句。剪贴板也用不了就是 `"failed"`。
 */
export async function revealPath(path: string): Promise<RevealOutcome> {
  const shell = bridge();
  if (shell) {
    try {
      await shell.shell.showItemInFolder(path);
      return "revealed";
    } catch (cause) {
      console.error("revealPath failed", cause);
      return "failed";
    }
  }
  try {
    await navigator.clipboard.writeText(path);
    return "copied";
  } catch (cause) {
    console.error("revealPath clipboard fallback failed", cause);
    return "failed";
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
 * 壳里拖放就是普通的 DOM `drop` 事件，`event.clientX/Y` 已经是 CSS 像素，
 * 绝对路径由 `webUtils.getPathForFile(file)` 取（preload 暴露成
 * `window.armadra.pathForFile`）。**不做物理像素换算**——这里没有那一步。
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

  return () => undefined;
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
 * 里是同一个 API，所以壳专用分支被删掉了（盘点第 23 项）。旧壳那条路的点击
 * 回调落在壳里，页面这边的 `onClick` 会静默失效，于是「点通知跳到那个节点」
 * 在桌面端从来没生效过。
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
  // 窗口就在眼前时不弹系统通知：该看的东西已经在屏幕上了。壳里问壳
  // （`window:is-focused`），因为无边框窗口里 `document.hasFocus()` 在
  // webview 抢走焦点时会说谎；浏览器里这一步不存在，照旧由调用处的
  // `document.hidden` 判断。
  const shell = bridge();
  if (shell) {
    try {
      if (await shell.window.isFocused()) return;
    } catch {
      // 问不到就当没问过：通知是锦上添花，不能因为它失败就不发。
    }
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
