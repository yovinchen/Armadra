import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

/**
 * The concurrency gate: only one host per user, per data directory, per
 * protocol major.
 *
 * ## What the Rust host used, and what is available here
 *
 * `ServerOptions::first_pipe_instance(true)` made the question atomic and
 * free: the second host's `CreateNamedPipe` failed with `ERROR_ACCESS_DENIED`
 * and that process left. libuv sets `FILE_FLAG_FIRST_PIPE_INSTANCE` too, so
 * `net.Server#listen` on a name another process already serves **does** fail
 * with `EADDRINUSE` — that is still the primary gate, and it is checked in
 * `server.ts` where the listen happens.
 *
 * It is not the only gate, for a reason worth stating: that behaviour is
 * libuv's, not Node's documented API, and this host must not be one libuv
 * change away from running twice over one session table. So a lock file backs
 * it up, and the two disagree in only one direction — the lock can say
 * "taken" when the pipe is free, never the reverse — which is the safe one.
 *
 * ## Staleness
 *
 * A lock file outlives a host that was killed, so it cannot be trusted on its
 * own. It is trusted only when the pipe it names **answers**: a live pipe is
 * a live host, and a lock naming a pipe nobody serves is debris from a crash
 * and is taken over. The pid in the file is for a person reading a log, not
 * for a liveness check — pids are reused, and checking one would be the kind
 * of "probably fine" this file exists to avoid.
 */

export const LOCK_FILE = "session-host.lock";

/** How long the liveness probe waits for the pipe to accept a connection. */
const PROBE_TIMEOUT_MS = 750;

export interface LockRecord {
  readonly pid: number;
  readonly endpoint: string;
  readonly startedAt: number;
}

export type Claim =
  | { readonly kind: "granted"; readonly tookOverStaleLock: boolean }
  | { readonly kind: "taken"; readonly held: LockRecord };

export function lockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILE);
}

/** Whether something is serving `endpoint` right now. */
export function probe(
  endpoint: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    const socket = connect(endpoint);
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Takes the lock, or reports who holds it.
 *
 * `connectivity` is injected so the decision can be tested on a machine with
 * no named pipes at all: the whole point of the function is what it does with
 * a *yes* and with a *no*.
 */
export async function claimLock(
  dataDir: string,
  endpoint: string,
  connectivity: (endpoint: string) => Promise<boolean> = probe,
): Promise<Claim> {
  const path = lockPath(dataDir);
  const record: LockRecord = {
    pid: process.pid,
    endpoint,
    startedAt: Date.now(),
  };
  try {
    writeFileSync(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    return { kind: "granted", tookOverStaleLock: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const held = readLock(path);
  // An unreadable lock is debris, not a claim: nothing can be concluded from
  // it, and refusing to start because of a truncated file would make a crash
  // permanent.
  if (held !== undefined && (await connectivity(held.endpoint))) {
    return { kind: "taken", held };
  }
  // Written through a temporary file and renamed, so a third process reading
  // the lock never sees it half replaced.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
  renameSync(temporary, path);
  return { kind: "granted", tookOverStaleLock: true };
}

export function readLock(path: string): LockRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<LockRecord>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.endpoint !== "string" ||
      parsed.endpoint === ""
    ) {
      return undefined;
    }
    return {
      pid: parsed.pid,
      endpoint: parsed.endpoint,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Drops the lock on the way out, but only if it is still this process'.
 *
 * A host that took over a stale lock and was itself replaced must not delete
 * its successor's claim on its way to the exit.
 */
export function releaseLock(dataDir: string): void {
  const path = lockPath(dataDir);
  if (readLock(path)?.pid !== process.pid) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // Someone else won the race to remove it. Nothing here to repair.
  }
}
