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
}

/** guest 事件里用得上的几个字段。全部是可选的：不同事件带的不一样。 */
export interface WebviewNavigationEvent extends Event {
  url?: string;
  favicons?: string[];
  title?: string;
  disposition?: string;
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
 * 就等于它能读这台机器上任何用户可读的东西。这一版**故意**比 nodeterm 更严：
 * nodeterm 在「当前页已经是 file:// 或 guest 全新」时放行 `file://`，那条放行
 * 只有在有本地媒体节点时才有意义，Armadra 现在没有，先不开。
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
