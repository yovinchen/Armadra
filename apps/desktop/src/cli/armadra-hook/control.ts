/**
 * The `context`, `canvas` and `browser` subcommands.
 *
 * Unlike hook mode these are invoked deliberately by an agent, so they are
 * loud: the runtime's prose goes to stdout and any failure goes to stderr with
 * exit code 1.
 *
 * The canvas verb itself is never validated here. The runtime owns that
 * registry — `canvas help` is served from it — so a client-side copy would be
 * a second source of truth that drifts the first time a verb is added.
 */

import { envVar } from "./endpoint.js";
import { percentEncodeSegment } from "./hook.js";
import { canonicalJsonBytes, tryParseJson } from "./json.js";
import type { JsonValue } from "./json.js";
import { isSuccess, postJsonRequest, totalTimeoutMs } from "./http.js";
import type { HookResponse } from "./http.js";
import { headersFor, loadSession, send } from "./session.js";
import { FILE_SUFFIX, STDIN_VALUE, TextReader } from "./text-input.js";
import type { TextSources } from "./text-input.js";
import { BROWSER_VERBS, CONTEXT_VERBS } from "./usage.js";

/** The `{flag: value}` object a control route carries as `args`. */
export type Args = Record<string, JsonValue>;

/** `armadra-hook context <verb> [--node <id|title>] [-n N]` */
export async function runContext(args: string[]): Promise<number> {
  const verb = args[0];
  if (verb === undefined) {
    return fail(
      "usage: armadra-hook context <list|summary|transcript|terminal> [--node <id|title>] [-n N] [--since] [--full --max-kb N]",
    );
  }
  if (!(CONTEXT_VERBS as readonly string[]).includes(verb)) {
    return fail(
      `unknown context verb \`${verb}\`; expected one of ${CONTEXT_VERBS.join(", ")}`,
    );
  }

  let node: string | undefined;
  let lines: number | undefined;
  // 阶段 C+ 的三个读取旋钮（设计 agent-delivery.md §13）。
  let since = false;
  let full = false;
  let maxKb: number | undefined;
  let index = 1;
  while (index < args.length) {
    const arg = args[index]!;
    const separator = arg.indexOf("=");
    const inline =
      separator > 0 && arg.startsWith("-")
        ? arg.slice(separator + 1)
        : undefined;
    const flag = inline === undefined ? arg : arg.slice(0, separator);
    if (flag === "--node") {
      const cursor = { index };
      const value = takeValue(args, cursor, inline);
      index = cursor.index;
      if (value === undefined) return fail("--node needs a node id or title");
      node = value;
    } else if (flag === "-n" || flag === "--lines") {
      const cursor = { index };
      const value = takeValue(args, cursor, inline);
      index = cursor.index;
      if (value === undefined) return fail("-n needs a number");
      const parsed = parseInteger(value);
      if (parsed === undefined)
        return fail(`-n needs a number, got \`${value}\``);
      lines = parsed;
    } else if (flag === "--since") {
      since = true;
    } else if (flag === "--full") {
      full = true;
    } else if (flag === "--max-kb") {
      const cursor = { index };
      const value = takeValue(args, cursor, inline);
      index = cursor.index;
      if (value === undefined) return fail("--max-kb needs a number");
      const parsed = parseInteger(value);
      if (parsed === undefined)
        return fail(`--max-kb needs a number, got \`${value}\``);
      maxKb = parsed;
    } else {
      return fail(`unknown option \`${flag}\` for \`context ${verb}\``);
    }
    index += 1;
  }

  const map: Args = {};
  if (node !== undefined) map["node"] = node;
  if (lines !== undefined) map["n"] = lines;
  if (since) map["since"] = true;
  if (full) map["full"] = true;
  if (maxKb !== undefined) map["max-kb"] = maxKb;
  return request(`/context-link/${percentEncodeSegment(verb)}`, map);
}

/** `armadra-hook canvas <verb> [--flag value | --flag=value | --flag]...` */
export async function runCanvas(args: string[]): Promise<number> {
  const verb = args[0];
  if (verb === undefined)
    return fail("usage: armadra-hook canvas <verb> [--flag value]...");
  if (verb.startsWith("-"))
    return fail(`expected a canvas verb, got \`${verb}\``);
  const parsed = parseFlags(args.slice(1));
  if ("error" in parsed) return fail(parsed.error);
  const map = parsed.ok;
  if (verb === "handoff-read" || verb === "ack") {
    delete map["sessionId"];
    delete map["generation"];
    const session = envVar("ARMADRA_SESSION_ID");
    const generation = parseUnsigned(envVar("ARMADRA_SESSION_GENERATION"));
    if (session !== undefined && generation !== undefined) {
      map["sessionId"] = session;
      map["generation"] = generation;
    } else if (verb === "handoff-read") {
      return fail(
        "A current terminal session binding is required; restart an older terminal.",
      );
    }
  }
  return request(`/control/${percentEncodeSegment(verb)}`, map);
}

/**
 * `armadra-hook browser <verb> [--flag value]...`
 *
 * Drives a browser node this node is linked to on the canvas. The same session
 * a person is looking at — there is no separate agent browser.
 */
/**
 * How long one browser verb may take, per endpoint candidate.
 *
 * NOT the hook's 1.5 s. That budget is for a hook event, which must never
 * hold up the CLI that fired it; a browser verb is deliberately long — `wait`
 * waits up to 30 s, a navigation waits for the page, the shell gives a verb
 * 45 s — and a request that runs out of budget here does not fail cleanly: the
 * client moves on to the next candidate and sends the verb AGAIN, which for a
 * click means clicking twice. So the budget covers the longest verb the
 * runtime allows plus its own timeout. `ARMADRA_HOOK_TIMEOUT_MS` still
 * overrides it when set.
 */
export const BROWSER_TIMEOUT_MS = 70_000;

export function browserTimeoutMs(): number {
  return envVar("ARMADRA_HOOK_TIMEOUT_MS") === undefined
    ? BROWSER_TIMEOUT_MS
    : totalTimeoutMs();
}

export async function runBrowser(args: string[]): Promise<number> {
  const verb = args[0];
  if (verb === undefined) {
    return fail(
      `usage: armadra-hook browser <${BROWSER_VERBS.join("|")}> [--flag value]...`,
    );
  }
  if (!BROWSER_VERBS.includes(verb)) {
    return fail(
      `unknown browser verb \`${verb}\`; expected one of ${BROWSER_VERBS.join(", ")}`,
    );
  }
  // `-n N` is the one short flag the browser verbs take (`read --limit`); the
  // rest of the parser only knows `--flags`.
  const parsed = parseFlags(
    args.slice(1).map((arg) => (arg === "-n" ? "--limit" : arg)),
  );
  if ("error" in parsed) return fail(parsed.error);
  return request(
    `/browser/${percentEncodeSegment(verb)}`,
    parsed.ok,
    browserTimeoutMs(),
  );
}

/**
 * Turns `--flag value`, `--flag=value` and bare `--flag` into an args object.
 *
 * A flag repeated more than once collects into an array so verbs such as
 * `link --to a --to b` work without special casing.
 *
 * `--flag -` takes the value from stdin and `--flag-file PATH` from a file
 * (`text-input.ts`): arbitrary text — a message body, a task — does not have
 * to survive the shell's quoting, and on Windows `cmd.exe`'s.
 */
export function parseFlags(
  args: string[],
  sources?: TextSources,
): { ok: Args } | { error: string } {
  const reader = new TextReader(sources);
  const map: Args = {};
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (!arg.startsWith("--"))
      return { error: `expected a --flag, got \`${arg}\`` };
    const separator = arg.indexOf("=");
    const inline = separator >= 0 ? arg.slice(separator + 1) : undefined;
    const flag = separator >= 0 ? arg.slice(0, separator) : arg;
    const name = flag.replace(/^-+/, "");
    if (name === "") return { error: "`--` is not a flag name" };
    // A flag whose next token is another flag (or nothing) is a boolean.
    let value: JsonValue;
    if (inline !== undefined) {
      value = inline;
    } else {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        index += 1;
        value = next;
      } else {
        value = true;
      }
    }
    let target = name;
    if (name.length > FILE_SUFFIX.length && name.endsWith(FILE_SUFFIX)) {
      target = name.slice(0, -FILE_SUFFIX.length);
      if (typeof value !== "string" || value === "")
        return { error: `--${name} needs a path` };
      const read = reader.file(target, value);
      if ("error" in read) return read;
      value = read.ok;
    } else if (value === STDIN_VALUE) {
      const read = reader.stdin(name);
      if ("error" in read) return read;
      value = read.ok;
    }
    insertOrAppend(map, target, value);
    index += 1;
  }
  return { ok: map };
}

function insertOrAppend(map: Args, name: string, value: JsonValue): void {
  const previous = map[name];
  if (previous === undefined) {
    map[name] = value;
  } else if (Array.isArray(previous)) {
    map[name] = [...previous, value];
  } else {
    map[name] = [previous, value];
  }
}

function takeValue(
  args: string[],
  cursor: { index: number },
  inline: string | undefined,
): string | undefined {
  if (inline !== undefined) return inline;
  const next = args[cursor.index + 1];
  if (next === undefined || next.startsWith("-")) return undefined;
  cursor.index += 1;
  return next;
}

/** `str::parse::<i64>` — a sign, digits, nothing else. */
function parseInteger(value: string): number | undefined {
  const text = value.trim();
  if (!/^[+-]?\d+$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** `str::parse::<u64>` — digits only, no sign. */
function parseUnsigned(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Builds the `{nodeId, args}` body every control route takes. */
export function controlBody(nodeId: string, args: Args): Buffer {
  return canonicalJsonBytes({ nodeId, args });
}

async function request(
  path: string,
  args: Args,
  total?: number,
): Promise<number> {
  const loaded = loadSession();
  if ("error" in loaded) return fail(loaded.error);
  const session = loaded.ok;
  const body = controlBody(session.nodeId, args);
  const outcome = await send(
    session,
    (current, candidate) =>
      postJsonRequest(path, headersFor(current, candidate), body),
    total,
  );
  if ("error" in outcome) return fail(outcome.error);
  if (!isSuccess(outcome.ok)) return fail(renderError(outcome.ok));
  const text = render(outcome.ok);
  if (text !== "")
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  return 0;
}

/**
 * Renders a successful response: prose is printed as-is, JSON is reduced to
 * its human readable field.
 */
export function render(response: HookResponse): string {
  if (!isJson(response)) return response.body;
  const value = tryParseJson(response.body);
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return response.body;
  }
  const object = value as Record<string, JsonValue>;
  if ("protocol" in object || "outcome" in object) return response.body;
  for (const key of ["message", "result", "text"]) {
    if (!(key in object)) continue;
    const field = object[key];
    return typeof field === "string" ? field : jsonToString(field);
  }
  return response.body;
}

/** `serde_json::Value::to_string` for the non-string branch of `render`. */
function jsonToString(value: JsonValue | undefined): string {
  if (value === undefined) return "null";
  // Rust prints the value with its own key order (sorted), which is what
  // `canonicalJson` produces.
  return canonicalJsonBytes(value).toString("utf8");
}

/** Renders a failure response into a single stderr line. */
export function renderError(response: HookResponse): string {
  const fallback = (): string => {
    const body = response.body.trim();
    return body === ""
      ? `hook endpoint answered ${response.status}`
      : `${body} (${response.status})`;
  };
  if (!isJson(response)) return fallback();
  const value = tryParseJson(response.body);
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return fallback();
  }
  const object = value as Record<string, JsonValue>;
  for (const key of ["error", "message"]) {
    const field = object[key];
    if (typeof field === "string") return `${field} (${response.status})`;
  }
  return fallback();
}

function isJson(response: HookResponse): boolean {
  return (response.contentType ?? "").toLowerCase().includes("json");
}

export function fail(message: string): number {
  process.stderr.write(`armadra-hook: ${message}\n`);
  return 1;
}
