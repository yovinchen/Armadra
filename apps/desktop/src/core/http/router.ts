import {
  type ErrorResponse,
  methodNotAllowed,
  notFound,
  notImplemented,
} from "./errors";
import { type RouteScopeRequirement, routeScope } from "./route-scopes";
import { ROUTES, type RouteEntry } from "./routes";

/**
 * The route table, compiled.
 *
 * No framework: the routing problem here is one table of 163 literal paths
 * with `{param}` segments, and a matcher for that is thirty lines. What a
 * framework would add is a second place for middleware to live, and the core
 * has exactly three layers — origin, body limit, error envelope — all of which
 * belong in `server.ts` where the request actually arrives.
 *
 * Matching is by segment count first, then segment by segment, with literal
 * segments beating parameters. That ordering is what keeps
 * `/api/workspaces/remote` from being eaten by
 * `/api/workspaces/{workspaceId}`, which is the collision the Rust router
 * resolves the same way.
 */

export interface RouteMatch {
  readonly entry: RouteEntry;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * What a handler may read of the request. The body is already buffered (and
 * already under the size ceiling) by the time a handler runs, so a handler
 * never touches the socket; `raw` is there for the few that need a header the
 * fields below do not name.
 */
export interface CoreRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: import("node:http").IncomingHttpHeaders;
  readonly body: Buffer;
  readonly raw: import("node:http").IncomingMessage;
  /** `body` parsed as JSON on demand; throws `SyntaxError` on a bad document. */
  json<T = unknown>(): T;
}

export type Handler = (
  match: RouteMatch,
  request: CoreRequest,
) => Promise<HandlerResult> | HandlerResult;

export interface HandlerResult {
  readonly status: number;
  /** JSON-serialised unless `raw` is given. */
  readonly body?: unknown;
  /** Extra response headers (content-type may be overridden here). */
  readonly headers?: Readonly<Record<string, string>>;
  /** A pre-encoded body sent verbatim (protobuf, files); `body` is ignored. */
  readonly raw?: Buffer;
}

interface Compiled {
  readonly entry: RouteEntry;
  readonly segments: readonly string[];
  /** Fewer parameters wins when two patterns both match. */
  readonly literals: number;
}

/** What a registration may say about itself beyond the handler. */
export interface RouteOptions {
  /**
   * The permission this route requires, overriding `route-scopes.ts`.
   *
   * Almost nothing needs it: the table there covers every implemented path by
   * family, and a family is the unit a person reasons about when sharing a
   * board. It is here for the route whose requirement does not follow from its
   * path — and so that a domain *can* state its own without editing a table
   * that lives in another file.
   */
  readonly scope?: string;
}

export class Router {
  private readonly compiled: Compiled[];
  private readonly handlers = new Map<string, Handler>();
  private readonly declared = new Map<string, string>();

  constructor(
    entries: readonly RouteEntry[] = ROUTES,
    private readonly surface: RouteEntry["surface"] = "runtime",
  ) {
    this.compiled = entries
      .filter((entry) => entry.surface === surface)
      .map((entry) => {
        const segments = split(entry.path);
        return {
          entry,
          segments,
          literals: segments.filter((s) => !s.startsWith("{")).length,
        };
      })
      .sort((a, b) => b.literals - a.literals);
  }

  /**
   * Binds a real handler to a `(method, path)` from the table. The path must
   * be one of the table's: a route nobody wrote down is a route
   * `route-parity` cannot check, and a typo would otherwise register a handler
   * that is never reached.
   */
  handle(
    method: string,
    path: string,
    handler: Handler,
    options: RouteOptions = {},
  ): void {
    const known = this.compiled.some((route) => route.entry.path === path);
    if (!known) {
      throw new Error(
        `${path} is not in the route table for the ${this.surface} surface`,
      );
    }
    this.handlers.set(key(method, path), handler);
    if (options.scope !== undefined) {
      this.declared.set(key(method, path), options.scope);
    }
  }

  /**
   * What a caller must hold to be allowed through here.
   *
   * The decision itself is not here — it is `core/identity/authorize.ts`, and
   * today it says yes to the owner without consulting this at all. What this
   * answers is the question that has to be written down *before* there is a
   * second principal: which permission does this path stand for. A route the
   * table does not cover requires nothing, which is the honest answer for
   * `/health` and for the hook surface's own credentialled face.
   */
  requiredScope(
    method: string,
    path: string,
  ): RouteScopeRequirement | undefined {
    const found = this.match(path);
    const pattern = found?.entry.path ?? path;
    const workspaceId = found?.params.workspaceId ?? "";
    const declared = this.declared.get(key(method, pattern));
    if (declared !== undefined) {
      return { permission: declared, workspaceId };
    }
    const requirement = routeScope(method, pattern);
    if (requirement === undefined) return undefined;
    // 模式里的 `{workspaceId}` 不是一个工作空间；真实路径上的那个才是。
    return requirement.workspaceId === "" && workspaceId !== ""
      ? { ...requirement, workspaceId }
      : requirement;
  }

  match(path: string): RouteMatch | undefined {
    const wanted = split(path);
    for (const route of this.compiled) {
      if (route.segments.length !== wanted.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const segment = route.segments[index] as string;
        const actual = wanted[index] as string;
        if (segment.startsWith("{") && segment.endsWith("}")) {
          if (actual === "") {
            matched = false;
            break;
          }
          params[segment.slice(1, -1)] = decodeURIComponent(actual);
          continue;
        }
        if (segment !== actual) {
          matched = false;
          break;
        }
      }
      if (matched) return { entry: route.entry, params };
    }
    return undefined;
  }

  /**
   * Resolves one request to either a handler call or the answer the table
   * already knows: 404 for a path nobody claimed, 405 for a method this path
   * does not take, 501 naming the feature for everything not yet written.
   */
  async dispatch(
    method: string,
    path: string,
    request: CoreRequest = emptyRequest(method, path),
  ): Promise<HandlerResult | ErrorResponse> {
    const found = this.match(path);
    if (found === undefined) return notFound(path);
    const verb = method.toUpperCase();
    if (!found.entry.methods.includes(verb)) {
      return methodNotAllowed(verb, found.entry.path);
    }
    const handler = this.handlers.get(key(verb, found.entry.path));
    if (handler === undefined) {
      return notImplemented(
        found.entry.feature ?? found.entry.path,
        found.entry.phase ?? 1,
      );
    }
    return handler(found, request);
  }
}

/** A request with nothing in it — for tests and for dispatching by path alone. */
export function emptyRequest(method: string, path: string): CoreRequest {
  const body = Buffer.alloc(0);
  return {
    method: method.toUpperCase(),
    path,
    query: new URLSearchParams(),
    headers: {},
    body,
    raw: undefined as unknown as import("node:http").IncomingMessage,
    json: <T>() => JSON.parse(body.toString("utf8") || "null") as T,
  };
}

function key(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function split(path: string): string[] {
  return path.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
}
