import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TransportEndpoints } from "../shared/ipc";
import { publishedRuntimeBases } from "../shell-core/runtime/identity";

/**
 * Where the page sends its traffic.
 *
 * The page's first act, before it has awaited anything, is to decide the
 * Runtime base (`apps/web/src/api/request.ts:20` evaluates it at module load).
 * So this answer has to exist by the time the window loads the page, and it
 * has to be available to the preload synchronously — hence a resolved snapshot
 * held here rather than a value computed per request.
 *
 * The snapshot is taken once the Runtime is up, because the port the page
 * needs is kernel-assigned: only `endpoints.json` knows the number, and only
 * after the Runtime bound it. `transport:endpoints` still re-reads on every
 * invoke, so a caller that asks later sees a Runtime that came up late.
 */

let snapshot: TransportEndpoints | null = null;

/** The fallback: an external Runtime on its documented loopback port. */
export function fallbackEndpoints(
  externalBase: string,
  directory: string,
): TransportEndpoints {
  return {
    httpBase: externalBase,
    wsBase: externalBase.replace(/^http/, "ws"),
    dataDir: directory,
  };
}

/**
 * Reads the Runtime's published bases out of `endpoints.json`.
 *
 * This is the only thing that knows a kernel-assigned port — the shell asked
 * for `tcp:127.0.0.1:0` and never learned the answer any other way.
 * `apps/web/vite.config.ts` reads the same file for its dev proxy, so the
 * page and the shell always mean the same Runtime.
 */
export async function readRuntimeBases(
  directory: string,
): Promise<{ http: string; websocket: string } | undefined> {
  try {
    return publishedRuntimeBases(
      await readFile(join(directory, "endpoints.json"), "utf8"),
    );
  } catch {
    return undefined;
  }
}

export async function resolveEndpoints(
  directory: string,
  externalBase: string,
): Promise<TransportEndpoints> {
  const published = await readRuntimeBases(directory);
  if (published === undefined)
    return fallbackEndpoints(externalBase, directory);
  return {
    httpBase: published.http,
    wsBase: published.websocket,
    dataDir: directory,
  };
}

/** Records the answer the page will be given before it is asked for it. */
export function publishEndpoints(endpoints: TransportEndpoints): void {
  snapshot = endpoints;
}

/**
 * The synchronous answer, for the preload's `sendSync` at page load.
 *
 * It never blocks and never throws. A page that somehow asks before startup
 * finished gets the fallback rather than a hang: the front end would treat a
 * pending promise as a dead Runtime anyway, and an address that is wrong is at
 * least an address it can report as unreachable.
 */
export function endpointsSnapshot(
  fallback: () => TransportEndpoints,
): TransportEndpoints {
  return snapshot ?? fallback();
}

/** Test seam: forget what a previous run published. */
export function resetEndpoints(): void {
  snapshot = null;
}
