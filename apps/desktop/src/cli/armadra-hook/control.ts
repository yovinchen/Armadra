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
import { isSuccess, postJsonRequest } from "./http.js";
import type { HookResponse } from "./http.js";
import { headersFor, loadSession, send } from "./session.js";
import { BROWSER_VERBS, CONTEXT_VERBS } from "./usage.js";

/** The `{flag: value}` object a control route carries as `args`. */
export type Args = Record<string, JsonValue>;

/** `armadra-hook context <verb> [--node <id|title>] [-n N]` */
export async function runContext(args: string[]): Promise<number> {
  const verb = args[0];
  if (verb === undefined) {
    return fail(
      "usage: armadra-hook context <list|summary|transcript|terminal> [--node <id|title>] [-n N]",
    );
  }
  if (!(CONTEXT_VERBS as readonly string[]).includes(verb)) {
    return fail(
      `unknown context verb \`${verb}\`; expected one of ${CONTEXT_VERBS.join(", ")}`,
    );
  }

  let node: string | undefined;
  let lines: number | undefined;
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
    } else {
      return fail(`unknown option \`${flag}\` for \`context ${verb}\``);
    }
    index += 1;
  }

  const map: Args = {};
  if (node !== undefined) map["node"] = node;
  if (lines !== undefined) map["n"] = lines;
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
export async function runBrowser(args: string[]): Promise<number> {
  const verb = args[0];
  if (verb === undefined) {
    return fail(
      `usage: armadra-hook browser <${BROWSER_VERBS.join("|")}> [--flag value]...`,
    );
  }
  if (!(BROWSER_VERBS as readonly string[]).includes(verb)) {
    return fail(
      `unknown browser verb \`${verb}\`; expected one of ${BROWSER_VERBS.join(", ")}`,
    );
  }
  const parsed = parseFlags(args.slice(1));
  if ("error" in parsed) return fail(parsed.error);
  return request(`/browser/${percentEncodeSegment(verb)}`, parsed.ok);
}

/**
 * Turns `--flag value`, `--flag=value` and bare `--flag` into an args object.
 *
 * A flag repeated more than once collects into an array so verbs such as
 * `link --to a --to b` work without special casing.
 */
export function parseFlags(args: string[]): { ok: Args } | { error: string } {
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
    insertOrAppend(map, name, value);
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

async function request(path: string, args: Args): Promise<number> {
  const loaded = loadSession();
  if ("error" in loaded) return fail(loaded.error);
  const session = loaded.ok;
  const body = controlBody(session.nodeId, args);
  const outcome = await send(session, (current, candidate) =>
    postJsonRequest(path, headersFor(current, candidate), body),
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
