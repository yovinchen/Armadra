/**
 * `browser:drive` — the one channel between the Runtime and this shell.
 *
 * Direction and division of labour (electron-migration.md §4.2):
 *
 *   armadra-hook browser <verb>
 *     -> Runtime POST /browser/{verb}        authorization + lease, IN THE RUNTIME
 *     -> browser:drive  { id, nodeId, verb, args }
 *          -> shell: guest registry -> CDP allowlist -> guest
 *     <- { id, ok, result | error: { code, message } }
 *
 * The payload is a VERB, never a CDP method name. That is the whole seam: the
 * Runtime decides who may act, the shell decides what a verb is allowed to do
 * to a page, and neither can be talked into the other's job. A Runtime that has
 * been convinced to send a CDP method name has sent a verb that does not exist,
 * and gets `browser_unknown_verb` — there is no spelling of "evaluate this"
 * that this channel carries.
 *
 * The transport is a loopback WebSocket the SHELL listens on and the RUNTIME
 * dials, with a one-time token handed over in the Runtime's spawn environment
 * (`ARMADRA_SHELL_DRIVE_WS`, `ARMADRA_SHELL_DRIVE_TOKEN`). The shell dials
 * nothing and the token never touches the disk: it exists for one shell run,
 * in the environment of one child process.
 */

import { timingSafeEqual } from "node:crypto";

/** The path the drive server listens on. Nothing else on that port answers. */
export const DRIVE_PATH = "/browser/drive";

/** Environment names, read by `main/runtime-process.ts` when it spawns. */
export const DRIVE_ADDRESS_ENV = "ARMADRA_SHELL_DRIVE_WS";
export const DRIVE_TOKEN_ENV = "ARMADRA_SHELL_DRIVE_TOKEN";

/** Longest a client may take to present its token before it is closed. */
export const HELLO_TIMEOUT_MS = 5_000;

/** Longest one verb may occupy the shell. A verb that needs longer is a verb
 * that has lost its page. */
export const VERB_TIMEOUT_MS = 45_000;

/** The seventeen. Identical to the Runtime's `VERBS` and the hook's
 * `BROWSER_VERBS`; the drive channel checks it again because a verb name is the
 * first thing that decides what happens to somebody's logged-in page. */
export const DRIVE_VERBS: readonly string[] = Object.freeze([
  "navigate",
  "read",
  "click",
  "type",
  "wait",
  "capture",
  "select",
  "press",
  "scroll",
  "upload",
  "download",
  "back",
  "forward",
  "close",
  "tabs",
  "dialog",
  "lease",
]);

export interface DriveRequest {
  readonly id: string;
  readonly nodeId: string;
  readonly verb: string;
  readonly args: Record<string, unknown>;
}

export interface DriveError {
  readonly code: string;
  readonly message: string;
}

export type DriveResponse =
  | { readonly id: string; readonly ok: true; readonly result: unknown }
  | { readonly id: string; readonly ok: false; readonly error: DriveError };

/** Something the shell noticed and the Runtime should know about: a guest
 * navigated, a person touched a page, a guest went away. */
export interface DriveEvent {
  readonly type: "event";
  readonly event: string;
  readonly nodeId: string;
  readonly [field: string]: unknown;
}

/** Stable codes. The Runtime maps them onto its own prose. */
export const DRIVE_CODES = Object.freeze({
  /** No shell is connected. Produced by the RUNTIME, never sent over the wire. */
  unavailable: "browser_unavailable",
  notDrivable: "browser_not_drivable",
  discarded: "browser_discarded",
  staleRef: "browser_stale_ref",
  notFound: "browser_not_found",
  refused: "browser_refused",
  badArgument: "browser_bad_argument",
  unknownVerb: "browser_unknown_verb",
  timeout: "browser_timeout",
  failed: "browser_failed",
});

export function driveError(code: string, message: string): DriveError {
  return { code, message };
}

/**
 * Validates one request off the wire. The shell trusts the Runtime to have
 * authorized the caller; it does not trust the Runtime to have sent
 * well-formed JSON, because the two are separate processes and only one of
 * them is this one.
 */
export function parseDriveRequest(
  raw: unknown,
): { ok: true; request: DriveRequest } | { ok: false; error: DriveError } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: driveError(DRIVE_CODES.badArgument, "malformed request") };
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 64) {
    return { ok: false, error: driveError(DRIVE_CODES.badArgument, "missing request id") };
  }
  if (typeof value.nodeId !== "string" || value.nodeId.length === 0) {
    return { ok: false, error: driveError(DRIVE_CODES.badArgument, "missing node id") };
  }
  if (typeof value.verb !== "string" || !DRIVE_VERBS.includes(value.verb)) {
    return {
      ok: false,
      error: driveError(DRIVE_CODES.unknownVerb, "that is not a browser verb"),
    };
  }
  const args = value.args;
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    return { ok: false, error: driveError(DRIVE_CODES.badArgument, "args must be an object") };
  }
  return {
    ok: true,
    request: {
      id: value.id,
      nodeId: value.nodeId,
      verb: value.verb,
      args: (args as Record<string, unknown> | undefined) ?? {},
    },
  };
}

/**
 * The token check.
 *
 * Constant time, and length-guarded first: `timingSafeEqual` throws on a length
 * mismatch, and letting that throw would leak the length through the
 * difference between an exception and a false.
 */
export function tokenMatches(expected: string, presented: unknown): boolean {
  if (typeof presented !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The address written into the Runtime's environment. */
export function driveAddress(port: number): string {
  return `ws://127.0.0.1:${port}${DRIVE_PATH}`;
}
