import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { contentSecurityPolicy } from "../shell-core/csp";
import {
  DEFAULT_DEV_RENDERER_URL,
  pageSourceTarget,
} from "../shell-core/window-rules";

/**
 * The page's origin.
 *
 * Both modes answer through one value, because the origin is what everything
 * else is derived from: the Host's `--allow-origin`, the ticket the shell
 * mints, the CSP the window enforces. A second spelling of it anywhere is a
 * grant that does not match the page (§2.1).
 *
 *   development   apps/web's own dev server, already a loopback HTTP origin
 *   packaged      this file's server, on a kernel-assigned loopback port
 *
 * Never `file:`. A `file:` page has an opaque origin: it cannot be named in
 * `--allow-origin`, cannot be bound into a ticket, and its `fetch` to the
 * Runtime would be cross-origin with nothing to allow. Serving the bundle
 * ourselves is what makes the page an ordinary HTTP client of two ordinary
 * HTTP services, which is the whole point of the batch.
 */

export interface PageSource {
  /** Scheme, host and port — exactly as the Host reads the `Origin` header. */
  readonly origin: string;
  /** What the window loads. The origin plus the document's path. */
  readonly url: string;
  /** Whether this shell is the one serving it. */
  readonly served: boolean;
  close(): Promise<void>;
}

/** Only what apps/web's build output actually contains. */
const CONTENT_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".map", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".txt", "text/plain; charset=utf-8"],
]);

/**
 * Resolves a request path inside `root`, or `undefined` when it escapes.
 *
 * The decode happens before the containment check, and the check is on the
 * resolved absolute path rather than on the string: `%2e%2e%2f`, a doubled
 * separator and a symlink-free `..` all collapse to the same answer, and only
 * a path that really is under `root` is served.
 */
export function resolveWithinRoot(
  root: string,
  requestPath: string,
): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const base = resolve(root);
  const candidate = resolve(base, `.${normalize(decoded)}`);
  if (candidate !== base && !candidate.startsWith(base + sep)) return undefined;
  return candidate;
}

export function contentTypeFor(path: string): string {
  return (
    CONTENT_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream"
  );
}

/**
 * Whether a `Host` header names this server.
 *
 * The listener is bound to 127.0.0.1, so nothing off the machine reaches it —
 * but a public web page can still point a DNS name at 127.0.0.1 and have the
 * user's own browser issue requests to this port. Those requests carry that
 * name in `Host`, and refusing them is what keeps the shell's bundle from
 * being served under an origin it never granted anything to.
 */
export function hostHeaderAllowed(
  header: string | undefined,
  port: number,
): boolean {
  if (header === undefined) return false;
  const expected = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  return expected.has(header.toLowerCase());
}

async function fileOrIndex(
  root: string,
  requestPath: string,
): Promise<string | undefined> {
  const resolved = resolveWithinRoot(root, requestPath);
  if (resolved === undefined) return undefined;
  try {
    const found = await stat(resolved);
    if (found.isFile()) return resolved;
    if (found.isDirectory()) {
      const index = join(resolved, "index.html");
      if ((await stat(index)).isFile()) return index;
    }
  } catch {
    /* Fall through to the single-page fallback below. */
  }
  // apps/web is a single-page application: an unknown path is a route, not a
  // 404 — but only when it asks for a document. A missing asset stays missing
  // rather than being answered with HTML that the page would try to parse.
  if (extname(requestPath) !== "") return undefined;
  const index = resolve(root, "index.html");
  try {
    return (await stat(index)).isFile() ? index : undefined;
  } catch {
    return undefined;
  }
}

function serve(root: string, port: () => number) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const headers = {
        // The same policy `session.webRequest` applies, sent on the document
        // too: a page opened outside the shell's window (a devtools reload, a
        // future second window) must not be a laxer copy of the same bundle.
        "Content-Security-Policy": contentSecurityPolicy(),
        "X-Content-Type-Options": "nosniff",
        // The bundle is rebuilt in place under one origin; a cached index.html
        // outliving its hashed assets is the one failure a shell cannot
        // explain to the user.
        "Cache-Control": "no-store",
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { ...headers, Allow: "GET, HEAD" }).end();
        return;
      }
      if (!hostHeaderAllowed(request.headers.host, port())) {
        response.writeHead(421, headers).end();
        return;
      }
      const path = (request.url ?? "/").split(/[?#]/)[0] ?? "/";
      const file = await fileOrIndex(root, path);
      if (file === undefined) {
        response.writeHead(404, headers).end();
        return;
      }
      response.writeHead(200, {
        ...headers,
        "Content-Type": contentTypeFor(file),
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(file)
        .on("error", () => response.destroy())
        .pipe(response);
    })();
  };
}

/** Starts the loopback server for `root` and reports the origin it bound. */
export function startStaticServer(root: string): Promise<PageSource> {
  let bound = 0;
  const server: Server = createServer(serve(root, () => bound));
  return new Promise((done, fail) => {
    server.once("error", fail);
    // Port 0: the kernel picks. Nothing may assume a number here — the origin
    // it produces is read back, never predicted.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        fail(new Error("the static server bound no loopback port"));
        return;
      }
      bound = address.port;
      const origin = `http://127.0.0.1:${bound}`;
      done({
        origin,
        url: `${origin}/`,
        served: true,
        close: () =>
          new Promise<void>((closed) => server.close(() => closed())),
      });
    });
  });
}

/**
 * The page source for this run: a dev server somebody else already runs, or
 * one started here. The caller treats both the same, which is the point.
 */
export async function startPageSource(
  devServerUrl: string | undefined,
  packaged: boolean,
  staticRoot: string,
): Promise<PageSource> {
  const target = pageSourceTarget(devServerUrl, packaged, staticRoot);
  if (target.kind === "static") return startStaticServer(target.root);
  return {
    origin: new URL(target.url).origin,
    url: target.url,
    served: false,
    close: () => Promise.resolve(),
  };
}

export { DEFAULT_DEV_RENDERER_URL };
