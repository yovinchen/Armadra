const LOCAL_RUNTIME = "http://127.0.0.1:43120";

/**
 * 打包后的桌面壳不监听端口（roadmap §4.4）：Runtime 只在 Unix socket / 命名管道上，
 * HTTP 经 `armadra://` 自定义协议转发。页面地址决定该协议怎么拼——这是 Tauri 的
 * 固定规则，不需要壳注入任何变量：
 *
 *   macOS / Linux   页面 `tauri://localhost`        → `armadra://localhost`
 *   Windows         页面 `http(s)://tauri.localhost` → `http(s)://armadra.localhost`
 *
 * 开发模式页面在 `http://127.0.0.1:1420`，此时用 `VITE_RUNTIME_URL` 或默认回环端口。
 */
const NATIVE_SHELL_ORIGINS: Record<string, string> = {
  "tauri://localhost": "armadra://localhost",
  "http://tauri.localhost": "http://armadra.localhost",
  "https://tauri.localhost": "https://armadra.localhost",
};

/** 壳自己回答的一条路由；只有它知道 WebSocket 回环转发端口。 */
export const TRANSPORT_PATH = "/__armadra/transport";

/** An explicit relative/empty URL opts a web deployment into its own origin. */
export function resolveRuntimeUrl(
  configured: string | undefined,
  pageUrl: string,
): string {
  // 显式配置永远优先：桌面开发模式靠它连外部 Runtime。
  if (configured === undefined)
    return (
      nativeShellRuntimeUrl(pageUrl) ??
      hostServedOrigin(pageUrl) ??
      LOCAL_RUNTIME
    );
  const url = new URL(configured.trim() || "/", pageUrl);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "VITE_RUNTIME_URL must be an HTTP(S) base URL without credentials, a query or a fragment",
    );
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * 页面跑在打包桌面壳里时的 Runtime 基址，否则 `null`。
 * 只认 Tauri 自己会给出的那几个来源，不做任何猜测。
 */
export function nativeShellRuntimeUrl(pageUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  // `URL.origin` is `"null"` for a non-special scheme such as `tauri:`, so the
  // origin is spelled out from the two parts that do survive.
  if (url.username || url.password) return null;
  return NATIVE_SHELL_ORIGINS[`${url.protocol}//${url.host}`] ?? null;
}

/**
 * 「经 Host 访问」模式的 Runtime 基址：Go Host 用 HTTPS 托管这份前端，并把
 * `/api/**` 与 WebSocket 代理到本机 Runtime（host-protocol-design §5，H02）。
 * 此时同源就是唯一能用的地址，不需要 `VITE_RUNTIME_URL`。
 *
 * 判据是页面协议：开发服务器与 `armadra.sh run web` 都是回环 HTTP，Host 只在
 * 明确配置的 HTTPS 来源上提供页面；而 HTTPS 页面本来也无法访问
 * `http://127.0.0.1`（混合内容会被浏览器拦掉），所以这里不存在更好的猜测。
 */
export function hostServedOrigin(pageUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (nativeShellRuntimeUrl(pageUrl)) return null;
  return url.origin;
}

/**
 * 这份页面是不是由 Host 托管、`/api` 走它的认证代理。
 *
 * 只有这种模式下写请求才要带会话 CSRF 头，「对外服务」开关也才有对象可读写；
 * 桌面壳与本机开发直连 Runtime，Runtime 自己没有会话。
 */
export function isHostServed(
  configured: string | undefined,
  pageUrl: string,
): boolean {
  const origin = hostServedOrigin(pageUrl);
  return origin !== null && resolveRuntimeUrl(configured, pageUrl) === origin;
}

/** 这个基址是不是壳的自定义协议（而不是一个真实的 HTTP 端点）。 */
export function isShellTransport(base: string): boolean {
  return Object.values(NATIVE_SHELL_ORIGINS).some(
    (shell) => base === shell || base.startsWith(`${shell}/`),
  );
}

/** Keep a reverse-proxy prefix for terminal and workspace event sockets. */
export function runtimeSocketUrl(base: string, path: string): string {
  const url = new URL(
    `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/**
 * WebSocket 不能走自定义协议（WebKit / WebView2 只认 ws:），所以壳另开一个回环
 * 转发端口。端口每次启动都不同，只能问壳；拿不到就退回按 `base` 推导，浏览器
 * 模式下那正是同一个地址。
 */
export async function resolveSocketBase(
  base: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  // 浏览器 / 开发模式：Runtime 的 HTTP 端口就是它的 WebSocket 端口。
  if (!isShellTransport(base)) return base;
  try {
    const response = await fetcher(`${base}${TRANSPORT_PATH}`);
    if (!response.ok) return base;
    const payload: unknown = await response.json();
    const websocket =
      payload && typeof payload === "object"
        ? (payload as { websocket?: unknown }).websocket
        : undefined;
    if (typeof websocket !== "string") return base;
    const url = new URL(websocket);
    // 只接受回环 ws：壳只会给这个，别的都不该出现在这条路上。
    if (
      url.protocol !== "ws:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    ) {
      return base;
    }
    return url.href.replace(/\/+$/, "");
  } catch {
    return base;
  }
}
