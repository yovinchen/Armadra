import { randomBytes } from "node:crypto";

/**
 * What a collaboration verb says when it says no, and the loosely typed `args`
 * object every verb reads its flags out of.
 *
 * Ported from the pre-merge implementation. Two refusal shapes, not one,
 * and the distinction is the same one the Rust module draws:
 *
 *   * {@link Refusal} carries a status and one sentence. The context-link
 *     surface answers `text/plain` and the client prints the body verbatim, so
 *     a refusal there has to *be* a readable sentence and nothing else.
 *   * {@link Refused} carries the stable `code` a JSON caller branches on.
 *     "Which agent did you mean?" is a question a client can act on — retry
 *     with an id, draw a link, pick a new handoff key — and prose is not
 *     something it can switch over.
 *
 * A `Refusal` falls back to the code its status implies, which is why every
 * verb can keep returning the simpler one.
 */

export class Refusal extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "Refusal";
    this.status = status;
  }

  static badRequest(message: string): Refusal {
    return new Refusal(400, message);
  }

  static forbidden(message: string): Refusal {
    return new Refusal(403, message);
  }

  static notFound(message: string): Refusal {
    return new Refusal(404, message);
  }

  static conflict(message: string): Refusal {
    return new Refusal(409, message);
  }

  static internal(message: string): Refusal {
    return new Refusal(500, message);
  }
}

/** A refusal that already knows the code a caller branches on. */
export class Refused extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * Extra machine-readable fields the refusal body carries beside
   * `{code, message}` — `retryable`, `retryAfterMs`, the source chain that
   * closed a loop.
   *
   * A caller that has to parse a sentence to learn how long to back off does
   * not have a backoff, it has a guess. `send` is the first verb with codes
   * that carry a number (§3.5 的 `RATE_LIMITED`), so the slot lives here
   * rather than in that one verb.
   */
  readonly detail?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "Refused";
    this.status = status;
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }

  /** The code a bare {@link Refusal}'s status implies. */
  static from(refusal: Refusal): Refused {
    const code =
      {
        400: "bad_request",
        403: "forbidden",
        404: "not_found",
        409: "conflict",
        429: "too_many_requests",
      }[refusal.status] ?? "internal_error";
    return new Refused(refusal.status, code, refusal.message);
  }
}

/** Turns anything thrown inside a verb into the refusal the caller reads. */
export function asRefused(error: unknown): Refused {
  if (error instanceof Refused) return error;
  if (error instanceof Refusal) return Refused.from(error);
  const message = error instanceof Error ? error.message : String(error);
  return new Refused(500, "internal_error", `画布操作失败：${message}`);
}

/* ------------------------------- request shape ---------------------------- */

/**
 * `{nodeId, args}` — the body every control route takes. Bare flags arrive as
 * `true`, `--flag value` as strings, repeated flags as arrays.
 */
export interface ControlRequestBody {
  readonly nodeId: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** Typed reads over the loosely typed `args` object. */
export class Args {
  constructor(
    private readonly source: Readonly<Record<string, unknown>> = {},
  ) {}

  /**
   * A flag's string value. A bare flag (`true`) is deliberately not a string:
   * `--title` with no value must not silently become "true".
   */
  text(name: string): string | undefined {
    const value = this.source[name];
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed === "" ? undefined : trimmed;
    }
    // A repeated flag keeps its first value for single-valued reads.
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry !== "string") continue;
        const trimmed = entry.trim();
        if (trimmed !== "") return trimmed;
      }
    }
    return undefined;
  }

  /**
   * A bare flag arrives as `true`; `--flag=true` and friends are accepted too.
   * A flag carrying any other value is *not* a boolean — reading
   * `--title Build` as `flag("title") === true` is how a typo becomes a
   * surprise dry run.
   */
  flag(name: string): boolean {
    const value = this.source[name];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
    }
    return false;
  }

  /** `-n` / `--lines`, clamped by the caller. */
  count(names: readonly string[]): number | undefined {
    for (const name of names) {
      const value = this.source[name];
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.trunc(value);
      }
      if (typeof value === "string") {
        const parsed = Number.parseInt(value.trim(), 10);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return undefined;
  }

  /**
   * A repeatable flag whose values may themselves contain commas — a task
   * text, say — so each occurrence is kept whole.
   */
  all(name: string): string[] {
    const value = this.source[name];
    const values = Array.isArray(value) ? value : [value];
    return values
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  }

  /** A repeatable flag, also accepting one comma-separated value. */
  list(name: string): string[] {
    const out: string[] = [];
    const push = (value: string): void => {
      for (const part of value.split(",")) {
        const trimmed = part.trim();
        if (trimmed !== "") out.push(trimmed);
      }
    };
    const value = this.source[name];
    if (typeof value === "string") push(value);
    else if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === "string") push(entry);
    }
    return out;
  }
}

/* --------------------------------- helpers -------------------------------- */

/**
 * Header fields must not be able to forge a frame line, so anything that looks
 * like a line break becomes a space.
 */
export function collapseNewlines(value: string): string {
  return value
    .replace(/[\r\n]/g, " ")
    .trim()
    .split(/\s+/)
    .join(" ");
}

/**
 * Strips ESC and the other C0 controls a body has no business carrying into
 * somebody else's terminal. Tab and newline survive.
 */
export function stripControl(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const control =
      (code <= 0x1f && character !== "\n" && character !== "\t") ||
      code === 0x7f;
    if (!control) out += character;
  }
  return out;
}

/** A short, unguessable id. Used for delivery frames and trace ids. */
export function nonce(length: number): string {
  // `randomBytes` rather than `randomUUID`: the callers want a compact opaque
  // token of a chosen length, not a formatted identifier.
  return randomBytes(24).toString("base64url").slice(0, length);
}

/** Truncates on a character boundary and says so. */
export function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  // Cut by code point, then shrink until the encoded form fits: a surrogate
  // pair sliced in half is a replacement character on the reader's screen.
  const characters = [...text];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      Buffer.byteLength(characters.slice(0, middle).join(""), "utf8") <=
      maxBytes
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${characters.slice(0, low).join("")}\n…（已截断）`;
}
