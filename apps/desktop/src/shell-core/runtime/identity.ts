/**
 * Who the Runtime on our address actually is.
 *
 * ## Only our own Runtime counts as ready
 *
 * The socket lives in the data directory, so exactly one Runtime can hold it —
 * but not necessarily *ours*. A shell that was force-quit leaves its child
 * behind; the next shell starts a Runtime that cannot bind and exits, then
 * health-checks the address and is answered by the orphan. Both report version
 * `0.1.0`, so the old check ("status ok, version matches") adopted a process
 * from a previous release and every route added since came back 404
 * (用户实测反馈 F1).
 *
 * Identity is therefore explicit. The child announces an instance id on its
 * stdout before it binds anything; `/health` reports the same id; the shell
 * accepts the Runtime only when the two agree. Ported from
 * the Rust shell this one replaced.
 */

/**
 * The stdout line the Runtime prints once, before it binds anything. Mirrors
 * `armadra_runtime::instance::ANNOUNCE_PREFIX`; the shell cannot depend on the
 * Runtime crate, so the one line of wire format is repeated here and covered
 * by a test on both sides.
 */
export const ANNOUNCE_PREFIX = "armadra-runtime instance ";

/** How long the shell waits for its own Runtime to answer before giving up. */
export const READY_TIMEOUT_MS = 10_000;
export const PROBE_INTERVAL_MS = 250;

/**
 * How long a stale Runtime gets to release the address after being asked to
 * stop. It drains HTTP, detaches tmux and withdraws its endpoint record first.
 */
export const RELEASE_TIMEOUT_MS = 12_000;

/** What `/health` reports, as far as the shell reads it. */
export interface HealthResponse {
  readonly status: string;
  readonly version: string;
  /**
   * Absent from Runtimes built before this check existed — which is exactly
   * the case the check has to catch, so absent never matches.
   */
  readonly instanceId?: string | undefined;
  readonly build?: string | undefined;
}

export function describeHealth(health: HealthResponse): string {
  return `version ${health.version}, build ${health.build ?? "unknown"}, instance ${
    health.instanceId ?? "unreported"
  }`;
}

/** Parses a `/health` body, or `undefined` when it is not one. */
export function parseHealth(body: string): HealthResponse | undefined {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof document !== "object" || document === null) return undefined;
  const record = document as Record<string, unknown>;
  if (typeof record.status !== "string" || typeof record.version !== "string")
    return undefined;
  return {
    status: record.status,
    version: record.version,
    instanceId:
      typeof record.instanceId === "string" ? record.instanceId : undefined,
    build: typeof record.build === "string" ? record.build : undefined,
  };
}

/**
 * Whether a health document came from the child this shell started.
 *
 * Both sides must be present and equal. A Runtime that reports no instance id
 * predates the field, so it cannot be ours; a shell whose child has not
 * announced yet has nothing to compare, so whatever answered is not ours
 * either — and in both cases "not ours" is the safe answer, because adopting
 * the wrong Runtime is the failure this exists to prevent.
 */
export function isOurRuntime(
  expected: string | undefined,
  health: HealthResponse | undefined,
): boolean {
  if (!health || health.status !== "ok") return false;
  return (
    expected !== undefined &&
    health.instanceId !== undefined &&
    expected === health.instanceId
  );
}

/**
 * The instance id in the Runtime's announcement line, or `undefined` for
 * ordinary log output on the same stream.
 */
export function parseAnnouncement(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(ANNOUNCE_PREFIX)) return undefined;
  const id = trimmed.slice(ANNOUNCE_PREFIX.length).split(/\s+/)[0];
  return id ? id : undefined;
}

/**
 * Whether a process command line is an Armadra Runtime a desktop shell started.
 *
 * Both halves are required. The binary name alone would also match a
 * development Runtime somebody is running from a terminal, which is not ours to
 * signal; `--desktop-control-stdin` is only ever passed when the shell spawns
 * the Runtime itself.
 */
export function isDesktopStartedRuntime(
  commandLine: string,
  binaryName = runtimeBinaryName(),
): boolean {
  return (
    commandLine.includes(binaryName) &&
    commandLine.includes("--desktop-control-stdin")
  );
}

export function runtimeBinaryName(platform: string = process.platform): string {
  return platform === "win32" ? "armadra-runtime.exe" : "armadra-runtime";
}

/**
 * Whether this shell starts and owns a Runtime, or attaches to one somebody
 * else is running.
 *
 * A packaged shell always owns its Runtime. A development shell does not,
 * because `armadra.sh` or a bare `cargo run` usually already has one on a
 * loopback port — and killing somebody's development Runtime at quit is not a
 * behaviour a developer can opt out of after the fact. `ARMADRA_DESKTOP_OWNS_RUNTIME=1`
 * is the explicit opt-in, and only the exact string `1` counts.
 */
export function ownsRuntime(
  development: boolean,
  explicitOwnership: string | undefined,
): boolean {
  return !development || explicitOwnership === "1";
}

/**
 * The Runtime's published HTTP and WebSocket bases, from `endpoints.json`.
 *
 * This is how the shell finds a Runtime it did NOT start: the port is
 * kernel-assigned, so the document is the only thing that knows it.
 * `apps/web/vite.config.ts` reads the same file for its dev proxy, so the page
 * and the shell agree on which Runtime is meant. A record naming anything but
 * a loopback HTTP base is refused rather than passed on — the shell must not
 * point the page at a machine nobody asked for.
 */
export function publishedRuntimeBases(
  endpointsJson: string,
): { http: string; websocket: string } | undefined {
  let document: unknown;
  try {
    document = JSON.parse(endpointsJson);
  } catch {
    return undefined;
  }
  const runtime = (document as { runtime?: unknown } | null)?.runtime;
  if (typeof runtime !== "object" || runtime === null) return undefined;
  const record = runtime as Record<string, unknown>;
  if (typeof record.http !== "string") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(record.http);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")
  ) {
    return undefined;
  }
  const websocket =
    typeof record.websocket === "string"
      ? record.websocket
      : parsed.origin.replace(/^http/, "ws");
  return { http: parsed.origin, websocket };
}

/** The address this shell asked the Runtime to listen on. */
export type RuntimeAddress =
  | { readonly kind: "socket"; readonly path: string }
  | { readonly kind: "pipe"; readonly name: string }
  | { readonly kind: "tcp"; readonly authority: string };

export function listenArgument(address: RuntimeAddress): string {
  switch (address.kind) {
    case "socket":
      return `unix:${address.path}`;
    case "pipe":
      return `pipe:${address.name}`;
    case "tcp":
      return `tcp:${address.authority}`;
  }
}

/** One Runtime record out of `endpoints.json`, as far as the shell reads it. */
export interface RuntimeRecord {
  readonly instanceId: string;
  readonly processId: number;
  readonly socket?: string | undefined;
  readonly pipe?: string | undefined;
  readonly http?: string | undefined;
}

/**
 * The published record for the Runtime on `address`, or why there is none.
 *
 * The record has to name the address we are trying to use. Anything else is a
 * Runtime on another data directory, and stopping it would neither free this
 * socket nor be any of our business. Ported from `runtime_process.rs:491-521`.
 */
export function staleRuntimeRecord(
  endpointsJson: string,
  address: RuntimeAddress,
): { ok: true; record: RuntimeRecord } | { ok: false; reason: string } {
  let document: unknown;
  try {
    document = JSON.parse(endpointsJson);
  } catch (error) {
    return {
      ok: false,
      reason: `endpoints.json did not parse: ${error instanceof Error ? error.message : error}`,
    };
  }
  const runtime = (document as { runtime?: unknown } | null)?.runtime;
  if (typeof runtime !== "object" || runtime === null) {
    return { ok: false, reason: "endpoints.json names no Runtime" };
  }
  const raw = runtime as Record<string, unknown>;
  const record: RuntimeRecord = {
    instanceId: typeof raw.instanceId === "string" ? raw.instanceId : "",
    processId: typeof raw.processId === "number" ? raw.processId : 0,
    socket: typeof raw.socket === "string" ? raw.socket : undefined,
    pipe: typeof raw.pipe === "string" ? raw.pipe : undefined,
    http: typeof raw.http === "string" ? raw.http : undefined,
  };
  const holds =
    address.kind === "socket"
      ? record.socket === address.path
      : address.kind === "pipe"
        ? record.pipe === address.name
        : record.http === `http://${address.authority}`;
  if (!holds) {
    return {
      ok: false,
      reason: `the published Runtime record is for another address, not ${listenArgument(address)}`,
    };
  }
  // A pid of 0 or 1 is not a process we may signal — it is init, or a record
  // written before the Runtime knew its own pid.
  if (record.processId <= 1) {
    return {
      ok: false,
      reason: "the published Runtime record has no usable process id",
    };
  }
  return { ok: true, record };
}

export function foreignRuntimeError(
  health: HealthResponse,
  reason: string,
): string {
  return (
    `Another Armadra Runtime (${describeHealth(health)}) is using this data directory and ` +
    `could not be stopped: ${reason}. Quit the other Armadra, or end that process, and ` +
    `start Armadra again.`
  );
}
