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
import { type ErrorResponse, badRequest, internal } from "./errors";
import { type HookHealth, NO_HOOK_SERVICE, healthDocument } from "./health";
import { Router } from "./router";

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
  private readonly streams = new Map<string, StreamHandler>();
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
    const path = new URL(request.url ?? "/", "http://core").pathname;
    let answer: { status: number; body: unknown } | ErrorResponse;
    try {
      const body = await readBody(
        request,
        this.options.maxBodyBytes ?? MAX_BODY_BYTES,
      );
      if (!body.ok) {
        answer = badRequest(body.reason);
      } else {
        answer = await this.router.dispatch(request.method ?? "GET", path);
      }
    } catch (error) {
      this.options.platform.log.error("request failed", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      answer = internal("核心处理请求时失败");
    }
    this.send(response, answer.status, answer.body, headers);
  }

  private send(
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
    response.writeHead(status, {
      ...headers,
      "content-type": "application/json",
      "content-length": String(payload.byteLength),
    });
    response.end(payload);
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
    const path = new URL(request.url ?? "/", "http://core").pathname;
    const found = this.router.match(path);
    if (
      found === undefined ||
      this.streams.get(found.entry.path) === undefined
    ) {
      socket.write("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const open = this.streams.get(found.entry.path) as StreamHandler;
    this.websockets.handleUpgrade(request, socket, head, (connection) => {
      open(connection, found.params);
    });
  }

  /** R1 and later attach their streams here; the table still gates the path. */
  stream(path: string, handler: StreamHandler): void {
    this.streams.set(path, handler);
  }

  async close(): Promise<void> {
    this.websockets.close();
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  }
}

export type StreamHandler = (
  connection: WebSocket,
  params: Readonly<Record<string, string>>,
) => void;

type BodyResult =
  | { readonly ok: true; readonly body: Buffer }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads the body, refusing anything over the ceiling *while* it reads. A check
 * on `content-length` alone is a check a chunked request walks around.
 */
export function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        request.destroy();
        resolve({ ok: false, reason: `请求体超过 ${limit} 字节上限` });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve({ ok: true, body: Buffer.concat(chunks) }));
    request.on("error", (error) =>
      resolve({ ok: false, reason: error.message }),
    );
  });
}
