import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { EventBus } from "../bus";
import type { CorePlatform } from "../platform";
import { corsHeaders, websocketOriginAllowed } from "./cors";
import {
  type ErrorResponse,
  badRequest,
  internal,
  payloadTooLarge,
} from "./errors";
import { type HookHealth, NO_HOOK_SERVICE, healthDocument } from "./health";
import { type CoreRequest, type HandlerResult, Router } from "./router";

/**
 * The core's HTTP and WebSocket face.
 *
 * `node:http` plus `ws`, and nothing else. Express or Fastify would buy
 * routing the core already has as a table and middleware the core has three
 * of; what they would cost is a second opinion on the error envelope, which
 * is contractual (`{ code, message }`, camelCase, contract §5.1).
 *
 * The three layers, in the order a request meets them:
 *
 *   1. **Origin.** A browser request must come from a loopback origin, and a
 *      WebSocket upgrade must name one — the browser sends no preflight for an
 *      upgrade, so this check is the only gate on the streams. A request with
 *      no `Origin` is not a browser and passes: that is `curl`, the shell's own
 *      probe and the hook client.
 *   2. **Body limit.** A body is buffered before it is parsed, so the ceiling
 *      has to bite while reading, not after.
 *   3. **Envelope.** Every answer is JSON; every failure is `{ code, message }`.
 */

/** How long `close()` waits for a listener before giving up on it. */
export const CLOSE_GRACE_MS = 2_000;

/** What a body may weigh before the core stops reading it. */
export const MAX_BODY_BYTES = 12 * 1024 * 1024;

export interface CoreServerOptions {
  readonly platform: CorePlatform;
  readonly bus: EventBus;
  readonly version: string;
  /** R3 replaces this; R0 reports a core with no hook service. */
  readonly hookHealth?: () => HookHealth;
  readonly maxBodyBytes?: number;
}

export class CoreServer {
  readonly router = new Router();
  private readonly websockets: WebSocketServer;
  private readonly servers: Server[] = [];
  private readonly streams = new Map<string, StreamRegistration>();
  private readonly rawRoutes: { prefix: string; handler: RawHandler }[] = [];
  private readonly bodyLimits = new Map<string, number>();
  private readonly options: CoreServerOptions;

  constructor(options: CoreServerOptions) {
    this.options = options;
    this.websockets = new WebSocketServer({
      noServer: true,
      // Terminal frames are the reason: compression on a stream of escape
      // sequences costs CPU per frame for a ratio the transport does not need.
      perMessageDeflate: false,
    });
    const health = () => ({
      status: 200,
      body: healthDocument({
        version: options.version,
        hookHealth: options.hookHealth ?? (() => NO_HOOK_SERVICE),
      }),
    });
    this.router.handle("GET", "/health", health);
    this.router.handle("GET", "/api/health", health);
  }

  /**
   * A server per listener. One address per `http.Server` is a Node fact, so
   * the router and the upgrade handler are shared and the servers are not.
   */
  createListener(): Server {
    const server = createServer((request, response) => {
      void this.serve(request, response);
    });
    server.on("upgrade", (request, socket, head) => {
      this.upgrade(request, socket, head);
    });
    this.servers.push(server);
    return server;
  }

  private async serve(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const origin = request.headers.origin;
    const headers = corsHeaders(Array.isArray(origin) ? origin[0] : origin);
    if (headers === undefined) {
      return this.send(response, 403, {
        code: "forbidden",
        message: "来源不被允许",
      });
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://core");
    const path = url.pathname;
    let answer: HandlerResult | ErrorResponse;
    try {
      const body = await readBody(request, this.bodyLimitFor(path));
      if (!body.ok) {
        answer = body.tooLarge
          ? payloadTooLarge(body.reason)
          : badRequest(body.reason);
      } else {
        const core = coreRequest(request, url, body.body);
        // Raw routes come before the table: they own their own encoding
        // (protobuf compatibility faces), so the JSON envelope must not touch
        // them. Origin and the body ceiling still apply — they ran above.
        const raw = this.rawRoutes.find((route) =>
          path.startsWith(route.prefix),
        );
        if (raw !== undefined) {
          await raw.handler(core, response, headers);
          return;
        }
        answer = await this.router.dispatch(
          request.method ?? "GET",
          path,
          core,
        );
      }
    } catch (error) {
      this.options.platform.log.error("request failed", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      answer = internal("核心处理请求时失败");
    }
    this.send(
      response,
      answer.status,
      answer.body,
      {
        ...headers,
        ...("headers" in answer ? answer.headers : undefined),
      },
      "raw" in answer ? answer.raw : undefined,
    );
  }

  private send(
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
    raw?: Buffer,
  ): void {
    // 204 carries no body, and no `Content-Type` for a body that is not
    // there. `null\n` under `application/json` is what a client sees as a
    // document, and it is not the answer the Rust Runtime gives to a DELETE.
    const empty = status === 204 || status === 304;
    const payload = empty
      ? Buffer.alloc(0)
      : (raw ?? Buffer.from(JSON.stringify(body ?? null), "utf8"));
    response.writeHead(status, {
      ...(empty
        ? {}
        : {
            "content-type": raw
              ? "application/octet-stream"
              : "application/json",
          }),
      ...headers,
      ...(empty ? {} : { "content-length": String(payload.byteLength) }),
    });
    response.end(payload);
  }

  /**
   * Raises the body ceiling for one table route — the multipart imports,
   * which the Rust Runtime let through at a batch plus a manifest. Keyed by
   * the route's pattern, so a limit set before the route is claimed still
   * applies once it is.
   */
  bodyLimit(path: string, bytes: number): void {
    this.bodyLimits.set(path, bytes);
  }

  private bodyLimitFor(path: string): number {
    const found = this.router.match(path);
    return (
      (found === undefined
        ? undefined
        : this.bodyLimits.get(found.entry.path)) ??
      this.options.maxBodyBytes ??
      MAX_BODY_BYTES
    );
  }

  /**
   * A route matched by prefix, before the table, that writes its own response.
   * For the compatibility faces that speak something other than the JSON
   * envelope (`/rpc/…` protobuf). Origin and the body ceiling are still
   * enforced before the handler runs.
   */
  raw(prefix: string, handler: RawHandler): void {
    this.rawRoutes.push({ prefix, handler });
    this.rawRoutes.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  /**
   * The upgrade path. R0 accepts no stream yet — every WebSocket route in the
   * table belongs to R1 and later — so an upgrade is refused with the same
   * reason the HTTP side would give, rather than left hanging.
   */
  private upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const origin = request.headers.origin;
    if (!websocketOriginAllowed(Array.isArray(origin) ? origin[0] : origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", "http://core");
    const path = url.pathname;
    const found = this.router.match(path);
    const registration =
      found === undefined ? undefined : this.streams.get(found.entry.path);
    if (found === undefined || registration === undefined) {
      socket.write("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const core = coreRequest(request, url, Buffer.alloc(0));
    void (async () => {
      // The guard answers BEFORE the upgrade, as the Rust runtime does: a
      // missing workspace is an HTTP 404, not a socket that opens and closes.
      const refusal = registration.guard
        ? await registration.guard(found.params, core)
        : undefined;
      if (refusal !== undefined) {
        socket.write(
          `HTTP/1.1 ${refusal.status} ${refusal.reason ?? ""}\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      this.websockets.handleUpgrade(request, socket, head, (connection) => {
        registration.open(connection, found.params, core);
      });
    })();
  }

  /**
   * R1 and later attach their streams here; the table still gates the path.
   * `guard` may refuse the upgrade with an HTTP status before any socket
   * exists — the only way to answer 404/401/409 the way an HTTP route would.
   */
  stream(path: string, handler: StreamHandler, guard?: StreamGuard): void {
    this.streams.set(path, { open: handler, guard });
  }

  /**
   * Stops listening and drops every connection, upgraded ones included.
   *
   * `http.Server#close` waits for its connections to end, and
   * `closeAllConnections` ends the HTTP ones — but a socket that was upgraded
   * to a WebSocket is no longer on that list, so with one terminal or event
   * stream open the callback never came and the core never exited: the shell
   * waited its twelve seconds, sent SIGKILL and then refused to quit at all.
   * So the WebSocket clients are terminated first, and the wait is bounded —
   * a listener that still has not closed after {@link CLOSE_GRACE_MS} is not
   * worth keeping the process alive for.
   */
  async close(): Promise<void> {
    for (const client of this.websockets.clients) client.terminate();
    this.websockets.close();
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            const deadline = setTimeout(resolve, CLOSE_GRACE_MS);
            deadline.unref();
            server.close(() => {
              clearTimeout(deadline);
              resolve();
            });
            server.closeAllConnections();
          }),
      ),
    );
  }
}

export type StreamHandler = (
  connection: WebSocket,
  params: Readonly<Record<string, string>>,
  request: CoreRequest,
) => void;

/** Answer a status to refuse the upgrade, or `undefined` to let it through. */
export type StreamGuard = (
  params: Readonly<Record<string, string>>,
  request: CoreRequest,
) => Promise<StreamRefusal | undefined> | StreamRefusal | undefined;

export interface StreamRefusal {
  readonly status: number;
  readonly reason?: string;
}

interface StreamRegistration {
  readonly open: StreamHandler;
  readonly guard?: StreamGuard;
}

/** Writes its own status, headers and body; `cors` are the headers to include. */
export type RawHandler = (
  request: CoreRequest,
  response: ServerResponse,
  cors: Record<string, string>,
) => Promise<void> | void;

function coreRequest(
  request: IncomingMessage,
  url: URL,
  body: Buffer,
): CoreRequest {
  return {
    method: (request.method ?? "GET").toUpperCase(),
    path: url.pathname,
    query: url.searchParams,
    headers: request.headers,
    body,
    raw: request,
    json: <T>() => JSON.parse(body.toString("utf8") || "null") as T,
  };
}

type BodyResult =
  | { readonly ok: true; readonly body: Buffer }
  | {
      readonly ok: false;
      readonly tooLarge?: boolean;
      readonly reason: string;
    };

/**
 * Reads the body, refusing anything over the ceiling *while* it reads. A check
 * on `content-length` alone is a check a chunked request walks around.
 */
/**
 * How much of an over-limit body is drained before the socket is dropped.
 *
 * Destroying the request the moment the ceiling is crossed left the client
 * with a reset connection and no answer — the page saw a network error, not
 * "too large". Draining the rest (bounded, so a hostile stream cannot keep a
 * handler busy forever) lets the 413 actually reach it.
 */
export const DRAIN_LIMIT_BYTES = 8 * 1024 * 1024;

export function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let drained = 0;
    let over = false;
    request.on("data", (chunk: Buffer) => {
      if (over) {
        drained += chunk.byteLength;
        if (drained > DRAIN_LIMIT_BYTES) request.destroy();
        return;
      }
      size += chunk.byteLength;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () =>
      resolve(
        over
          ? {
              ok: false,
              tooLarge: true,
              reason: `请求体超过 ${limit} 字节上限`,
            }
          : { ok: true, body: Buffer.concat(chunks) },
      ),
    );
    request.on("error", (error) =>
      resolve({ ok: false, reason: error.message }),
    );
    request.on("close", () => {
      // A drain that hit its own ceiling: answer anyway; the socket is gone.
      if (over)
        resolve({
          ok: false,
          tooLarge: true,
          reason: `请求体超过 ${limit} 字节上限`,
        });
    });
  });
}
