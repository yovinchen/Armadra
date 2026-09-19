import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { type ListenSpec, bind, release } from "../listen";
import { ROUTES } from "../http/routes";
import { Router, type CoreRequest, type HandlerResult } from "../http/router";
import { readBody } from "../http/server";
import { collabDispatcher } from "./collab";
import {
  CLIENT_REVISION_HEADER,
  HOOK_TOKEN_HEADER,
  NODE_TOKEN_HEADER,
  type HookRequest,
  type IngestContext,
  ingest,
} from "./ingest";
import type { HookService } from "./service";

/**
 * The loopback hook service — contract §5.2.
 *
 * Its own listener, its own credentials and its own body limit, and
 * deliberately **not** the core's main server: a browser has no business on
 * these routes, so there is no CORS layer here at all and the only transport a
 * desktop install advertises is a Unix socket nothing on the network can
 * reach.
 *
 * The client reads stdin into memory with the same cap; the server refuses
 * more.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface HookServerOptions extends IngestContext {
  /** Answers a Unix socket as well as (or instead of) a TCP port. */
  readonly socketPath?: string | undefined;
  /** Refuse every request while the core is shutting down. */
  readonly shuttingDown?: () => boolean;
}

export class HookServer {
  readonly router = new Router(ROUTES, "hook");
  private readonly servers: { server: Server; spec: ListenSpec }[] = [];

  constructor(private readonly options: HookServerOptions) {
    this.router.handle(
      "GET",
      "/verify",
      (_match, request) => this.requireBearer(request) ?? { status: 204 },
    );

    this.router.handle("POST", "/hook/{agentId}", (match, request) => {
      const refusal = this.requireBearer(request);
      if (refusal !== undefined) return refusal;
      let body: HookRequest;
      try {
        body = (request.json<HookRequest>() ?? {}) as HookRequest;
      } catch {
        return {
          status: 400,
          body: { code: "bad_request", message: "请求体不是 JSON" },
        };
      }
      return ingest(
        this.options,
        match.params.agentId ?? "",
        body,
        headerRecord(request),
      );
    });

    for (const family of ["context-link", "control", "browser"] as const) {
      this.router.handle("POST", `/${family}/{verb}`, async (match, request) =>
        this.collab(family, match.params.verb ?? "", request),
      );
    }
  }

  /**
   * The app bearer. `undefined` means the caller may proceed; anything else is
   * the answer to send.
   */
  private requireBearer(request: CoreRequest): HandlerResult | undefined {
    const presented = single(request.headers[HOOK_TOKEN_HEADER]);
    if (this.options.hooks.bearerMatches(presented)) return undefined;
    return {
      status: 403,
      body: { code: "forbidden", message: "The hook token is not valid" },
    };
  }

  /**
   * The three collaboration families. Authentication is this surface's; the
   * verb table belongs to the domain that registered a dispatcher.
   *
   * `context-link` and `browser` answer prose because the client prints the
   * body verbatim into the calling agent's stdout; `control` answers JSON
   * unless the caller asked for text.
   */
  private async collab(
    family: "context-link" | "control" | "browser",
    verb: string,
    request: CoreRequest,
  ): Promise<HandlerResult> {
    const prose = family !== "control" || wantsText(request);
    const refusal = this.requireBearer(request);
    if (refusal !== undefined) {
      return prose
        ? text(refusal.status, `${(refusal.body as CoreError).message}\n`)
        : refusal;
    }
    let body: { nodeId?: unknown; args?: unknown };
    try {
      body = (request.json<{ nodeId?: unknown; args?: unknown }>() ?? {}) as {
        nodeId?: unknown;
        args?: unknown;
      };
    } catch {
      body = {};
    }
    const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
    const verdict = this.options.hooks.verdict(
      nodeId,
      single(request.headers[NODE_TOKEN_HEADER]),
    );
    if (verdict === "forged") {
      const message =
        "The node token was minted by this core but does not match the node";
      return prose
        ? text(403, `${message}\n`)
        : { status: 403, body: { code: "forbidden", message } };
    }
    const dispatcher = collabDispatcher(family);
    if (dispatcher === undefined) {
      const message = `协作动词 ${family}/${verb} 尚未接入（R3）`;
      return prose
        ? text(501, `${message}\n`)
        : { status: 501, body: { code: "not_implemented", message } };
    }
    const args =
      typeof body.args === "object" && body.args !== null
        ? (body.args as Record<string, unknown>)
        : {};
    const answer = await dispatcher({
      verb,
      caller: { nodeId, verified: verdict === "verified" },
      args,
      wantsText: prose,
    });
    return answer.kind === "text"
      ? text(answer.status, answer.body)
      : { status: answer.status, body: answer.body };
  }

  /** One listener per address; the router is shared. */
  private createListener(): Server {
    return createServer((request, response) => {
      void this.serve(request, response);
    });
  }

  private async serve(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (this.options.shuttingDown?.() === true) {
      send(response, 503, { code: "unavailable", message: "核心正在退出" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://hook");
    let answer: HandlerResult;
    try {
      const body = await readBody(request, MAX_BODY_BYTES);
      if (!body.ok) {
        answer = {
          status: 400,
          body: { code: "bad_request", message: body.reason },
        };
      } else {
        answer = (await this.router.dispatch(
          request.method ?? "GET",
          url.pathname,
          {
            method: (request.method ?? "GET").toUpperCase(),
            path: url.pathname,
            query: url.searchParams,
            headers: request.headers,
            body: body.body,
            raw: request,
            json: <T>() =>
              JSON.parse(body.body.toString("utf8") || "null") as T,
          },
        )) as HandlerResult;
      }
    } catch (error) {
      this.options.log.warn("hook request failed", {
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      answer = {
        status: 500,
        body: { code: "internal", message: "核心处理 hook 请求时失败" },
      };
    }
    send(
      response,
      answer.status,
      answer.body,
      answer.headers,
      "raw" in answer ? answer.raw : undefined,
    );
  }

  /** Binds one address. Failures are the caller's to report. */
  async listen(spec: ListenSpec): Promise<ListenSpec> {
    const server = this.createListener();
    const bound = await bind(server, spec);
    this.servers.push({ server, spec: bound });
    return bound;
  }

  async close(): Promise<void> {
    await Promise.all(
      this.servers.map(
        ({ server }) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
    for (const { spec } of this.servers) release(spec);
    this.servers.length = 0;
  }
}

interface CoreError {
  readonly code: string;
  readonly message: string;
}

function text(status: number, body: string): HandlerResult {
  return {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
    raw: Buffer.from(body, "utf8"),
  };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function wantsText(request: CoreRequest): boolean {
  const accept = single(request.headers.accept) ?? "";
  return accept.includes("text/plain");
}

/** The three headers the ingest path reads, lower-cased and de-duplicated. */
function headerRecord(
  request: CoreRequest,
): Record<string, string | undefined> {
  return {
    [HOOK_TOKEN_HEADER]: single(request.headers[HOOK_TOKEN_HEADER]),
    [NODE_TOKEN_HEADER]: single(request.headers[NODE_TOKEN_HEADER]),
    [CLIENT_REVISION_HEADER]: single(request.headers[CLIENT_REVISION_HEADER]),
  };
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  raw?: Buffer,
): void {
  const empty = status === 204 || status === 304;
  const payload = empty
    ? Buffer.alloc(0)
    : (raw ?? Buffer.from(JSON.stringify(body ?? null), "utf8"));
  response.writeHead(status, {
    ...(empty || raw !== undefined
      ? {}
      : { "content-type": "application/json" }),
    ...headers,
    ...(empty ? {} : { "content-length": String(payload.byteLength) }),
  });
  response.end(payload);
}
