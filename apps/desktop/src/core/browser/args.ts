import { Args, truncate } from "../collab/refusals";

/**
 * The hook's flags, as the drive channel's camelCase arguments.
 *
 * Ported from `shell_args` in the pre-merge implementation. Written
 * out per verb rather than forwarded wholesale. A pass-through would mean the
 * shell's verbs taking whatever a caller typed, and the point of a verb
 * interface is that the set of things one can say is closed.
 */

/**
 * Every verb, and nothing else. `armadra-hook`'s `BROWSER_VERBS` and the
 * shell's `DRIVE_VERBS` are the same list, checked there too so a typo costs a
 * local error line rather than a round trip and a refusal in the model's
 * context.
 */
export const VERBS: readonly string[] = [
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
];

/**
 * Default page-text budget for an agent read. Smaller than the API's ceiling
 * because this text goes straight into a model's context window.
 */
export const DEFAULT_READ_BYTES = 24 * 1024;
export const DEFAULT_ELEMENT_LIMIT = 40;

/** How long `wait` gives a condition before it reports a timeout. */
const DEFAULT_WAIT_MS = 15_000;

export type ShellArgs = Record<string, unknown>;

/**
 * The loosely typed flag bag a hook call arrives with.
 *
 * The typed reads come from {@link Args}, which every other verb surface in
 * this core already uses; the raw record travels beside it because one read —
 * a repeated flag kept whole — must NOT split on commas, and `Args.list`
 * always does.
 */
export type ArgSource = Readonly<Record<string, unknown>>;

export function shellArgs(verb: string, source: ArgSource): ShellArgs {
  const args = new Args(source);
  const map: ShellArgs = {};
  const put = (name: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    map[name] = value;
  };
  // Targeting, which almost every verb accepts.
  put("ref", args.text("ref"));
  put("selector", args.text("selector"));
  const x = args.count(["x"]);
  const y = args.count(["y"]);
  if (x !== undefined && y !== undefined) {
    put("x", x);
    put("y", y);
  }
  switch (verb) {
    case "navigate": {
      const url = args.text("url");
      put("url", url);
      put(
        "action",
        args.text("action") ?? (url === undefined ? "reload" : "goto"),
      );
      break;
    }
    case "back":
    case "forward":
      put("action", verb);
      break;
    case "read":
      put("mode", args.text("mode") ?? "text");
      put("limit", args.count(["n", "limit"]) ?? DEFAULT_ELEMENT_LIMIT);
      put(
        "maxBytes",
        args.count(["max-bytes", "maxBytes"]) ?? DEFAULT_READ_BYTES,
      );
      break;
    case "type":
      put("text", args.text("text") ?? "");
      put("replace", args.flag("replace"));
      put("submit", args.flag("submit") || args.flag("enter"));
      break;
    case "press":
      put("key", args.text("key"));
      put("repeat", args.count(["repeat"]) ?? 1);
      put("modifiers", modifiersOf(source));
      break;
    case "select":
      put("values", repeated(source, "value"));
      put("labels", repeated(source, "label"));
      break;
    case "scroll": {
      put("direction", args.text("direction"));
      const amount = args.count(["amount"]);
      if (amount !== undefined) put("amount", amount);
      break;
    }
    case "wait":
      put("urlContains", args.text("url-contains") ?? args.text("urlContains"));
      put(
        "titleContains",
        args.text("title-contains") ?? args.text("titleContains"),
      );
      put(
        "timeoutMs",
        args.count(["timeout", "timeout-ms", "timeoutMs"]) ?? DEFAULT_WAIT_MS,
      );
      break;
    case "capture":
      // A default inside the workspace rather than a required flag: the jail
      // is what keeps the write safe, so there is nothing to gain from making
      // every caller name a directory.
      put("path", args.text("path") ?? `.armadra/browser/${Date.now()}.png`);
      put("fullPage", args.flag("full-page") || args.flag("fullPage"));
      put("format", args.text("format"));
      break;
    case "upload":
      put("paths", repeated(source, "path"));
      break;
    case "download":
      put("id", args.text("id"));
      put("accept", args.flag("accept"));
      break;
    case "tabs":
      put("switch", args.text("switch"));
      put("new", args.text("new"));
      break;
    case "close":
      put("tab", args.text("tab"));
      break;
    case "dialog":
      put("id", args.text("id"));
      put("accept", args.flag("accept"));
      put("text", args.text("text"));
      break;
    default:
      break;
  }
  return map;
}

/**
 * Verbs that drive the page rather than read it. `read`, `wait` and `capture`
 * are reads and never take the lease.
 */
const LEASE_VERBS: readonly string[] = [
  "navigate",
  "click",
  "type",
  "select",
  "press",
  "scroll",
  "upload",
  "back",
  "forward",
  "close",
  "dialog",
];

/**
 * Whether this call takes the control lease.
 *
 * Two verbs are split by their arguments rather than by their name: listing
 * tabs or staged downloads is a read and must work while a person is driving,
 * while switching a tab or accepting a download changes what that person is
 * looking at.
 */
export function needsLease(verb: string, source: ArgSource): boolean {
  const args = new Args(source);
  switch (verb) {
    case "tabs":
      return (
        args.text("switch") !== undefined || args.text("new") !== undefined
      );
    case "download":
      return args.flag("accept") || args.flag("reject");
    default:
      return LEASE_VERBS.includes(verb);
  }
}

/**
 * A repeatable flag, kept whole. Unlike `Args.list` this does not split on
 * commas: an option value or a file name is allowed to contain one.
 */
export function repeated(source: ArgSource, name: string): string[] {
  const raw = source[name];
  if (typeof raw === "string") return [raw.trim()];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** `--modifiers` as a number, or as names a person would actually type. */
export function modifiersOf(source: ArgSource): number {
  const args = new Args(source);
  const numeric = args.count(["modifiers"]);
  if (numeric !== undefined) return Math.max(0, numeric) & 0b1111;
  let bits = 0;
  for (const name of args.list("modifiers")) {
    switch (name.toLowerCase()) {
      case "alt":
      case "option":
        bits |= 1;
        break;
      case "ctrl":
      case "control":
        bits |= 2;
        break;
      case "meta":
      case "cmd":
      case "command":
        bits |= 4;
        break;
      case "shift":
        bits |= 8;
        break;
      default:
        break;
    }
  }
  return bits;
}

/** A one-line "what was aimed at", for the activity badge. */
export function describeTarget(source: ArgSource): string {
  const args = new Args(source);
  for (const name of ["ref", "selector", "url", "key", "tab", "id", "path"]) {
    const value = args.text(name);
    if (value !== undefined) return truncate(value, 120);
  }
  return "";
}

/**
 * Adds what only this side knows to the arguments a verb carries.
 *
 * The workspace root travels because the jail that uses it lives where the
 * write happens. The core supplies the root; the shell enforces the boundary
 * with `realpath`, a separator-terminated prefix comparison and an `lstat` on
 * the final segment. Neither half is sufficient alone: the shell does not know
 * which workspace a node belongs to, and this side is not the process that
 * opens the file.
 */
export function withWorkspace(args: ShellArgs, root: string): ShellArgs {
  return { ...args, workspaceRoot: root };
}
