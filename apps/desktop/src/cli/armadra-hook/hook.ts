/**
 * Hook mode: `armadra-hook <agentId>` with the CLI's hook payload on stdin.
 *
 * Hook mode is on the hot path of every event an agent CLI emits, so it is
 * written to be boring: it never fails loudly, never blocks longer than its
 * budget, and never writes to stdout except for a permission decision.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { envVar, isValidNodeId, pendingDir } from "./endpoint.js";
import type { Endpoint } from "./endpoint.js";
import { loadBinding } from "./context-usage.js";
import { canonicalJsonBytes, parseJson } from "./json.js";
import type { JsonValue } from "./json.js";
import { postJsonRequest, send as httpSend } from "./http.js";
import { headersFor, loadSession, send } from "./session.js";
import type { Session } from "./session.js";
import { HOOK_PROTOCOL_VERSION, MAX_PAYLOAD_BYTES } from "./usage.js";

/**
 * Exactly the JSON Claude expects back when a hook answers a permission
 * request. Emitted as literal text so key order is guaranteed.
 */
const ALLOW_DECISION =
  '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
const DENY_DECISION =
  '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"由 Armadra 拒绝"}}}';

/** How often the permission answer file is checked. */
const POLL_INTERVAL_MS = 500;
/** How long we wait for the background "answered" report before exiting. */
const ANSWERED_REPORT_TIMEOUT_MS = 1500;

export type Decision = "allow" | "deny";

export function parseDecision(text: string): Decision | undefined {
  const trimmed = text.trim();
  return trimmed === "allow" || trimmed === "deny" ? trimmed : undefined;
}

/** The exact stdout Claude parses. */
export function decisionOutput(decision: Decision): string {
  return decision === "allow" ? ALLOW_DECISION : DENY_DECISION;
}

/**
 * Runs hook mode. Always returns 0 — the caller is an agent CLI and a canvas
 * problem must never surface as a hook failure.
 */
export async function run(agentId: string): Promise<number> {
  // Gate: outside a canvas node this client is a no-op that still has to
  // consume stdin so the CLI's write side does not see a broken pipe.
  const nodeId = envVar("ARMADRA_NODE_ID");
  if (nodeId === undefined) {
    await drainStdin();
    return 0;
  }

  const binding = loadBinding();
  const { bytes, truncated } = await readStdinCapped();
  const payload = buildPayload(bytes, truncated);

  let session: Session;
  let terminalBinding: JsonValue | undefined;
  if (binding !== undefined) {
    session = binding.session;
    terminalBinding = {
      sessionId: binding.sessionId,
      generation: binding.generation,
      sourceRevision: String(binding.revision),
    };
  } else {
    const loaded = loadSession();
    if ("error" in loaded) {
      debug(loaded.error);
      return 0;
    }
    session = loaded.ok;
  }

  const seconds = permissionWaitSecs(agentId, payload);
  if (seconds !== undefined)
    return runPermissionWait(session, agentId, payload, seconds);

  const body = hookBody(nodeId, payload, undefined, undefined, terminalBinding);
  const outcome = await postHook(session, agentId, body);
  if ("error" in outcome) debug(outcome.error);
  else if (outcome.status !== 204) {
    debug(`hook endpoint answered ${outcome.status}, expected 204`);
  }
  return 0;
}

/** Builds the request body for `POST /hook/<agentId>`. */
export function hookBody(
  nodeId: string,
  payload: JsonValue,
  pendingId?: string,
  answered?: string,
  terminalBinding?: JsonValue,
): Buffer {
  return canonicalJsonBytes({
    nodeId,
    version: HOOK_PROTOCOL_VERSION,
    payload,
    pendingId,
    answered,
    terminalBinding,
  });
}

async function postHook(
  session: Session,
  agentId: string,
  body: Buffer,
): Promise<{ status: number } | { error: string }> {
  const route = `/hook/${percentEncodeSegment(agentId)}`;
  const outcome = await send(session, (current, candidate) =>
    postJsonRequest(route, headersFor(current, candidate), body),
  );
  return "error" in outcome ? outcome : { status: outcome.ok.status };
}

/** Reads stdin with a hard cap, reporting whether anything was dropped. */
export async function readStdinCapped(): Promise<{
  bytes: Buffer;
  truncated: boolean;
}> {
  const chunks: Buffer[] = [];
  let kept = 0;
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      // Keep one byte past the cap so we can tell "exactly at the cap" from
      // "over the cap", but keep consuming either way so the CLI writing the
      // payload never sees EPIPE.
      if (kept <= MAX_PAYLOAD_BYTES) {
        const room = MAX_PAYLOAD_BYTES + 1 - kept;
        const slice = buffer.subarray(0, room);
        chunks.push(slice);
        kept += slice.length;
      }
    }
  } catch {
    return { bytes: Buffer.alloc(0), truncated: false };
  }
  const truncated = total > MAX_PAYLOAD_BYTES;
  const bytes = Buffer.concat(chunks);
  return {
    bytes: truncated ? bytes.subarray(0, MAX_PAYLOAD_BYTES) : bytes,
    truncated,
  };
}

async function drainStdin(): Promise<void> {
  try {
    for await (const _chunk of process.stdin) {
      // Discarded on purpose: the write side must not see a broken pipe.
    }
  } catch {
    // A closed stdin is the normal case outside a hook.
  }
}

/**
 * Turns raw stdin into the `payload` field.
 *
 * Non-JSON input (or input we had to truncate, which cannot be valid JSON any
 * more) is wrapped as `{"raw": "..."}` so the runtime always sees an object.
 */
export function buildPayload(bytes: Buffer, truncated: boolean): JsonValue {
  const text = bytes.toString("utf8");
  if (truncated) return { raw: text, truncated: true };
  try {
    const value = parseJson(text.trim());
    if (value !== null && typeof value === "object") return value;
  } catch {
    // Falls through to the raw wrapper below.
  }
  return { raw: text };
}

/**
 * Returns the wait budget when this invocation should answer a Claude
 * permission request in-hook, otherwise `undefined`.
 */
export function permissionWaitSecs(
  agentId: string,
  payload: JsonValue,
): number | undefined {
  if (agentId !== "claude") return undefined;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return undefined;
  if (
    (payload as Record<string, JsonValue>)["hook_event_name"] !==
    "PermissionRequest"
  ) {
    return undefined;
  }
  const raw = envVar("ARMADRA_PERM_WAIT_SECS");
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const seconds = Number(text);
  return seconds === 0 || seconds > 0xffff_ffff ? undefined : seconds;
}

/**
 * Mints the id that ties a hook invocation to a canvas approval card.
 *
 * Node id plus wall clock plus pid is unique enough: a single node cannot run
 * two hooks in the same millisecond from the same process.
 */
export function pendingId(
  nodeId: string,
  epochMs: number,
  pid: number,
): string {
  return `${nodeId}-${epochMs}-${pid}`;
}

/**
 * Unlike {@link postHook}, this cannot hand the failover loop a single
 * candidate-agnostic closure: the pending request/answer files have to sit
 * next to whichever candidate's endpoint file actually accepts the report,
 * because that is the directory the *answering* runtime watches. So this walks
 * the candidates itself, writing the pending file fresh for each one it tries
 * and removing it the moment that candidate turns out not to be the live one —
 * only a transport failure moves on to the next candidate; an HTTP-level
 * rejection is authoritative and falls back to a plain (non-waiting) report on
 * the spot (§2.5).
 */
async function runPermissionWait(
  session: Session,
  agentId: string,
  payload: JsonValue,
  seconds: number,
): Promise<number> {
  if (!isValidNodeId(session.nodeId)) {
    debug("node id is not filesystem safe; skipping permission wait");
    await postHook(session, agentId, hookBody(session.nodeId, payload));
    return 0;
  }

  const id = pendingId(session.nodeId, Date.now(), process.pid);
  const route = `/hook/${percentEncodeSegment(agentId)}`;
  let lastError = "";

  for (const candidate of session.candidates) {
    const directory = pendingDir(candidate);
    const requestPath = path.join(directory, `${id}.json`);
    const answerPath = path.join(directory, `${id}.answer`);

    const written = writeRequestFile(directory, requestPath, payload);
    if (written !== undefined) {
      debug(written);
      lastError = written;
      continue;
    }

    const body = hookBody(session.nodeId, payload, id);
    const outcome = await httpSend(
      candidate,
      postJsonRequest(route, headersFor(session, candidate), body),
    );
    if ("ok" in outcome && outcome.ok.status === 204) {
      return awaitDecision(
        session,
        candidate,
        agentId,
        payload,
        id,
        requestPath,
        answerPath,
        seconds,
      );
    }
    if ("ok" in outcome) {
      // Reached the runtime and it answered — authoritative, per §2.5. Fall
      // back to a plain report rather than trying another candidate that never
      // saw this pending id.
      removeQuietly(requestPath);
      debug("permission report was rejected by the endpoint");
      await postHook(session, agentId, hookBody(session.nodeId, payload));
      return 0;
    }
    // Transport failure: nothing is listening here, so nothing is watching the
    // pending file we just wrote either.
    removeQuietly(requestPath);
    lastError = outcome.error;
  }
  // Fail open: print nothing and let the CLI fall back to its own interactive
  // prompt. The runtime sweeps orphaned request files.
  debug(lastError);
  return 0;
}

async function awaitDecision(
  session: Session,
  candidate: Endpoint,
  agentId: string,
  payload: JsonValue,
  id: string,
  requestPath: string,
  answerPath: string,
  seconds: number,
): Promise<number> {
  const decision = await pollForAnswer(answerPath, seconds * 1000);
  if (decision === undefined) {
    debug("permission wait timed out");
    return 0;
  }
  removeQuietly(answerPath);
  removeQuietly(requestPath);
  // Report in the background: the decision is already made, so the agent
  // should not wait on the runtime to acknowledge it. Reported on the same
  // candidate the request went to — not a fresh failover search — because that
  // is the runtime that holds the pending record this answers.
  const reported = httpSend(
    candidate,
    postJsonRequest(
      `/hook/${percentEncodeSegment(agentId)}`,
      headersFor(session, candidate),
      hookBody(session.nodeId, payload, id, decision),
    ),
  );
  process.stdout.write(`${decisionOutput(decision)}\n`);
  await withTimeout(reported, ANSWERED_REPORT_TIMEOUT_MS);
  return 0;
}

/**
 * Waits for `work`, but no longer than `ms`. The timer is cleared as soon as
 * `work` settles, so a report that answers in 3 ms does not hold the process
 * open for the rest of the budget.
 */
function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

export async function pollForAnswer(
  file: string,
  budgetMs: number,
): Promise<Decision | undefined> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const decision = parseDecision(fs.readFileSync(file, "utf8"));
      if (decision !== undefined) return decision;
    } catch {
      // Not answered yet.
    }
    const left = deadline - Date.now();
    if (left <= 0) return undefined;
    await delay(Math.min(POLL_INTERVAL_MS, left));
  }
}

/**
 * A referenced timer on purpose: the poll loop is the only thing keeping the
 * process alive between checks, and an unreferenced one lets Node decide there
 * is no work left and exit before the answer lands.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Already gone.
  }
}

/** Writes the 0600 request file, answering with an error message on failure. */
export function writeRequestFile(
  directory: string,
  file: string,
  payload: JsonValue,
): string | undefined {
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    return `cannot create ${directory}: ${message(error)}`;
  }
  restrictDir(directory);
  try {
    // On Windows the ACL inherited from the per-user data directory is the
    // best we can do without extra dependencies.
    const handle = fs.openSync(file, "w", 0o600);
    try {
      fs.writeFileSync(handle, canonicalJsonBytes(payload));
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    return `cannot create ${file}: ${message(error)}`;
  }
  return undefined;
}

function restrictDir(directory: string): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort, exactly as in the Rust client.
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Percent-encodes a single path segment so an odd agent id cannot inject a
 * second path component or a query string.
 */
export function percentEncodeSegment(segment: string): string {
  let out = "";
  for (const byte of Buffer.from(segment, "utf8")) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(character)) out += character;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * Diagnostics go to stderr and only when explicitly asked for; hook stdout is
 * reserved for the permission decision.
 */
export function debug(text: string): void {
  if (envVar("ARMADRA_HOOK_DEBUG") !== undefined) {
    process.stderr.write(`armadra-hook: ${text}\n`);
  }
}
