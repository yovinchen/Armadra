/**
 * Which origins a loopback core answers, and what it answers them with.
 *
 * The portless forms matter for the Unix socket and named pipe transports: a
 * caller that reached the core over one of those has no port to name. It is
 * still a loopback literal — this never widens to a hostname the network could
 * resolve, because a hostname is whatever somebody's `/etc/hosts` says.
 *
 * Ported from `apps/runtime/src/api/support.rs`.
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
 * The CORS headers for one request, or nothing when the origin is not one we
 * answer. A request with no `Origin` header is not a browser request and needs
 * no headers; refusing it would break `curl` and the shell's own probe.
 */
export function corsHeaders(
  origin: string | undefined,
): Record<string, string> | undefined {
  if (origin === undefined) return {};
  if (!isLoopbackOrigin(origin)) return undefined;
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
  return origin !== undefined && isLoopbackOrigin(origin);
}
