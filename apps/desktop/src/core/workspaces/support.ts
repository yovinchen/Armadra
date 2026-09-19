import { randomBytes } from "node:crypto";
import { type ErrorResponse, coreError } from "../http/errors";

/**
 * The vocabulary the three canvas-side domains share: the failure type, the
 * identifiers rows are minted with, and the timestamp spelling.
 *
 * It lives under `workspaces/` because that is the domain the other two hang
 * off — a board belongs to a workspace and an asset is stored beside one — and
 * a fourth module holding three functions would only add a place to look.
 */

/**
 * A refusal, carrying the status and the `code` the Rust Runtime answers with.
 *
 * The codes are not re-invented here: `apps/runtime/src/error.rs` maps its
 * variants onto exactly these strings, the front end switches on them, and the
 * zod schemas in `packages/shared` are written against the `{ code, message }`
 * pair. In particular a 500 is `internal_error`, not `internal`.
 */
export class DomainError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.code = code;
  }

  response(): ErrorResponse {
    return coreError(this.status, this.code, this.message);
  }
}

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
 * A UUIDv7, because `Uuid::now_v7()` is what the Rust rows are minted with.
 *
 * `crypto.randomUUID()` would be a v4 and would pass every schema, but it
 * would also throw away the ordering the version exists for: boards and nodes
 * are read back `ORDER BY created_at`, and ids that sort with time keep that
 * read stable when two rows share a millisecond.
 */
export function uuidV7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

let lastIssued = 0;

/**
 * `chrono::Utc::now().to_rfc3339()`, as closely as a millisecond clock can
 * spell it: a numeric `+00:00` offset rather than `Z`, and the fraction
 * omitted entirely when it is zero — which is what `SecondsFormat::AutoSi`
 * does.
 *
 * The strictly-increasing guard is the CAS contract, not tidiness. A board's
 * `updated_at` **is** its revision: `PUT …/document` matches the caller's
 * `expectedUpdatedAt` against the stored string, and two saves landing in the
 * same millisecond would mint the same revision — so the second client's stale
 * token would still match and its write would silently win. Rust never reaches
 * this because its clock has nanoseconds; here the tick stands in for them.
 */
export function rfc3339(at: number = Date.now()): string {
  const stamp = at > lastIssued ? at : lastIssued + 1;
  lastIssued = stamp;
  const date = new Date(stamp);
  const base = date.toISOString().slice(0, 19);
  const millis = date.getUTCMilliseconds();
  const fraction = millis === 0 ? "" : `.${String(millis).padStart(3, "0")}`;
  return `${base}${fraction}+00:00`;
}

/** Whether `value` parses as an RFC 3339 timestamp, the way `chrono` asks. */
export function isRfc3339(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && !Number.isNaN(Date.parse(value))
  );
}

const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** `Uuid::parse_str` accepts the hyphenated form; so does everything here. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** `#RRGGBB`, the only colour spelling a workspace or a node may carry. */
export function isHexColor(color: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(color);
}

/** The JSON body of a request, refused as a 400 rather than a crash. */
export function jsonBody(body: Buffer): unknown {
  if (body.byteLength === 0) return {};
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw badRequest("Request body is not valid JSON");
  }
}

/** A plain object, or the 400 every handler would otherwise repeat. */
export function jsonObject(body: Buffer): Record<string, unknown> {
  const parsed = jsonBody(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** An optional string field, refused when present but not a string. */
export function optionalString(
  source: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = source[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw badRequest(`${name} must be a string`);
  return value;
}

/** A required string field. */
export function requiredString(
  source: Record<string, unknown>,
  name: string,
): string {
  const value = optionalString(source, name);
  if (value === undefined) throw badRequest(`${name} is required`);
  return value;
}
