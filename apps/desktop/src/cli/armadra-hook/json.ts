/**
 * JSON that serialises byte-for-byte the way the Rust client's `serde_json`
 * does, because the runtime-facing bodies are compared byte-for-byte against
 * it and a hook report is a wire contract, not a pretty-printed object.
 *
 * Two behaviours have to be reproduced and neither is what `JSON` does:
 *
 *   1. **Key order.** `serde_json` without `preserve_order` stores objects in a
 *      `BTreeMap<String, _>`, so every object is emitted with its keys in
 *      UTF-8 byte order regardless of insertion order. `{"args":…,"nodeId":…}`
 *      in the Rust tests is that ordering, not a hand-written one.
 *   2. **Numbers.** `serde_json` keeps an integer an integer (u64/i64, exact
 *      past 2^53) and formats a float with ryu, which always leaves a
 *      fractional part: `1.0`, never `1`. `JSON.parse` collapses both into an
 *      IEEE double and `JSON.stringify` prints `1`. So the parser here keeps
 *      the raw token and the serialiser replays it.
 *
 * String escaping is left to `JSON.stringify`: it and `serde_json` agree
 * (`"`, `\`, `\b\t\n\f\r`, `\u00xx` for the remaining controls, everything
 * else verbatim including U+2028/U+2029 and non-ASCII).
 */

/** A number that keeps the source token so it can be re-emitted verbatim. */
export class RawNumber {
  constructor(readonly raw: string) {}

  /** The double this token denotes, for callers that want to compare it. */
  valueOf(): number {
    return Number(this.raw);
  }

  toJSON(): number {
    return Number(this.raw);
  }
}

export type JsonValue =
  | null
  | boolean
  | string
  | number
  | RawNumber
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Formats a float the way `serde_json` (ryu) does: the shortest round-tripping
 * decimal, always carrying a fractional part or an exponent. JavaScript's own
 * shortest form is the same digits; only the presentation differs (`1` for
 * `1.0`, `1e+21` for `1e21`).
 */
export function formatFloat(value: number): string {
  if (!Number.isFinite(value)) return "null";
  const text = String(value).replace("e+", "e");
  if (text.includes("e")) return text;
  return text.includes(".") ? text : `${text}.0`;
}

/** Orders two keys by their UTF-8 bytes, which is what `BTreeMap` compares. */
function compareKeys(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** Serialises `value` with sorted keys and serde-compatible numbers. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof RawNumber) return value.raw;
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isInteger(value) && Number.isSafeInteger(value)
        ? String(value)
        : formatFloat(value);
    case "bigint":
      return value.toString();
    case "string":
      return JSON.stringify(value);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, item]) => item !== undefined,
  );
  entries.sort(([left], [right]) => compareKeys(left, right));
  const body = entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",");
  return `{${body}}`;
}

/** `canonicalJson` as the bytes that go on the wire. */
export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

/* --------------------------------- parsing -------------------------------- */

const DIGIT = /[0-9]/;

class Parser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length)
      throw new SyntaxError("trailing input");
    return value;
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        this.index += 1;
      } else {
        break;
      }
    }
  }

  private parseValue(): JsonValue {
    const character = this.text[this.index];
    if (character === undefined)
      throw new SyntaxError("unexpected end of input");
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === '"') return this.parseString();
    if (this.text.startsWith("true", this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith("false", this.index)) {
      this.index += 5;
      return false;
    }
    if (this.text.startsWith("null", this.index)) {
      this.index += 4;
      return null;
    }
    return this.parseNumber();
  }

  private parseObject(): { [key: string]: JsonValue } {
    this.index += 1;
    const out: { [key: string]: JsonValue } = {};
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      const key = this.parseString();
      this.skipWhitespace();
      if (this.text[this.index] !== ":") throw new SyntaxError("expected `:`");
      this.index += 1;
      this.skipWhitespace();
      // A payload is attacker-adjacent data, never a place to let a key like
      // `__proto__` reach an object's prototype.
      if (key !== "__proto__") out[key] = this.parseValue();
      else this.parseValue();
      this.skipWhitespace();
      const next = this.text[this.index];
      this.index += 1;
      if (next === "}") return out;
      if (next !== ",") throw new SyntaxError("expected `,` or `}`");
    }
  }

  private parseArray(): JsonValue[] {
    this.index += 1;
    const out: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      out.push(this.parseValue());
      this.skipWhitespace();
      const next = this.text[this.index];
      this.index += 1;
      if (next === "]") return out;
      if (next !== ",") throw new SyntaxError("expected `,` or `]`");
    }
  }

  private parseString(): string {
    if (this.text[this.index] !== '"')
      throw new SyntaxError("expected a string");
    const start = this.index;
    this.index += 1;
    for (;;) {
      const character = this.text[this.index];
      if (character === undefined) throw new SyntaxError("unterminated string");
      this.index += 1;
      if (character === '"') break;
      if (character === "\\") {
        if (this.index >= this.text.length)
          throw new SyntaxError("unterminated escape");
        this.index += 1;
      }
    }
    // The slice is a well-formed JSON string literal, so the platform parser
    // handles the escapes (including surrogate pairs) without a second copy of
    // that table living here.
    return JSON.parse(this.text.slice(start, this.index)) as string;
  }

  private parseNumber(): RawNumber {
    const start = this.index;
    if (this.text[this.index] === "-") this.index += 1;
    while (this.index < this.text.length && DIGIT.test(this.text[this.index]!))
      this.index += 1;
    if (this.text[this.index] === ".") {
      this.index += 1;
      while (
        this.index < this.text.length &&
        DIGIT.test(this.text[this.index]!)
      )
        this.index += 1;
    }
    const exponent = this.text[this.index];
    if (exponent === "e" || exponent === "E") {
      this.index += 1;
      const sign = this.text[this.index];
      if (sign === "+" || sign === "-") this.index += 1;
      while (
        this.index < this.text.length &&
        DIGIT.test(this.text[this.index]!)
      )
        this.index += 1;
    }
    const raw = this.text.slice(start, this.index);
    if (raw === "" || raw === "-" || !Number.isFinite(Number(raw))) {
      throw new SyntaxError(`not a number: ${raw}`);
    }
    // Integers replay verbatim (serde keeps u64/i64 exact); floats go through
    // ryu's shortest form, which is not necessarily the source token.
    return new RawNumber(
      /[.eE]/.test(raw) ? formatFloat(Number(raw)) : normaliseInteger(raw),
    );
  }
}

/**
 * `serde_json` parses an integer into u64/i64 and prints it back without the
 * source's leading zeros; anything too large for 64 bits becomes a float.
 */
function normaliseInteger(raw: string): string {
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, "");
  const value = BigInt(negative ? `-${digits}` : digits);
  const fitsI64 = value >= -(2n ** 63n) && value <= 2n ** 63n - 1n;
  const fitsU64 = value >= 0n && value <= 2n ** 64n - 1n;
  if (!fitsI64 && !fitsU64) return formatFloat(Number(value));
  return value.toString();
}

/** Parses JSON, keeping number tokens so they survive a round trip. */
export function parseJson(text: string): JsonValue {
  return new Parser(text).parse();
}

/** `parseJson` that answers `undefined` instead of throwing. */
export function tryParseJson(text: string): JsonValue | undefined {
  try {
    return parseJson(text);
  } catch {
    return undefined;
  }
}

/** Reads a plain number out of a parsed value, whatever shape it arrived in. */
export function asNumber(value: JsonValue | undefined): number | undefined {
  if (value instanceof RawNumber) return Number(value.raw);
  return typeof value === "number" ? value : undefined;
}

/** Reads a string out of a parsed value. */
export function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Reads an object out of a parsed value. */
export function asObject(
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}
