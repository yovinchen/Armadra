/**
 * `<webview>` 的类型面与两条纯判定（electron-migration.md §4.1）。
 *
 * `apps/web` 不依赖 `electron` 的类型（它在浏览器里也要能构建），所以这里只
 * 按结构写出真正用到的那几个成员。少写一个方法的代价是编译期报错，写错一个
 * 名字的代价也是——两者都比 `any` 好。
 *
 * JSX 那一侧**不用自己声明**：`@types/react` 的 `WebViewHTMLAttributes` 已经
 * 给了 `webview` 这个内建元素和 `src` / `partition` / `allowpopups` 等属性。
 * 再补一份只会和它冲突。
 */

/** Electron `WebviewTag` 里本节点用到的部分。 */
export interface WebviewElement extends HTMLElement {
  src: string;
  getWebContentsId(): number;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  isLoading(): boolean;
  isCurrentlyAudible?(): boolean;
  getURL(): string;
  /**
   * 这一帧的位图（Electron `WebviewTag.capturePage`）。
   *
   * 在**可见且加载完**的时候拍一张，回收后的占位与回来路上的重新加载都用
   * 它——隐藏之后再拍只会拿到空图（`WebviewGuest.tsx` 写了实测）。**不经 CDP**：
   * `capturePage` 是 webview 元素自己的方法，不 attach debugger，也就不碰
   * 「能力关闭时 attach 次数为零」那条验收闸门。
   *
   * 可选：这个方法在元素 attach 之前不存在，测试里的替身也不会有它。
   */
  capturePage?(): Promise<WebviewImage>;
}

/** `capturePage` 回来的那个 `NativeImage`，只写本节点用到的两个方法。 */
export interface WebviewImage {
  isEmpty(): boolean;
  resize(options: { width?: number; height?: number }): WebviewImage;
  toDataURL(): string;
}

/**
 * 占位图的宽度（CSS 像素）。
 *
 * 回收的目的是省内存，所以占位图本身不能是新的内存问题：一个 1280×800 的
 * PNG data URL 是几百 KB，八个后台节点就是几 MB 的字符串常驻在 React
 * state 里。320 px 宽缩略图在节点尺寸下是明显糊的——这正是想要的效果，人
 * 一眼就知道那不是活着的页面。
 */
export const SNAPSHOT_WIDTH = 320;

/**
 * 从「加载完」到拍照之间等多久。
 *
 * `did-stop-loading` 早于首帧合成，紧接着拍到的是上一页或者一张空图。半秒
 * 是肉眼上仍然算「刚才那一页」、又足够一次首屏合成的量。
 */
export const SNAPSHOT_DELAY_MS = 500;

/**
 * PURE. 位图 → data URL，拿不到就空串。
 *
 * 空图要挡掉：`capturePage` 在一个已经停止绘制的 guest 上会回一张 0×0 的
 * 图，`toDataURL()` 给出一个合法但全透明的 URL，贴上去就是一块比没有占位
 * 更难解释的空白。
 */
export function snapshotDataUrl(image: WebviewImage | undefined): string {
  if (!image || typeof image.toDataURL !== "function") return "";
  try {
    if (typeof image.isEmpty === "function" && image.isEmpty()) return "";
    const scaled =
      typeof image.resize === "function"
        ? image.resize({ width: SNAPSHOT_WIDTH })
        : image;
    return scaled.toDataURL();
  } catch {
    return "";
  }
}

/** guest 事件里用得上的几个字段。全部是可选的：不同事件带的不一样。 */
export interface WebviewNavigationEvent extends Event {
  url?: string;
  favicons?: string[];
  title?: string;
  disposition?: string;
  /** `did-fail-load` 的三个字段。 */
  errorCode?: number;
  errorDescription?: string;
  validatedURL?: string;
  isMainFrame?: boolean;
}

/* -------------------------------- 加载失败 -------------------------------- */

/** 一次主框架加载失败。`null` 表示这一页没有失败。 */
export interface WebviewFailure {
  /** Chromium 的 `net::` 错误码（负数）。 */
  readonly code: number;
  /** Chromium 给的英文描述，例如 `ERR_NAME_NOT_RESOLVED`。 */
  readonly description: string;
  /** 失败的那个地址。 */
  readonly url: string;
}

/**
 * 「用户主动取消」的那个错误码。
 *
 * `ERR_ABORTED`。按停止、在加载中途点了另一个链接、以及大量 SPA 的正常导航
 * 都会报它。把它当失败会让错误页在完全正常的操作后闪出来，所以它不是失败。
 */
export const ERR_ABORTED = -3;

/**
 * 一条 `did-fail-load` 该不该变成错误页。纯函数。
 *
 * 三条否决：不是主框架（一张图、一个广告 iframe 加载不出来不是这一页的
 * 失败）、`ERR_ABORTED`、以及没有地址可报的那种（Chromium 在少数竞态下会
 * 报一次空 `validatedURL`，据它画一张「打不开 ""」的错误页只会让人困惑）。
 */
export function failureOf(
  event: Pick<
    WebviewNavigationEvent,
    "errorCode" | "errorDescription" | "validatedURL" | "isMainFrame"
  >,
): WebviewFailure | null {
  if (event.isMainFrame === false) return null;
  const code = event.errorCode;
  if (typeof code !== "number" || code === 0 || code === ERR_ABORTED) {
    return null;
  }
  const url = event.validatedURL ?? "";
  if (!url) return null;
  return { code, description: event.errorDescription ?? "", url };
}

/**
 * 错误页上那一行的 i18n 键后缀。
 *
 * 只分四类，不是把 Chromium 的几十个 `net::` 码翻一遍：人能做的事只有这
 * 四种——检查网络、检查地址、这个站点的证书有问题、以及「剩下的」。多出
 * 来的精度不会改变任何一次操作。
 */
export function failureKind(
  failure: WebviewFailure,
): "offline" | "notFound" | "certificate" | "unknown" {
  const name = failure.description.toUpperCase();
  if (
    name.includes("INTERNET_DISCONNECTED") ||
    name.includes("NETWORK_CHANGED") ||
    name.includes("NAME_NOT_RESOLVED") ||
    name.includes("ADDRESS_UNREACHABLE")
  ) {
    return "offline";
  }
  if (name.includes("CERT") || name.includes("SSL")) return "certificate";
  if (
    name.includes("CONNECTION_REFUSED") ||
    name.includes("CONNECTION_RESET") ||
    name.includes("CONNECTION_CLOSED") ||
    name.includes("EMPTY_RESPONSE") ||
    name.includes("TIMED_OUT")
  ) {
    return "notFound";
  }
  return "unknown";
}

/* ------------------------------ 地址栏输入 ------------------------------- */

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** 至少一个点、没有空格，且点号两侧都有字符——「看起来像域名」。 */
const HOSTLIKE = /^[^\s/?#]+\.[^\s/?#.]+(?:[/?#]|$)/;

/**
 * 地址栏里那一行是网址还是搜索词（[浏览器节点](browser-node.md) §2.4）。
 *
 * 判定有意偏向「当搜索词」：把 `foo bar` 当网址的结果是一个打不开的页面和一
 * 条看不懂的错误，把 `localhost:3000` 当搜索词的结果只是多按一次回车。所以
 * 只有三种情况算网址——带 scheme、带明确的主机名形状、或者是 localhost。
 */
export function searchOrUrl(input: string): string {
  const text = input.trim();
  if (!text) return "";
  // `localhost:5173` 先判：它同时匹配 scheme 的形状（`localhost:` 看起来就是
  // 一个 scheme），放在 SCHEME 后面会被原样交给 guest，然后打不开。
  if (/^localhost(:\d+)?([/?#]|$)/i.test(text)) return `http://${text}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(text)) {
    return `http://${text}`;
  }
  if (SCHEME.test(text)) return text;
  if (HOSTLIKE.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

/* ------------------------------ 导航门控 --------------------------------- */

/**
 * 渲染侧的导航门：只放行 http(s)（W3.1）。
 *
 * `file://` 与其余 scheme 一律拒绝——一个远程页面能把 guest 导航到本地文件，
 * 就等于它能读这台机器上任何用户可读的东西。Armadra 没有需要本地文件访问的
 * 媒体节点，因此即使当前页已经是 file:// 或 guest 全新，也不放行 `file://`。
 *
 * 真正的强制点在主进程（guest 的 `will-navigate` 与 `setWindowOpenHandler`），
 * 这里这一道是给 W3.3 之前的过渡期用的：渲染侧能拦下的先拦，拦不下的（真正
 * 的弹窗、下载、子框架）在报告里作为 main 侧待办列出。
 */
export function allowGuestNavigation(url: string): boolean {
  // 新标签的初始值。它不引入任何来源，但 `protocol` 是 `about:`，所以要在
  // scheme 判定之前单独放行。`about:` 的其余页面（`about:config` 之流）不放。
  if (url === "about:blank") return true;
  try {
    const scheme = new URL(url).protocol;
    return scheme === "http:" || scheme === "https:";
  } catch {
    // 相对地址与解析不出来的一律拒。
    return false;
  }
}

/**
 * 一个 guest 的 `partition`（[浏览器节点](browser-node.md) §2.3，探针 C）。
 *
 * 同一个工作空间的所有浏览器节点共享一个 jar，所以在 A 节点登录过的站点在 B
 * 节点里仍然是登录的。带 `persist:` 前缀，关掉应用再开还在。
 *
 * **创建时定一次、永不变更**：Electron 只在 attach 时读这个属性，attach 之后
 * 再改会被静默忽略（探针 C）——改了不报错、也不生效，于是一个「换了 partition
 * 就该退出登录」的节点会继续用着旧 jar，这比报错难查得多。
 */
export function browserPartition(workspaceId: string | undefined): string {
  return `persist:armadra-browser-${workspaceId ?? "default"}`;
}
