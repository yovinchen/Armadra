/**
 * The page's Content-Security-Policy.
 *
 * The Rust shell got one from its packaged configuration and Electron gives the
 * page none at all, so it has to be stated here or the new shell would be a
 * quiet loosening of a rule nobody removed on purpose.
 *
 * What changed with the loopback HTTP origin: `connect-src` no longer names a
 * custom scheme (`armadra:`), because there is no longer a protocol handler to
 * forward through — the page talks to the Runtime and the Host as ordinary
 * HTTP services. Their ports are kernel-assigned, so the grant is by host
 * rather than by number, which is exactly as tight as a loopback port can be
 * described in CSP: `http://127.0.0.1:*` reaches nothing that is not already
 * on this machine and reachable by any local process anyway.
 *
 * `frame-src http: https:` stays for now: browser nodes still render the old
 * compatibility iframe until W3 replaces them with `<webview>` guests.
 */

/** Sources the page may open HTTP and WebSocket connections to. */
const CONNECT = [
  "'self'",
  "http://127.0.0.1:*",
  "http://localhost:*",
  "ws://127.0.0.1:*",
  "ws://localhost:*",
];

/**
 * One policy for both modes. Development needs no extra grant: the dev server,
 * the Runtime and the Host are all loopback HTTP, which the list above already
 * covers — a dev-only policy is a policy the shipped build never exercises.
 */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    `connect-src ${CONNECT.join(" ")}`,
    // Tailwind and the shadcn components set inline custom properties.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    // Browser nodes (W3 replaces this with <webview>).
    "frame-src http: https:",
    // Nothing on this page is ever framed by anything.
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
}

/** Whether a URL is one the CSP above is meant to cover. */
export function isPageUrl(url: string, pageOrigin: string): boolean {
  return url === pageOrigin || url.startsWith(`${pageOrigin}/`);
}
