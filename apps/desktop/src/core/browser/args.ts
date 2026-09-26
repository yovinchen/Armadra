import { Args, truncate } from "../collab/refusals";
import { BROWSER_VERB_SPECS, VERB_NAMES, verbSpec } from "./verb-spec";

/**
 * The hook's flags, as the drive channel's camelCase arguments.
 *
 * Written out per verb rather than forwarded wholesale. A pass-through would
 * mean the shell's verbs taking whatever a caller typed, and the point of a
 * verb interface is that the set of things one can say is closed.
 *
 * WHICH verbs and flags exist is not decided here: `verb-spec.ts` is the one
 * list, and `verb-spec.test.ts` checks that every flag it names is forwarded
 * by {@link shellArgs}. Other modules (the hook's `--help`, the skill text)
 * read the list through the re-exports below.
 */

export {
  BROWSER_NOTES,
  BROWSER_NOTES_ZH,
  BROWSER_VERB_SPECS,
  COMMON_FLAGS,
  DOCUMENTED_CODES,
  TARGET_FLAGS,
  browserUsage,
  flagsOf,
  verbSpec,
} from "./verb-spec";
export type { BrowserFlagSpec, BrowserVerbSpec } from "./verb-spec";

/**
 * Every verb, and nothing else. `armadra-hook`'s `BROWSER_VERBS` and the
 * shell's `DRIVE_VERBS` are this same list.
 */
export const VERBS: readonly string[] = VERB_NAMES;

/**
 * Default page-text budget for an agent read. Smaller than the API's ceiling
 * because this text goes straight into a model's context window.
 */
export const DEFAULT_READ_BYTES = 24 * 1024;
/** A snapshot is denser than prose; its own, smaller budget. */
export const DEFAULT_SNAPSHOT_BYTES = 16 * 1024;
export const DEFAULT_ELEMENT_LIMIT = 40;

/** How long `wait` gives a condition before it reports a timeout. */
const DEFAULT_WAIT_MS = 15_000;

export type ShellArgs = Record<string, unknown>;

/**
 * The loosely typed flag bag a hook call arrives with.
 *
 * The typed reads come from {@link Args}; the raw record travels beside it
 * because one read — a repeated flag kept whole — must NOT split on commas,
 * and `Args.list` always does.
 */
export type ArgSource = Readonly<Record<string, unknown>>;

export function shellArgs(verb: string, source: ArgSource): ShellArgs {
  const args = new Args(source);
  const map: ShellArgs = {};
  const put = (name: string, value: unknown): void => {
    if (value === undefined || value === null || value === false) return;
    map[name] = value;
  };
  const spec = verbSpec(verb);

  // Which tab, and whether to answer with a diff: every verb takes both.
  put("tab", args.text("tab"));
  if (spec?.changesPage === true) put("snapshot", args.flag("snapshot"));

  // Targeting.
  if (spec?.targets === true) {
    put("ref", args.text("ref") ?? args.text("to-ref"));
    put("role", args.text("role"));
    put("name", rawText(source, "name"));
    put("selector", args.text("selector"));
    const x = args.count(["x"]);
    const y = args.count(["y"]);
    if (x !== undefined && y !== undefined) {
      put("x", x);
      put("y", y);
    }
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
    case "read": {
      const raw = args.text("mode") ?? "snapshot";
      // `elements` and `map` were the old CSS-built element list. They are the
      // interactive snapshot now: one enumeration, one kind of ref.
      const legacy = raw === "elements" || raw === "map";
      const mode = legacy ? "snapshot" : raw;
      put("mode", mode);
      put("interactive", legacy || args.flag("interactive"));
      put("depth", args.count(["depth"]));
      put("limit", args.count(["limit", "n"]) ?? DEFAULT_ELEMENT_LIMIT);
      put(
        "maxBytes",
        args.count(["max-bytes", "maxBytes"]) ??
          (mode === "snapshot" ? DEFAULT_SNAPSHOT_BYTES : DEFAULT_READ_BYTES),
      );
      put("level", args.text("level"));
      put("filter", args.text("filter"));
      put("failed", args.flag("failed"));
      put("type", args.text("type"));
      put("clear", args.flag("clear"));
      break;
    }
    case "click":
      put("double", args.flag("double"));
      break;
    case "drag":
      put("from", args.text("from"));
      put("to", args.text("to"));
      break;
    case "type":
      put("text", rawText(source, "text") ?? "");
      put("replace", args.flag("replace"));
      put("submit", args.flag("submit") || args.flag("enter"));
      break;
    case "fill":
      put("fields", repeated(source, "field"));
      break;
    case "press":
      put("key", args.text("key"));
      put("repeat", args.count(["repeat"]) ?? 1);
      put("modifiers", modifiersOf(source) || undefined);
      break;
    case "select":
      put("values", nonEmpty(repeated(source, "value")));
      put("labels", nonEmpty(repeated(source, "label")));
      break;
    case "scroll": {
      put("direction", args.text("direction"));
      put("amount", args.count(["amount"]));
      break;
    }
    case "wait":
      put("text", rawText(source, "text"));
      put(
        "textGone",
        rawText(source, "text-gone") ?? rawText(source, "textGone"),
      );
      put("idle", args.flag("idle"));
      put("selector", args.text("selector"));
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
    case "capture": {
      const format = args.text("format") === "jpeg" ? "jpeg" : "png";
      // A default inside the workspace rather than a required flag: the jail
      // is what keeps the write safe, so there is nothing to gain from making
      // every caller name a directory.
      put(
        "path",
        args.text("path") ??
          `.armadra/browser/${Date.now()}.${format === "jpeg" ? "jpg" : "png"}`,
      );
      put("fullPage", args.flag("full-page") || args.flag("fullPage"));
      put("format", args.text("format"));
      break;
    }
    case "pdf":
      put("path", args.text("path") ?? `.armadra/browser/${Date.now()}.pdf`);
      put("landscape", args.flag("landscape"));
      break;
    case "resize":
      put("width", args.count(["width"]));
      put("height", args.count(["height"]));
      put("reset", args.flag("reset"));
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
    case "dialog":
      put("id", args.text("id"));
      put("accept", args.flag("accept"));
      put("text", rawText(source, "text"));
      break;
    default:
      break;
  }
  return map;
}

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
  const spec = verbSpec(verb);
  if (spec === undefined) return false;
  if (spec.lease !== "flag") return spec.lease === "always";
  switch (verb) {
    case "tabs":
      return (
        args.text("switch") !== undefined || args.text("new") !== undefined
      );
    case "download":
      return args.flag("accept") || args.flag("reject");
    default:
      return false;
  }
}

/** Verbs that read: they never take the lease, whatever their flags. */
export function isReadVerb(verb: string): boolean {
  return BROWSER_VERB_SPECS.some(
    (spec) => spec.name === verb && spec.lease === "never",
  );
}

/**
 * A repeatable flag, kept whole. Unlike `Args.list` this does not split on
 * commas: an option value or a file name is allowed to contain one.
 */
export function repeated(source: ArgSource, name: string): string[] {
  const raw = source[name];
  if (typeof raw === "string") return raw.trim() === "" ? [] : [raw.trim()];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function nonEmpty(values: string[]): string[] | undefined {
  return values.length === 0 ? undefined : values;
}

/**
 * Text a person typed, kept as typed. `Args.text` trims, which is right for an
 * id and wrong for `type --text " 2"` or an accessible name with a trailing
 * space the page really has.
 */
function rawText(source: ArgSource, name: string): string | undefined {
  const value = source[name];
  if (typeof value === "string") return value === "" ? undefined : value;
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === "string");
    return typeof first === "string" && first !== "" ? first : undefined;
  }
  return undefined;
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
  const role = args.text("role");
  if (role !== undefined) {
    const name = args.text("name");
    return truncate(name === undefined ? role : `${role} ${name}`, 120);
  }
  for (const name of [
    "ref",
    "selector",
    "url",
    "key",
    "from",
    "tab",
    "id",
    "path",
  ]) {
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
