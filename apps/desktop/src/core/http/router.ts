import {
  type ErrorResponse,
  methodNotAllowed,
  notFound,
  notImplemented,
} from "./errors";
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

export type Handler = (
  match: RouteMatch,
) => Promise<HandlerResult> | HandlerResult;

export interface HandlerResult {
  readonly status: number;
  readonly body: unknown;
}

interface Compiled {
  readonly entry: RouteEntry;
  readonly segments: readonly string[];
  /** Fewer parameters wins when two patterns both match. */
  readonly literals: number;
}

export class Router {
  private readonly compiled: Compiled[];
  private readonly handlers = new Map<string, Handler>();

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
  handle(method: string, path: string, handler: Handler): void {
    const known = this.compiled.some((route) => route.entry.path === path);
    if (!known) {
      throw new Error(
        `${path} is not in the route table for the ${this.surface} surface`,
      );
    }
    this.handlers.set(key(method, path), handler);
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
    return handler(found);
  }
}

function key(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function split(path: string): string[] {
  return path.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
}
