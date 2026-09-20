/**
 * Which origins a loopback core answers, and what it answers them with.
 *
 * The portless forms matter for the Unix socket and named pipe transports: a
 * caller that reached the core over one of those has no port to name. It is
 * still a loopback literal — this never widens to a hostname the network could
 * resolve, because a hostname is whatever somebody's `/etc/hosts` says.
 *
 * Ported from the pre-merge implementation.
 */
export function isLoopbackOrigin(origin: string): boolean {
  return (
    origin.startsWith("http://127.0.0.1:") ||
    origin.startsWith("http://localhost:") ||
    origin === "http://127.0.0.1" ||
    origin === "http://localhost"
  );
}

export const CORS_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
export const CORS_HEADERS = "content-type";

/**
 * 壳注入的额外允许来源。
 *
 * 回环之外的来源只有一种情况存在：服务器壳把页面托管在一个配置好的 HTTPS 来源
 * 上（R6a）。那个来源是运维给的（`--public-origin`）或监听地址本身，core 自己
 * 无从知道，所以由壳在绑定之后注入一次。桌面壳永远不调用它。
 *
 * 判定仍然只有 {@link corsHeaders} 与 {@link websocketOriginAllowed} 两处，这
 * 里只是把它们认的集合变成「回环 ∪ 壳声明的那几个」——注入的是数据，不是第二
 * 套规则。
 */
let injected: readonly string[] = [];

export function allowOrigins(origins: readonly string[]): void {
  injected = [...new Set(origins)];
}

/** 这次运行额外放行的来源，按注入时的去重结果。 */
export function allowedOrigins(): readonly string[] {
  return injected;
}

function answerable(origin: string): boolean {
  return isLoopbackOrigin(origin) || injected.includes(origin);
}

/**
 * The CORS headers for one request, or nothing when the origin is not one we
 * answer. A request with no `Origin` header is not a browser request and needs
 * no headers; refusing it would break `curl` and the shell's own probe.
 */
export function corsHeaders(
  origin: string | undefined,
): Record<string, string> | undefined {
  if (origin === undefined) return {};
  if (!answerable(origin)) return undefined;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": CORS_METHODS,
    "access-control-allow-headers": CORS_HEADERS,
    vary: "origin",
  };
}

/**
 * A WebSocket upgrade must name an origin, and it must be one of ours. Unlike
 * a `fetch`, the browser sends no preflight for a WebSocket, so this check is
 * the only thing between a page on any origin and the core's streams.
 */
export function websocketOriginAllowed(origin: string | undefined): boolean {
  return origin !== undefined && answerable(origin);
}
