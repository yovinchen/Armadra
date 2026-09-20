/**
 * The `terminalBinding` a hook report carries: which terminal session and
 * generation it belongs to, and a strictly increasing revision within them.
 *
 * Sequence allocation happens before stdin is consumed, so network arrival
 * order and wall-clock adjustments can never let an old observation replace a
 * newer one.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { envVar, isValidNodeId, nodeToken } from "./endpoint.js";
import { loadSession } from "./session.js";
import type { Session } from "./session.js";

const MAX_COUNT = 9_007_199_254_740_991n;

/** How long a caller will wait for another hook to release the sequence. */
const LOCK_DEADLINE_MS = 500;
/**
 * A lock is held for a single read-modify-write, so one older than this was
 * left behind by a process that died mid-update and must not wedge the next
 * hook. Node has no `flock`, which is what the Rust client uses; an exclusive
 * `O_EXCL` sidecar with a staleness bound is the portable equivalent.
 */
const LOCK_STALE_MS = 5_000;

export interface Binding {
  session: Session;
  sessionId: string;
  generation: number;
  revision: bigint;
}

export function loadBinding(): Binding | undefined {
  const loaded = loadSession();
  if ("error" in loaded) return undefined;
  const session = loaded.ok;
  // The sequence file has to live at one fixed path for the life of a
  // generation, so it is anchored to the first (preferred) candidate rather
  // than whichever one a later `send` happens to succeed through.
  const primary = session.candidates[0];
  if (primary === undefined) return undefined;
  if (nodeToken(primary, session.nodeId) === undefined) return undefined;
  const sessionId = envVar("ARMADRA_SESSION_ID");
  if (sessionId === undefined || !isValidNodeId(sessionId)) return undefined;
  const rawGeneration = envVar("ARMADRA_SESSION_GENERATION");
  if (rawGeneration === undefined || !/^\d+$/.test(rawGeneration))
    return undefined;
  const generation = BigInt(rawGeneration);
  if (generation > MAX_COUNT) return undefined;

  const directory = path.join(path.dirname(primary.path), "context-sequences");
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(directory);
  } catch {
    return undefined;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    return undefined;

  try {
    const revision = nextRevision(
      path.join(directory, `${sessionId}-${generation}.seq`),
    );
    return { session, sessionId, generation: Number(generation), revision };
  } catch {
    return undefined;
  }
}

/**
 * Corrupt files are never reset to zero: doing so could make delayed old
 * reports look newer after a crash. The runtime initialises this exact
 * generation once before spawning the PTY, so a removed file is not permission
 * to reset an active generation either — the file is opened, never created.
 */
export function nextRevision(file: string): bigint {
  let stats: fs.Stats | undefined;
  try {
    stats = fs.lstatSync(file);
  } catch {
    stats = undefined;
  }
  if (stats !== undefined && (!stats.isFile() || stats.isSymbolicLink())) {
    throw new Error("invalid context sequence file");
  }
  const release = acquireLock(file);
  try {
    const handle = fs.openSync(file, "r+");
    try {
      if (fs.fstatSync(handle).size !== 16)
        throw new Error("corrupt context sequence");
      const buffer = Buffer.alloc(16);
      fs.readSync(handle, buffer, 0, 16, 0);
      const count = buffer.readBigUInt64BE(0);
      const inverse = buffer.readBigUInt64BE(8);
      if (count !== (~inverse & 0xffff_ffff_ffff_ffffn)) {
        throw new Error("corrupt context sequence");
      }
      const next = count + 1n;
      if (next > 0xffff_ffff_ffff_ffffn)
        throw new Error("context sequence exhausted");
      const out = Buffer.alloc(16);
      out.writeBigUInt64BE(next, 0);
      out.writeBigUInt64BE(~next & 0xffff_ffff_ffff_ffffn, 8);
      fs.writeSync(handle, out, 0, 16, 0);
      fs.fdatasyncSync(handle);
      return next;
    } finally {
      fs.closeSync(handle);
    }
  } finally {
    release();
  }
}

/**
 * A bounded exclusive lock, so a hook never hangs a CLI on a stuck holder —
 * but wide enough for the holders that are merely slow.
 */
function acquireLock(file: string): () => void {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx", 0o600));
      return () => {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // Another holder already stole it; nothing left to release.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() >= deadline) {
      // Distinguishable, so a caller that can afford to try again knows this
      // was contention and not a broken file.
      const error = new Error(
        "context sequence is held by another hook",
      ) as NodeJS.ErrnoException;
      error.code = "EWOULDBLOCK";
      throw error;
    }
    sleepBriefly();
  }
}

/** A 5 ms spin without an event-loop turn; `nextRevision` is synchronous. */
function sleepBriefly(): void {
  const until = Date.now() + 5;
  while (Date.now() < until) {
    // Busy wait: the hold time is microseconds, so this never runs long.
  }
}
