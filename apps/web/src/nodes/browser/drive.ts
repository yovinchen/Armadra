import * as React from "react";
import type { BrowserLease } from "@armadra/shared";

/**
 * 页面这一侧的 `browser:drive`（W3.4）。
 *
 * 这条通道**不是**驱动本身。驱动在主进程：`armadra-hook browser <verb>` →
 * Runtime（授权三规则 + 租约）→ 窄 WS → 主进程 → CDP 白名单 → guest。到这里
 * 的只有两类「只有页面能做的事」：
 *
 * - 标签。一个标签就是一个页面挂载的 `<webview>`，主进程没法替它挂载，只能
 *   请求；请求落没落地由动词自己重测的标签表说了算，不靠回执。
 * - 租约徽标。它是一个组件。
 *
 * 以及一个反方向的动作：Stop。它**必须**一路走到 Runtime 的租约状态机——只把
 * 徽标藏起来是 Critical 级 bug，因为那会留下一个仍然 attach 着的 debugger 和
 * 一个用户以为已经收回的页面。
 */

export interface DriveCommand {
  kind: "tabs" | "lease" | "popup" | "key" | "download";
  nodeId: string;
  action?: string;
  tabId?: string;
  url?: string;
  lease?: unknown;
  [field: string]: unknown;
}

function bridge() {
  return typeof window === "undefined" ? undefined : window.armadra?.browser;
}

/** 壳有没有把浏览器这一域挂上来。没有就一律不做。 */
export function hasBrowserBridge(): boolean {
  return bridge() !== undefined;
}

export interface DriveHandlers {
  /** 切到某个标签。 */
  onSwitchTab(tabId: string): void;
  /** 新开一个标签（`tabs --new`，或页面弹窗被拒后改成的标签）。 */
  onOpenTab(url: string): void;
  /** 关掉某个标签。 */
  onCloseTab(tabId: string): void;
  /**
   * guest 里按下的一个属于 Armadra 的和弦（`./keys`）。
   *
   * 走这条通道是因为它没有别的路可走：guest 是另一个渲染进程，宿主页面那个
   * 捕获阶段的 `keydown` 监听器压根不会为它运行。
   */
  onKey?(chord: unknown): void;
  /** 人自己点下来的一个下载，已经存好了。 */
  onDownload?(notice: unknown): void;
}

/**
 * 订阅这个节点的驱动命令，并把租约状态回给调用方。
 *
 * 命令按 `nodeId` 过滤：一条广播到整个窗口的通道上，别的节点的标签切换不该
 * 动这个节点。
 */
export function useDrive(
  nodeId: string,
  handlers: DriveHandlers,
): BrowserLease | undefined {
  const [lease, setLease] = React.useState<BrowserLease | undefined>();
  const handlersRef = React.useRef(handlers);
  handlersRef.current = handlers;

  React.useEffect(() => {
    const browser = bridge();
    if (!browser) return;
    return browser.onDrive((command) => {
      if (command.nodeId !== nodeId) return;
      switch (command.kind) {
        case "lease":
          setLease((command.lease as BrowserLease | undefined) ?? undefined);
          return;
        case "popup":
          if (command.url) handlersRef.current.onOpenTab(command.url);
          return;
        case "key":
          handlersRef.current.onKey?.(command);
          return;
        case "download":
          handlersRef.current.onDownload?.(command);
          return;
        case "tabs":
          if (command.action === "switch" && command.tabId) {
            handlersRef.current.onSwitchTab(command.tabId);
          } else if (command.action === "new" && command.url) {
            handlersRef.current.onOpenTab(command.url);
          } else if (command.action === "close" && command.tabId) {
            handlersRef.current.onCloseTab(command.tabId);
          }
          return;
        default:
      }
    });
  }, [nodeId]);

  return lease;
}

/** Stop / 交还。两者都走到 Runtime，没有只改本地状态的分支。 */
export async function control(
  nodeId: string,
  action: "takeover" | "release",
): Promise<boolean> {
  const browser = bridge();
  if (!browser) return false;
  const answer = await browser.control({ nodeId, action });
  return answer.ok;
}

/**
 * 注册一个 guest。返回注销函数。
 *
 * `webContentsId` 是页面自己报的，主进程**不信**：它会核对那个 id 真的是一个
 * `<webview>`（`main/browser/registry.ts`）。没有那道核对，这个调用就是「把
 * debugger attach 到渲染进程说的任何东西上」。
 */
export function registerGuest(
  registration: ArmadraBrowserRegistration,
): () => void {
  const browser = bridge();
  if (!browser) return () => {};
  void browser.register(registration);
  return () => void browser.unregister(registration.webContentsId);
}

/** 几何。只有页面知道 React Flow 把元素放在哪、缩放是多少。 */
export function reportView(view: ArmadraBrowserView): void {
  void bridge()?.view(view);
}

/** 有活租约时，回收要被抑制：回收会销毁目标，ref 全部静默失效。 */
export function isDriven(lease: BrowserLease | undefined): boolean {
  return lease?.state === "agent";
}
