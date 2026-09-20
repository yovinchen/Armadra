/**
 * Claude status-line bridge. Only numeric context metadata leaves this
 * process. Sequence allocation happens before stdin consumption; network
 * arrival order and wall-clock adjustments cannot replace a newer observation
 * with an old one.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { envVar, isValidNodeId, nodeToken } from "./endpoint.js";
import {
  asNumber,
  asObject,
  asString,
  canonicalJsonBytes,
  parseJson,
} from "./json.js";
import type { JsonValue } from "./json.js";
import { postJsonRequest } from "./http.js";
import { headersFor, loadSession, send } from "./session.js";
import type { Session } from "./session.js";
import { MAX_PAYLOAD_BYTES } from "./usage.js";

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

/**
 * What this command prints, which is what Claude draws as the status line.
 *
 * Only the node's name, and only when the node has one: the status line is a
 * single line of the user's own screen, so it gets the one fact the model and
 * the user both need and nothing else. An unnamed node prints nothing, which
 * is the same blank line this command has always produced.
 *
 * This is **our** status line — `hook/install/claude.ts` writes it only when
 * the user has none of their own, and a foreign one is never wrapped. So
 * appending here cannot touch a line somebody else wrote.
 */
export function statusLine(name: string | undefined): string {
  const handle = name?.trim() ?? "";
  // Re-validated rather than trusted: this is an environment variable, and a
  // control character in it would move the cursor rather than read as a name.
  if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(handle)) return "";
  return `@${handle}`;
}

export async function run(): Promise<number> {
  const line = statusLine(envVar("ARMADRA_NODE_NAME"));
  if (line !== "") process.stdout.write(`${line}\n`);
  // Always drain stdin, including outside Armadra and on any local failure.
  const binding = loadBinding();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total <= MAX_PAYLOAD_BYTES + 1) chunks.push(buffer);
    }
  } catch {
    return 0;
  }
  if (total > MAX_PAYLOAD_BYTES) return 0;
  if (binding === undefined) return 0;
  const parsed = tryParse(Buffer.concat(chunks).toString("utf8"));
  const data = parsed === undefined ? undefined : filterData(parsed);
  if (data === undefined) return 0;
  const body = canonicalJsonBytes({
    nodeId: binding.session.nodeId,
    version: 1,
    payload: {
      armadraContextUsage: {
        sessionId: binding.sessionId,
        generation: binding.generation,
        sourceRevision: binding.revision.toString(),
        data,
      },
    },
  });
  await send(binding.session, (current, candidate) =>
    postJsonRequest("/hook/claude", headersFor(current, candidate), body),
  );
  return 0;
}

function tryParse(text: string): JsonValue | undefined {
  try {
    return parseJson(text);
  } catch {
    return undefined;
  }
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

/**
 * Deliberately excludes transcript paths, workspace paths, costs, tools,
 * prompts and account limits. Missing current usage is forwarded as null.
 */
export function filterData(input: JsonValue): JsonValue | undefined {
  const root = asObject(input);
  if (root === undefined) return undefined;
  const text = (
    value: Record<string, JsonValue> | undefined,
    key: string,
  ): string | undefined => {
    const field = asString(value?.[key]);
    if (field === undefined || field === "") return undefined;
    if (Buffer.byteLength(field, "utf8") > 200) return undefined;
    // `char::is_control` on the Rust side: the Unicode Cc category.
    if (/[\u0000-\u001f\u007f-\u009f]/.test(field)) return undefined;
    return field;
  };
  const sessionId = text(root, "session_id");
  if (sessionId === undefined) return undefined;
  const model = text(asObject(root["model"]), "id");
  if (model === undefined) return undefined;
  const window = asObject(root["context_window"]);
  if (window === undefined) return undefined;
  const hasCurrent = "current_usage" in window;
  const current = asObject(window["current_usage"]);

  let usage: JsonValue;
  if (!hasCurrent || window["current_usage"] === null) {
    usage = null;
  } else {
    if (current === undefined) return undefined;
    const count = (key: string): number | undefined => {
      const value = asNumber(current[key]);
      if (value === undefined || !Number.isInteger(value) || value < 0)
        return undefined;
      return BigInt(value) <= MAX_COUNT ? value : undefined;
    };
    const input_tokens = count("input_tokens");
    const cache_creation_input_tokens = count("cache_creation_input_tokens");
    const cache_read_input_tokens = count("cache_read_input_tokens");
    if (
      input_tokens === undefined ||
      cache_creation_input_tokens === undefined ||
      cache_read_input_tokens === undefined
    ) {
      return undefined;
    }
    usage = {
      input_tokens,
      cache_creation_input_tokens,
      cache_read_input_tokens,
    };
  }

  const size = asNumber(window["context_window_size"]);
  const contextWindowSize =
    size !== undefined &&
    Number.isInteger(size) &&
    size > 0 &&
    BigInt(size) <= MAX_COUNT
      ? size
      : null;
  const contextWindow: Record<string, JsonValue> = {
    context_window_size: contextWindowSize,
  };
  if (hasCurrent) contextWindow["current_usage"] = usage;
  return {
    session_id: sessionId,
    model: { id: model },
    context_window: contextWindow,
  };
}
