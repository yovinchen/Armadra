import { createHash } from "node:crypto";
import { DomainError } from "../workspaces/support";

/**
 * The vocabulary every Git module shares: the refusals, the object-id shape and
 * the two text scrubbers a Git message has to go through before it is logged or
 * answered.
 *
 * A direct port of the small helpers scattered through `apps/runtime/src/git/`
 * — `malformed()`, `invalid_cursor()`, `valid_oid()`, `command::sanitize()` and
 * `security::redact_secrets()`. They live together here because every other
 * file in this directory needs at least two of them, and because the error
 * *codes* are contractual: `apps/runtime/src/error.rs` maps `AppError` onto
 * exactly these strings and the front end switches on them.
 */

export const badRequest = (message: string): DomainError =>
  new DomainError(400, "bad_request", message);
export const forbidden = (message: string): DomainError =>
  new DomainError(403, "forbidden", message);
export const notFound = (message: string): DomainError =>
  new DomainError(404, "not_found", message);
export const conflict = (message: string): DomainError =>
  new DomainError(409, "conflict", message);
export const internalError = (message: string): DomainError =>
  new DomainError(500, "internal_error", message);

/**
 * `AppError::GitExecutionRequired` — 403 with its own code, because the panel
 * offers a different repair for it than for a plain refusal: the workspace can
 * be granted execution.
 */
export const gitExecutionRequired = (message: string): DomainError =>
  new DomainError(403, "git_execution_required", message);

/**
 * `AppError::InvalidCursor` — 409. Named apart from a bad request because the
 * client's repair is automatic and identical every time: drop the cursor and
 * read the first page.
 */
export const invalidCursor = (message: string): DomainError =>
  new DomainError(409, "invalid_cursor", message);

/** `git::access::require_execution`. */
export function requireExecution(allowed: boolean, purpose: string): void {
  if (allowed) return;
  throw gitExecutionRequired(
    `${purpose} requires workspace execution permission: Git can run repository filters, hooks, or transport helpers`,
  );
}

export function malformed(): DomainError {
  return internalError(
    "Git returned unsupported or malformed machine-readable output",
  );
}

export function cursorRefused(): DomainError {
  return invalidCursor(
    "The cursor does not match this repository or reference; reload the first page",
  );
}

export function logCursorRefused(): DomainError {
  return invalidCursor(
    "The log cursor does not match these filters; reload the first page",
  );
}

export function shuttingDown(): DomainError {
  return conflict("Git repository service is shutting down");
}

/** SHA-1 (40) or SHA-256 (64) hex, the two object-id widths Git produces. */
/**
 * `unknown` rather than `string` on purpose: a repository action reaches the
 * validators exactly as it arrived on the wire — the shared zod schema runs in
 * the browser, not here — so a field the caller left out arrives as
 * `undefined`. Reading `.length` off it is a TypeError the router can only
 * report as a core failure; answering `false` makes it the 400 it is.
 */
export function validOid(oid: unknown): boolean {
  return (
    typeof oid === "string" &&
    (oid.length === 40 || oid.length === 64) &&
    /^[0-9a-fA-F]+$/.test(oid)
  );
}

export function requireOid(oid: unknown): void {
  if (!validOid(oid)) {
    throw badRequest("Expected commit must be an object ID");
  }
}

/** A 64-character hex digest: a state token, a diff digest or a hunk id. */
export function isDigest(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length === 64 &&
    /^[0-9a-fA-F]+$/.test(value)
  );
}

export function sha256Hex(...parts: (string | Uint8Array)[]): string {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part);
  return digest.digest("hex");
}

/** `hash_field`: length-prefixed, so two fields cannot be confused for one. */
export function hashField(
  digest: ReturnType<typeof createHash>,
  bytes: Uint8Array | string,
): void {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(buffer.byteLength));
  digest.update(length);
  digest.update(buffer);
}

const ASSIGNMENTS =
  /(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|password|token|secret)\s*[:=]\s*([^\s,;]+)/gi;
const BEARER = /(Authorization\s*:\s*Bearer\s+)(\S+)/gi;

/** `security::redact_secrets`. */
export function redactSecrets(input: string): string {
  return input
    .replace(ASSIGNMENTS, "$1=[REDACTED]")
    .replace(BEARER, "$1[REDACTED]");
}

const CREDENTIAL_URL = /(https?|ssh):\/\/[^/\s@]+@/gi;
const AUTH_HEADER = /(authorization\s*[:=]\s*(?:basic|bearer)\s+)[^\s,;]+/gi;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * `git::command::sanitize` — the strict one, used on anything that came out of
 * a Git child. Credentials in a URL, an `Authorization` header and every
 * control character except newline and tab are removed, and the result is cut
 * at 8 KiB.
 */
export function sanitize(message: string): string {
  return redactSecrets(message)
    .replace(CREDENTIAL_URL, "$1://[redacted]@")
    .replace(AUTH_HEADER, "$1[redacted]")
    .replace(CONTROL, "")
    .slice(0, 8192);
}

/**
 * `git::repository::command::sanitize` — the repository service's own, which
 * keeps control characters (its callers put the text in a JSON message, never
 * on a terminal) and cuts at the same ceiling.
 */
export function sanitizeRepository(message: string): string {
  return redactSecrets(message)
    .replace(CREDENTIAL_URL, "$1://[redacted]@")
    .slice(0, 8192);
}

/** `chrono::Utc::now().to_rfc3339()` with the offset spelling Rust uses. */
export function nowRfc3339(at: number = Date.now()): string {
  const date = new Date(at);
  const millis = date.getUTCMilliseconds();
  const fraction = millis === 0 ? "" : `.${String(millis).padStart(3, "0")}`;
  return `${date.toISOString().slice(0, 19)}${fraction}+00:00`;
}

/** The trailing newline Git puts after a one-line answer, removed. */
export function oneLine(bytes: Buffer): string {
  const value = bytes.toString("utf8");
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

/** Split NUL-separated output, dropping the empty tail Git leaves behind. */
export function nulFields(bytes: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      fields.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < bytes.length) fields.push(bytes.subarray(start));
  return fields;
}

/** A base64url payload without padding — how every cursor travels. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor<T>(cursor: string, refuse: () => Error): T {
  let text: string;
  try {
    text = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw refuse();
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw refuse();
  }
}

/**
 * A comma-separated query parameter as a pathspec list.
 *
 * Empty entries are dropped rather than passed on, because an empty pathspec
 * matches everything and would silently widen the filter it was meant to
 * narrow.
 */
export function commaPaths(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path !== "");
}

export function nonempty(value: string): string | null {
  return value === "" ? null : value;
}

/**
 * Whether `value` holds any control character.
 *
 * Every name Git accepts — a branch, a tag, a remote, a ref — is checked with
 * this before it becomes an argument, because a control character in one of
 * them is the shape that turns a single argument into two.
 */
export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER.test(value);
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
