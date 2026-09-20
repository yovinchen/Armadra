import * as React from "react";

import { useBrowserPreferences, useT } from "@/app/preferences-store";

import { DISCARD_TICK_MS, discardSettings, shouldDiscard } from "./discard";
import { registerGuest, reportView } from "./drive";
import type { WebviewElement, WebviewNavigationEvent } from "./webview";
import { allowGuestNavigation } from "./webview";
import type { WebviewTab } from "./webview-tabs";

/**
 * `getWebContentsId()` / `canGoBack()` **throw** until the element is attached
 * to the DOM and `dom-ready` has fired ("The WebView must be attached to the
 * DOM…"), and again once the guest instance is gone. StrictMode runs every
 * effect twice on mount, so the first run always lands in that window; an
 * uncaught throw there took the whole React tree down with it (empty `#root`,
 * no overlay). Every guest method call goes through here and answers
 * `undefined` instead.
 */
function guestCall<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function guestWebContentsId(guest: WebviewElement): number | undefined {
  if (typeof guest.getWebContentsId !== "function") return undefined;
  const id = guestCall(() => guest.getWebContentsId());
  return typeof id === "number" && id > 0 ? id : undefined;
}

/**
 * 一个标签 = 一个 guest（W3.1 / W3.2）。
 *
 * 这个组件**只渲染一个裸 `<webview>`**，没有遮罩、没有 hover-guard、没有缩
 * 放补偿。三样都不是遗漏：
 *
 * - 遮罩／hover-guard 是终端那边的取舍（悬停 600 ms 才交出输入），浏览器节点
 *   有意放弃它，网页需要立刻拿到指针（[浏览器节点] §2.2）；
 * - 缩放补偿不存在也不需要，命中测试在 Chromium 的 surface 层连同祖先
 *   transform 一起做，探针 20 + 25 次点击零偏差（webview-probe §1、§2）；
 * - `setZoomFactor` 更是明确禁止：它会改变页面的布局宽度，把一个不存在的问
 *   题换成一个真的问题（webview-probe 末节第 7 条）。
 *
 * 已知缺失，不要当 bug 查：**指针在页面上时 Cmd + 滚轮缩放画布失效**。guest
 * 的 wheel 事件根本不跨进程边界，宿主收到的是 0 个而不是 0 个有效的
 * （webview-probe §5），`nowheel` 在这里无事可做，宿主侧没有补救手段。
 */

export interface WebviewGuestProps {
  /** 这个 guest 属于哪个画布节点。主进程用它把动词路由到这里。 */
  nodeId: string;
  /** 画布缩放。只用来把右键菜单的宿主坐标换算回 guest 视口坐标。 */
  zoom: number;
  tab: WebviewTab;
  /** 创建时定一次、永不变更（探针 C）。 */
  partition: string;
  /** 不可见的 guest 留在 DOM 里，只是 `display:none`——卸载等于杀进程。 */
  hidden: boolean;
  /** ghost：属于另一个工作空间／被折叠掉的节点。不回写任何事实。 */
  ghost: boolean;
  /**
   * Agent 正在驱动（W3.4 接通）。回收在这时被抑制：回收会销毁目标，表单、
   * 滚动、登录后的 SPA 状态全丢，上一次 read 拿到的 ref 全部静默失效。
   */
  driven: boolean;
  /** 元素句柄回传：工具栏的后退/前进/刷新直接调 guest 的方法。 */
  onElement(element: WebviewElement | null): void;
  onPatch(change: Partial<Omit<WebviewTab, "id">>): void;
  /** 活动标签导航到了新地址：节点据此把 URL 持久化。ghost 不会调。 */
  onNavigate(url: string): void;
  /** 页面要开新窗口。W3.1 只把 http(s) 变成本节点的新标签。 */
  onOpenTab(url: string): void;
}

export function WebviewGuest({
  nodeId,
  zoom,
  tab,
  partition,
  hidden,
  ghost,
  driven,
  onElement,
  onPatch,
  onNavigate,
  onOpenTab,
}: WebviewGuestProps) {
  const t = useT();
  // 提示里那个分钟数要跟着设置走，所以这一项订阅；判定本身在定时器里重读。
  const discardMinutes = useBrowserPreferences().discardMinutes;
  const ref = React.useRef<WebviewElement | null>(null);
  /** 回收后重放用的地址。永远是 guest 真正停在的那一页。 */
  const locationRef = React.useRef(tab.src);
  /**
   * 重放那一次导航的回声。没有它，「看一眼被回收的节点」就会触发一次
   * `did-navigate` → 回写 → 文档变脏 → rev 自增 → 同步给别的设备，而页面其
   * 实一个字都没变。
   */
  const restoringRef = React.useRef(false);
  const [discarded, setDiscarded] = React.useState(false);

  const patchRef = React.useRef(onPatch);
  patchRef.current = onPatch;
  const navigateRef = React.useRef(onNavigate);
  navigateRef.current = onNavigate;
  const openTabRef = React.useRef(onOpenTab);
  openTabRef.current = onOpenTab;
  const ghostRef = React.useRef(ghost);
  ghostRef.current = ghost;

  /* ------------------------------ guest 事件 ----------------------------- */
  React.useEffect(() => {
    const guest = ref.current;
    if (!guest || discarded) return;

    /**
     * `did-stop-loading` 时刷新前进/后退（[浏览器节点] §2.4）。
     *
     * 「加载结束」与「能不能后退」是分开写的：前者必须无条件落下去，否则一
     * 个还没长出这两个方法的元素会让标签**永远停在 loading**——而 loading 是
     * 回收的一条否决，于是那个 guest 再也不会被释放。
     */
    const refreshNavState = () => {
      const current = ref.current;
      const canGoBack =
        current && typeof current.canGoBack === "function"
          ? guestCall(() => current.canGoBack())
          : undefined;
      const canGoForward =
        current && typeof current.canGoForward === "function"
          ? guestCall(() => current.canGoForward())
          : undefined;
      patchRef.current({
        loading: false,
        ...(canGoBack === undefined || canGoForward === undefined
          ? {}
          : { canGoBack, canGoForward }),
      });
    };

    /** `did-navigate` **只更新地址栏**，不碰 `src`——碰了就是自激循环。 */
    const onDidNavigate = (event: Event) => {
      const url = (event as WebviewNavigationEvent).url ?? "";
      if (!url) return;
      locationRef.current = url;
      patchRef.current({ address: url });
      if (restoringRef.current) {
        restoringRef.current = false;
        return;
      }
      if (!ghostRef.current) navigateRef.current(url);
    };

    const onStartLoading = () => patchRef.current({ loading: true });
    const onStopLoading = () => refreshNavState();
    const onTitle = (event: Event) =>
      patchRef.current({
        title: (event as WebviewNavigationEvent).title ?? "",
      });
    const onFavicon = (event: Event) =>
      patchRef.current({
        favicon: (event as WebviewNavigationEvent).favicons?.[0] ?? "",
      });
    const onAudible = () => patchRef.current({ audible: true });
    const onQuiet = () => patchRef.current({ audible: false });

    /**
     * 渲染侧的两道门。真正的强制点在主进程（guest 的 `will-navigate` 与
     * `setWindowOpenHandler`），那一侧属于 W3.3；这一道先拦下 renderer 能看见
     * 的顶层导航与 `new-window`。
     */
    const onWillNavigate = (event: Event) => {
      const url = (event as WebviewNavigationEvent).url ?? "";
      if (allowGuestNavigation(url)) return;
      event.preventDefault();
    };
    const onNewWindow = (event: Event) => {
      event.preventDefault();
      const url = (event as WebviewNavigationEvent).url ?? "";
      if (!ghostRef.current && allowGuestNavigation(url)) {
        openTabRef.current(url);
      }
    };

    guest.addEventListener("did-navigate", onDidNavigate);
    guest.addEventListener("did-navigate-in-page", onDidNavigate);
    guest.addEventListener("did-start-loading", onStartLoading);
    guest.addEventListener("did-stop-loading", onStopLoading);
    guest.addEventListener("dom-ready", onStopLoading);
    guest.addEventListener("page-title-updated", onTitle);
    guest.addEventListener("page-favicon-updated", onFavicon);
    guest.addEventListener("media-started-playing", onAudible);
    guest.addEventListener("media-paused", onQuiet);
    guest.addEventListener("will-navigate", onWillNavigate);
    guest.addEventListener("new-window", onNewWindow);
    return () => {
      guest.removeEventListener("did-navigate", onDidNavigate);
      guest.removeEventListener("did-navigate-in-page", onDidNavigate);
      guest.removeEventListener("did-start-loading", onStartLoading);
      guest.removeEventListener("did-stop-loading", onStopLoading);
      guest.removeEventListener("dom-ready", onStopLoading);
      guest.removeEventListener("page-title-updated", onTitle);
      guest.removeEventListener("page-favicon-updated", onFavicon);
      guest.removeEventListener("media-started-playing", onAudible);
      guest.removeEventListener("media-paused", onQuiet);
      guest.removeEventListener("will-navigate", onWillNavigate);
      guest.removeEventListener("new-window", onNewWindow);
    };
  }, [discarded]);

  /* ------------------------------ guest 注册 ----------------------------- */
  /**
   * `dom-ready` 之前 `getWebContentsId()` 还不存在，所以注册挂在这个事件上
   * （[浏览器节点] §3.1）。
   *
   * 页面报的那个 id 主进程**不信**：它会核对 `getType() === 'webview'` 再收
   * 下。少了那道核对，这个调用就等于「把 debugger attach 到渲染进程说的任何
   * 东西上」，包括渲染进程自己那一个。
   *
   * `active` 跟着「是不是当前标签」走，并在切换时重新注册：动词永远只驱动节
   * 点的活动画布标签，主进程靠这一位判断哪个是。ghost（属于另一个工作空间或
   * 被折叠掉）永远不是活动标签——那是一个没人在看的页面。
   */
  const activeTab = !hidden && !ghost;
  React.useEffect(() => {
    const guest = ref.current;
    if (!guest || discarded) return;
    let release: (() => void) | null = null;
    let registeredId: number | null = null;
    /**
     * 重新登记同一个 `webContentsId` **不能**先注销。
     *
     * 主进程那边「同 id 再登记」是幂等的：条目被替换，`GuestSession` 原样留着
     * （`main/browser/registry.ts` 的注释写了这一条）。而注销是一次撤销——它
     * 会 detach debugger 并把租约标成 `unregistered`，在途的动词当场收到
     * `browser_lease_revoked`。
     *
     * `dom-ready` 每导航一次就来一发，于是「先注销再登记」的写法意味着
     * **Agent 每次 `navigate` 都会撤销自己刚拿到的租约**：`Page.navigate` 之
     * 后那 150 ms 的 settle 里 `dom-ready` 正好落下，紧接着的
     * `Page.getLayoutMetrics` 就抛 `browser_lease_revoked: unregistered`。
     * 所以只有 id 真的换了（回收后重挂、标签换 guest）才注销。
     */
    const announce = () => {
      const webContentsId = guestWebContentsId(guest);
      if (webContentsId === undefined) return;
      const box = guest.getBoundingClientRect();
      if (registeredId !== null && registeredId !== webContentsId) release?.();
      registeredId = webContentsId;
      release = registerGuest({
        webContentsId,
        nodeId,
        tabId: tab.id,
        surface: "canvas",
        active: activeTab,
        hostX: box.x,
        hostY: box.y,
      });
    };
    guest.addEventListener("dom-ready", announce);
    // Already ready when this effect re-runs for a tab that merely changed
    // hands: `dom-ready` has been and gone, and waiting for another one would
    // leave the node undrivable until it navigated.
    announce();
    return () => {
      guest.removeEventListener("dom-ready", announce);
      release?.();
    };
  }, [nodeId, tab.id, activeTab, discarded]);

  /**
   * 几何与缩放。主进程算不出来——React Flow 的 transform 在页面里。
   * 它需要这两样把右键菜单的宿主窗口坐标换算回 guest 视口坐标：zoom = 2 时
   * 实测差 282 px，不是取整能糊过去的量（webview-probe §4）。
   */
  React.useEffect(() => {
    const guest = ref.current;
    if (!guest || discarded || !activeTab) return;
    const box = guest.getBoundingClientRect();
    const webContentsId = guestWebContentsId(guest);
    if (webContentsId === undefined) return;
    reportView({ webContentsId, hostX: box.x, hostY: box.y, zoom });
  }, [zoom, activeTab, discarded, tab.src]);

  /* -------------------------------- 回收 --------------------------------- */
  const hiddenSinceRef = React.useRef<number | null>(
    hidden ? Date.now() : null,
  );
  React.useEffect(() => {
    hiddenSinceRef.current = hidden ? Date.now() : null;
    if (!hidden && discarded) {
      // 恢复：重新挂元素并重放地址。`restoringRef` 让随之而来的那次
      // `did-navigate` 被认作回声（见上面的注释）。
      restoringRef.current = true;
      setDiscarded(false);
    }
  }, [hidden, discarded]);

  const loadingRef = React.useRef(tab.loading);
  loadingRef.current = tab.loading;
  const audibleRef = React.useRef(tab.audible);
  audibleRef.current = tab.audible;
  const drivenRef = React.useRef(driven);
  drivenRef.current = driven;

  React.useEffect(() => {
    if (discarded) return;
    const timer = setInterval(() => {
      const since = hiddenSinceRef.current;
      if (since === null) return;
      if (
        !shouldDiscard({
          // 设置在**定时器触发时重读**：人在设置页把开关关掉、把分钟数调大，
          // 下一个 tick 就按新值判断，不用等这棵子树重渲。
          ...discardSettings(),
          loading: loadingRef.current,
          audible: audibleRef.current,
          driven: drivenRef.current,
          hiddenMs: Date.now() - since,
        })
      ) {
        return;
      }
      // 回收 = 卸载元素并**记住 URL**。把 `src` 置空没用（Electron 忽略它），
      // 所以地址存在标签的 `src` 上：恢复时那一行就是要重放的地址。
      patchRef.current({ src: locationRef.current });
      setDiscarded(true);
    }, DISCARD_TICK_MS);
    return () => clearInterval(timer);
  }, [discarded]);

  /* -------------------------------- 渲染 --------------------------------- */
  const style: React.CSSProperties = {
    width: "100%",
    height: "100%",
    // `display:none` 而不是卸载：实测 guest 在自身或祖先隐藏时状态不变、
    // viewport 与滚动位置保留、重新显示逐像素一致（browser-node §1.2）。
    ...(hidden ? { display: "none" } : {}),
  };

  if (discarded) {
    return (
      <div
        className="grid h-full w-full place-items-center px-6 text-center text-[11px] text-muted-foreground"
        data-slot="browser-discarded"
        style={hidden ? { display: "none" } : undefined}
      >
        {t("browser.discarded", { minutes: discardMinutes })}
      </div>
    );
  }

  return (
    <webview
      ref={(element) => {
        ref.current = (element as WebviewElement | null) ?? null;
        onElement(ref.current);
      }}
      src={tab.src || "about:blank"}
      partition={partition}
      // 必须是字符串：React 对它不认识的属性收到布尔 `true` 时**不写 DOM**
      // 只发警告，于是 `allowpopups={true}` 从未真正生效。`@types/react` 把
      // 它标成 boolean，所以这里只能绕过类型。
      allowpopups={"true" as unknown as boolean}
      style={style}
      data-slot="browser-webview"
      data-tab-id={tab.id}
    />
  );
}
