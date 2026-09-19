import { readFileSync } from "node:fs";

/**
 * The narrow slice of TOML editing Codex's trust state needs.
 *
 * Codex keys its `hooks.state` by `<absolute hooks.json path>:<event>:<group
 * index>:<handler index>` — a string with dots and colons in it, so every
 * entry is its own quoted table header:
 *
 * ```toml
 * [hooks.state."/home/u/.codex/hooks.json:stop:0:0"]
 * enabled = true
 * trusted_hash = "sha256:…"
 * ```
 *
 * The Rust installer uses `toml_edit` to merge into that file while preserving
 * every comment, ordering and formatting choice the user made. There is no
 * equivalent in this build's dependency set, and a full TOML round-tripper
 * would be a large thing to own for two keys — so this is a *line* editor
 * instead, which preserves the rest of the file trivially: it only ever
 * rewrites the two lines inside a `[hooks.state."…"]` table we wrote, and
 * appends whole tables at the end.
 *
 * What it deliberately does not do is parse TOML. It recognises a table header
 * and nothing else, so a file whose `hooks.state` is written in any other
 * shape — inline tables, dotted keys — is left alone rather than rewritten
 * from a misunderstanding. Codex writes the header form, and so do we.
 */

const HEADER = /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*"((?:[^"\\]|\\.)*)"\s*\]\s*$/;
/** Any table header at all, which is where the current table ends. */
const ANY_HEADER = /^\s*\[\[?[^\]]*\]\]?\s*$/;

export interface TrustEntry {
  readonly key: string;
  readonly hash: string;
}

/** The `hooks.state` keys a document already carries, in file order. */
export function stateKeys(document: string): string[] {
  const keys: string[] = [];
  for (const line of document.split("\n")) {
    const match = HEADER.exec(line);
    if (match !== null) keys.push(unescapeKey(match[1] as string));
  }
  return keys;
}

/**
 * Merges every entry in, replacing the `enabled` and `trusted_hash` of a table
 * that is already there and appending a whole table for one that is not.
 */
export function writeTrustState(
  document: string,
  entries: readonly TrustEntry[],
): string {
  if (entries.length === 0) return document;
  let out = document;
  const append: TrustEntry[] = [];
  for (const entry of entries) {
    const replaced = replaceTable(out, entry);
    if (replaced === undefined) append.push(entry);
    else out = replaced;
  }
  if (append.length === 0) return out;
  const prefix = out === "" || out.endsWith("\n") ? "" : "\n";
  const blank = out.trim() === "" ? "" : "\n";
  return (
    out +
    prefix +
    blank +
    append
      .map(
        (entry) =>
          `[hooks.state."${escapeKey(entry.key)}"]\nenabled = true\ntrusted_hash = "${entry.hash}"\n`,
      )
      .join("\n")
  );
}

/**
 * Drops every `hooks.state` table whose key starts with `prefix` and is not in
 * `surviving`. Answers the document unchanged when nothing matched, so a
 * caller can skip the write.
 */
export function removeTrustState(
  document: string,
  prefix: string,
  surviving: readonly string[],
): string {
  const lines = document.split("\n");
  const kept: string[] = [];
  let dropping = false;
  for (const line of lines) {
    const match = HEADER.exec(line);
    if (match !== null) {
      const key = unescapeKey(match[1] as string);
      dropping = key.startsWith(prefix) && !surviving.includes(key);
      if (dropping) {
        // The blank line the table was separated by goes with it.
        while (kept.length > 0 && (kept[kept.length - 1] as string).trim() === "") {
          kept.pop();
        }
        continue;
      }
    } else if (dropping) {
      if (ANY_HEADER.test(line)) dropping = false;
      else continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * A cheap sanity check before this editor touches a file.
 *
 * It is not a parser and must not pretend to be one: it only refuses a file
 * whose brackets do not balance outside strings and comments, which is the
 * shape a line editor would plainly mangle — an unterminated table header, an
 * unterminated array, an unterminated string. A multi-line array balances and
 * is therefore fine. Everything a real TOML parser would reject and this lets
 * through is a file Codex itself reports on, and appending a table to it is no
 * worse than leaving it; a file this refuses is one where "every other line is
 * untouched" would not be true.
 */
export function isEditable(document: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < document.length; index += 1) {
    const character = document[index] as string;
    if (quote !== undefined) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "#") {
      const newline = document.indexOf("\n", index);
      index = newline < 0 ? document.length : newline;
    } else if (character === "[") depth += 1;
    else if (character === "]") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0 && quote === undefined;
}

/** Reads a TOML file, treating a missing one as empty. */
export function readDocument(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function replaceTable(
  document: string,
  entry: TrustEntry,
): string | undefined {
  const lines = document.split("\n");
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADER.exec(lines[index] as string);
    if (match !== null && unescapeKey(match[1] as string) === entry.key) {
      start = index;
      break;
    }
  }
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (ANY_HEADER.test(lines[index] as string)) {
      end = index;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  const rewritten = setKey(
    setKey(body, "enabled", "true"),
    "trusted_hash",
    `"${entry.hash}"`,
  );
  return [...lines.slice(0, start + 1), ...rewritten, ...lines.slice(end)].join(
    "\n",
  );
}

/** Replaces `key = …` inside one table body, or appends it after the header. */
function setKey(body: string[], key: string, value: string): string[] {
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  const index = body.findIndex((line) => pattern.test(line));
  if (index >= 0) {
    const next = [...body];
    next[index] = `${key} = ${value}`;
    return next;
  }
  // After the header, before any trailing blank lines the table ends with.
  let at = body.length;
  while (at > 0 && (body[at - 1] as string).trim() === "") at -= 1;
  return [...body.slice(0, at), `${key} = ${value}`, ...body.slice(at)];
}

function escapeKey(key: string): string {
  return key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unescapeKey(key: string): string {
  return key.replace(/\\(.)/g, "$1");
}
