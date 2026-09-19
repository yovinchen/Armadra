import { existsSync, readFileSync } from "node:fs";
import { writeSecret } from "./paths";

/**
 * `<data dir>/endpoints.json`.
 *
 * Once the core's TCP port is handed out by the kernel, nothing can hard code
 * it any more. This file is how the front end, `armadra.sh` and the shell find
 * the core: one 0600 JSON document per data directory, holding one record per
 * service.
 *
 * Two properties matter more than the shape:
 *
 *   * **Writing one service never disturbs the other.** Publishing is
 *     read-modify-write, and an unparsable file is replaced rather than merged
 *     into — a half-written file must not permanently wedge start-up.
 *   * **A record is only ever as good as its process.** `processId`,
 *     `instanceId` and `writtenAt` let a reader tell a live endpoint from one
 *     left behind by a crash; nothing here is proof a service is up, which is
 *     why every reader still probes.
 *
 * The schema is the Rust Runtime's, field for field, because the shell and the
 * page read one document whichever implementation wrote it.
 */

/** Bumped when a reader of version N can no longer make sense of the file. */
export const ENDPOINTS_VERSION = 1;

export const RUNTIME_SERVICE = "runtime";
export const HOST_SERVICE = "host";

export type ServiceName = typeof RUNTIME_SERVICE | typeof HOST_SERVICE;

export interface ServiceEndpoint {
  /** Identifies this *run*; it changes on every restart. */
  readonly instanceId: string;
  /** RFC 3339, UTC. */
  readonly writtenAt: string;
  readonly processId: number;
  /** `http://127.0.0.1:PORT`, absent when the service listens on no port. */
  readonly http?: string | undefined;
  readonly websocket?: string | undefined;
  /** Absolute Unix domain socket path. */
  readonly socket?: string | undefined;
  /** Windows named pipe, `\\.\pipe\NAME`. */
  readonly pipe?: string | undefined;
}

export interface EndpointsDocument {
  version: number;
  runtime?: ServiceEndpoint | undefined;
  host?: ServiceEndpoint | undefined;
}

/** A record for this process, stamped now. */
export function serviceEndpointNow(
  instanceId: string,
  now: () => Date = () => new Date(),
  processId: number = process.pid,
): ServiceEndpoint {
  return {
    instanceId,
    writtenAt: now().toISOString(),
    processId,
  };
}

/**
 * Reads the file. A missing, unreadable, unparsable or future-version document
 * yields an empty one: this is a discovery hint, never a source of truth, and a
 * corrupt hint must not stop anything from starting.
 */
export function read(path: string): EndpointsDocument {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return { version: ENDPOINTS_VERSION };
  }
  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch {
    return { version: ENDPOINTS_VERSION };
  }
  // An array is an object too, and a document that is one names no service.
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document)
  ) {
    return { version: ENDPOINTS_VERSION };
  }
  const record = document as Record<string, unknown>;
  const version = typeof record.version === "number" ? record.version : 0;
  if (version > ENDPOINTS_VERSION) return { version: ENDPOINTS_VERSION };
  return {
    version,
    runtime: endpointOf(record.runtime),
    host: endpointOf(record.host),
  };
}

function endpointOf(value: unknown): ServiceEndpoint | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return {
    instanceId: typeof record.instanceId === "string" ? record.instanceId : "",
    writtenAt: typeof record.writtenAt === "string" ? record.writtenAt : "",
    processId: typeof record.processId === "number" ? record.processId : 0,
    http: typeof record.http === "string" ? record.http : undefined,
    websocket:
      typeof record.websocket === "string" ? record.websocket : undefined,
    socket: typeof record.socket === "string" ? record.socket : undefined,
    pipe: typeof record.pipe === "string" ? record.pipe : undefined,
  };
}

/**
 * Replaces one service's record, leaving every other service untouched.
 * Written 0600 in a 0700 directory, temporary file + rename, so a concurrent
 * reader sees either the old document or the new one.
 */
export function publish(
  path: string,
  service: ServiceName,
  endpoint: ServiceEndpoint,
): void {
  writeService(path, service, endpoint);
}

/**
 * Removes one service's record on a clean shutdown, so a stale address does not
 * outlive the process that owned it.
 */
export function withdraw(path: string, service: ServiceName): void {
  if (!existsSync(path)) return;
  writeService(path, service, undefined);
}

function writeService(
  path: string,
  service: ServiceName,
  endpoint: ServiceEndpoint | undefined,
): void {
  const document = read(path);
  document.version = ENDPOINTS_VERSION;
  document[service] = endpoint;
  writeSecret(path, `${JSON.stringify(serialize(document), null, 2)}\n`);
}

/**
 * The document as it goes on disk: absent transports are omitted rather than
 * written as `null`, and the key order is the Rust struct's, so a diff between
 * a file written by either implementation shows only values.
 */
function serialize(document: EndpointsDocument): Record<string, unknown> {
  const out: Record<string, unknown> = { version: document.version };
  for (const service of [RUNTIME_SERVICE, HOST_SERVICE] as const) {
    const endpoint = document[service];
    if (endpoint === undefined) continue;
    const record: Record<string, unknown> = {
      instanceId: endpoint.instanceId,
      writtenAt: endpoint.writtenAt,
      processId: endpoint.processId,
    };
    for (const key of ["http", "websocket", "socket", "pipe"] as const) {
      const value = endpoint[key];
      if (value !== undefined) record[key] = value;
    }
    out[service] = record;
  }
  return out;
}
