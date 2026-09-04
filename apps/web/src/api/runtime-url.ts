const LOCAL_RUNTIME = "http://127.0.0.1:43120";

/** An explicit relative/empty URL opts a web deployment into its own origin. */
export function resolveRuntimeUrl(
  configured: string | undefined,
  pageUrl: string,
): string {
  if (configured === undefined) return LOCAL_RUNTIME;
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

/** Keep a reverse-proxy prefix for terminal and workspace event sockets. */
export function runtimeSocketUrl(base: string, path: string): string {
  const url = new URL(
    `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
