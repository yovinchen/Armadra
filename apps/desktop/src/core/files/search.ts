import { readFileSync, readdirSync } from "node:fs";
import { canonicalDirectory } from "../workspaces/roots";
import { badRequest } from "../workspaces/support";
import { join, relativeToRoot } from "./paths";
import { symlinkMetadata } from "./stat";

/**
 * Workspace file index and project-wide content search (E01/M4).
 *
 * A port of the pre-merge implementation. Two read-only surfaces the
 * editor needs and the browser cannot provide:
 *
 *   * `indexFiles` backs 快速打开 — a fuzzy filename match over the workspace,
 *     with build folders skipped and a hard ceiling on how much of the tree is
 *     walked. The answer says when it was cut short.
 *   * `searchContent` backs 项目搜索 — literal or regular-expression grep with
 *     include/exclude globs, a per-file match ceiling and a wall-clock budget.
 *     Files above the read limit and files that look binary are counted as
 *     skipped, never read into memory.
 *
 * Both walk with an explicit queue in a deterministic (sorted) order, so
 * paging through a search is stable between requests, and both refuse to
 * follow a symbolic link: a link inside the workspace is neither indexed nor
 * descended into, which is what keeps a link out of the tree from being
 * searched through the workspace boundary.
 */

/**
 * Directories never walked. `.armadra` holds our own imports, assets and
 * trash — bytes the user reaches through the dedicated surfaces, not through a
 * filename match.
 */
export const IGNORED_DIRECTORIES = [
  ".git",
  ".hg",
  ".svn",
  ".armadra",
  "node_modules",
  "target",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
];

/**
 * How many directory entries either walk may look at before it gives up and
 * reports `truncated`. A canvas node must not be able to ask the core to stat
 * a million files.
 */
const MAX_SCANNED_ENTRIES = 40_000;
/** How deep either walk descends. */
const MAX_DEPTH = 24;

/* --------------------------------- 快速打开 -------------------------------- */

const DEFAULT_INDEX_LIMIT = 40;
const MAX_INDEX_LIMIT = 200;

export interface IndexEntry {
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

export interface FileIndex {
  readonly entries: readonly IndexEntry[];
  /**
   * More files matched than `limit`, or the walk hit its scan ceiling. The
   * client says so instead of pretending the list is complete.
   */
  readonly truncated: boolean;
  readonly scanned: number;
}

/** The UTF-8 byte offset of each character of `text`, plus its code point. */
function characters(text: string): { offset: number; lower: string }[] {
  const answer: { offset: number; lower: string }[] = [];
  let offset = 0;
  for (const character of text) {
    // `char::to_ascii_lowercase` only touches A–Z, which is what the Rust
    // matcher compares with — a Turkish `İ` is left exactly as it is.
    answer.push({ offset, lower: asciiLower(character) });
    offset += Buffer.byteLength(character, "utf8");
  }
  return answer;
}

function asciiLower(character: string): string {
  const code = character.charCodeAt(0);
  return code >= 0x41 && code <= 0x5a
    ? String.fromCharCode(code + 32)
    : character;
}

/**
 * Case-insensitive subsequence match of `needle` in `haystack`.
 *
 * Returns a score where **lower is better**: the span the match covers plus
 * where it starts, which — the Rust arithmetic works out this way — is the
 * byte offset of the last matched character. `undefined` when the needle is
 * not a subsequence at all.
 */
export function fuzzyScore(
  haystack: string,
  needle: string,
): number | undefined {
  if (needle === "") return 0;
  const found = characters(haystack);
  let cursor = 0;
  let last = 0;
  for (const wanted of needle) {
    const lower = asciiLower(wanted);
    while (cursor < found.length && found[cursor]?.lower !== lower) cursor += 1;
    if (cursor >= found.length) return undefined;
    last = found[cursor]?.offset ?? 0;
    cursor += 1;
  }
  return last;
}

/**
 * Rank one candidate against the query, or `undefined` when it does not match.
 *
 * The file name is tried first and scores far better than a hit that is only
 * in the directory part, so typing `client` surfaces `api/client.ts` above
 * `client/deep/other.ts`.
 */
function rank(
  relative: string,
  name: string,
  query: string,
): number | undefined {
  if (query === "") return Buffer.byteLength(relative, "utf8");
  const byName = fuzzyScore(name, query);
  if (byName !== undefined) return byName;
  const byPath = fuzzyScore(relative, query);
  return byPath === undefined ? undefined : byPath + 10_000;
}

export function indexFiles(
  root: string,
  query: string,
  limit: number | undefined,
): FileIndex {
  const base = canonicalDirectory(root);
  const bounded = clamp(limit ?? DEFAULT_INDEX_LIMIT, 1, MAX_INDEX_LIMIT);
  const needle = query.trim();
  if (Buffer.byteLength(needle, "utf8") > 200) {
    throw badRequest("Search query is too long");
  }
  const ranked: { score: number; entry: IndexEntry }[] = [];
  const report = walk(base, (relative, name, size) => {
    const score = rank(relative, name, needle);
    if (score !== undefined) {
      ranked.push({ score, entry: { path: relative, name, size } });
    }
    return true;
  });
  // Sort by score, then by path so equal scores keep a stable order between
  // requests rather than following `readdir`'s.
  ranked.sort((left, right) =>
    left.score !== right.score
      ? left.score - right.score
      : byteOrder(left.entry.path, right.entry.path),
  );
  const truncated = report.truncated || ranked.length > bounded;
  return {
    entries: ranked.slice(0, bounded).map((one) => one.entry),
    truncated,
    scanned: report.scanned,
  };
}

/* --------------------------------- 项目搜索 -------------------------------- */

/** Files larger than this are never read into memory by a search. */
const MAX_SEARCH_FILE_BYTES = 1_048_576;
/** A file whose first bytes contain a NUL is binary and is skipped. */
const BINARY_SNIFF_BYTES = 8_192;
/**
 * Wall-clock budget for one request. Reached, the answer is `timedOut` with
 * whatever was found — never a hang and never a partial result claiming to be
 * complete.
 */
const SEARCH_BUDGET_MS = 5_000;
const DEFAULT_FILE_LIMIT = 40;
const MAX_FILE_LIMIT = 200;
const DEFAULT_MATCHES_PER_FILE = 20;
const MAX_MATCHES_PER_FILE = 200;
/** Match previews are cut here so one minified line cannot dominate a response. */
const MAX_PREVIEW_CHARS = 400;

export interface SearchRequest {
  readonly query: string;
  readonly regex?: boolean;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  /** Comma-separated globs; empty means every file. */
  readonly include?: string | null;
  readonly exclude?: string | null;
  readonly maxMatchesPerFile?: number | null;
  /** How many *files* one page carries. */
  readonly limit?: number | null;
  /** How many matching files to skip; `nextOffset` from the previous page. */
  readonly offset?: number | null;
}

export interface SearchMatch {
  /** 1-based, so it can be handed straight to "open at line". */
  readonly line: number;
  /** 1-based column in characters, not bytes. */
  readonly column: number;
  readonly length: number;
  readonly preview: string;
  /** The preview was cut; the column may point past its end. */
  readonly previewTruncated: boolean;
}

export interface SearchFile {
  readonly path: string;
  readonly matches: readonly SearchMatch[];
  /** The file had more matches than the per-file ceiling allowed. */
  readonly truncated: boolean;
}

export interface SearchResult {
  readonly files: readonly SearchFile[];
  readonly totalMatches: number;
  /** More matching files exist beyond this page, or the walk was cut short. */
  readonly truncated: boolean;
  /** The wall-clock budget ran out before the walk finished. */
  readonly timedOut: boolean;
  /** Files not read: above the size limit, or binary. */
  readonly skipped: number;
  readonly scanned: number;
  /** Pass back as `offset` for the next page; `null` when this is the end. */
  readonly nextOffset: number | null;
}

/**
 * Translate one glob into an anchored regular expression.
 *
 * `**` crosses directory separators, `*` and `?` do not. A pattern with no `/`
 * matches the file name at any depth, which is what the pre-merge implementation has to mean.
 */
export function globToRegex(pattern: string): string {
  if (pattern.length > 200) throw badRequest("Glob pattern is too long");
  let out = "^";
  if (!pattern.includes("/")) out += "(?:.*/)?";
  const found = [...pattern];
  let index = 0;
  while (index < found.length) {
    const character = found[index] as string;
    if (character === "*") {
      if (found[index + 1] === "*") {
        // `**/` may also match nothing at all, so `**/a` finds a top-level `a`
        // as well as `deep/a`.
        if (found[index + 2] === "/") {
          out += "(?:.*/)?";
          index += 3;
          continue;
        }
        out += ".*";
        index += 2;
        continue;
      }
      out += "[^/]*";
    } else if (character === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(character);
    }
    index += 1;
  }
  return `${out}$`;
}

/** `regex::escape`, for the characters a JavaScript `RegExp` reads specially. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\\-/]/g, "\\$&");
}

/**
 * Compile a comma-separated glob list into one alternation, or `undefined`
 * when the list is empty.
 */
export function globSet(
  patterns: string | null | undefined,
): RegExp | undefined {
  if (patterns === undefined || patterns === null) return undefined;
  const parts = patterns
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map(globToRegex);
  if (parts.length === 0) return undefined;
  try {
    return new RegExp(parts.join("|"));
  } catch {
    throw badRequest("Glob pattern is not supported");
  }
}

function compileQuery(request: SearchRequest): RegExp {
  const query = request.query;
  if (query === "") throw badRequest("Search query is required");
  if (Buffer.byteLength(query, "utf8") > 1_000) {
    throw badRequest("Search query is too long");
  }
  const escaped = request.regex === true ? query : escapeRegex(query);
  const pattern = request.wholeWord === true ? `\\b(?:${escaped})\\b` : escaped;
  try {
    return new RegExp(pattern, request.caseSensitive === true ? "g" : "gi");
  } catch (error) {
    throw badRequest(
      `Search pattern is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Project-wide grep. See the module docs for the guarantees. */
export function searchContent(
  root: string,
  request: SearchRequest,
): SearchResult {
  const base = canonicalDirectory(root);
  const matcher = compileQuery(request);
  const include = globSet(request.include);
  const exclude = globSet(request.exclude);
  const limit = clamp(request.limit ?? DEFAULT_FILE_LIMIT, 1, MAX_FILE_LIMIT);
  const perFile = clamp(
    request.maxMatchesPerFile ?? DEFAULT_MATCHES_PER_FILE,
    1,
    MAX_MATCHES_PER_FILE,
  );
  const offset = request.offset ?? 0;
  const started = Date.now();

  const files: SearchFile[] = [];
  let totalMatches = 0;
  let skipped = 0;
  let seen = 0;
  let more = false;
  let timedOut = false;

  const report = walk(base, (relative, _name, size) => {
    if (Date.now() - started > SEARCH_BUDGET_MS) {
      timedOut = true;
      return false;
    }
    if (
      (include !== undefined && !include.test(relative)) ||
      (exclude !== undefined && exclude.test(relative))
    ) {
      return true;
    }
    if (size > MAX_SEARCH_FILE_BYTES) {
      skipped += 1;
      return true;
    }
    const text = readSearchable(join(base, relative.split("/").join(SEP)));
    if (text === undefined) {
      skipped += 1;
      return true;
    }
    const found = matchesIn(text, matcher, perFile);
    if (found.matches.length === 0) return true;
    seen += 1;
    if (seen <= offset) return true;
    if (files.length === limit) {
      // One more matching file than the page holds is all we need to know;
      // stopping here keeps the walk from reading the rest.
      more = true;
      return false;
    }
    totalMatches += found.matches.length;
    files.push({ path: relative, ...found });
    return true;
  });

  return {
    nextOffset: more ? offset + files.length : null,
    files,
    totalMatches,
    truncated: more || report.truncated || timedOut,
    timedOut,
    skipped,
    scanned: report.scanned,
  };
}

/** Every match in `text`, up to `perFile`, with 1-based line and column. */
function matchesIn(
  text: string,
  matcher: RegExp,
  perFile: number,
): { readonly matches: SearchMatch[]; readonly truncated: boolean } {
  const matches: SearchMatch[] = [];
  let truncated = false;
  let number = 0;
  for (const line of lines(text)) {
    number += 1;
    matcher.lastIndex = 0;
    let found = matcher.exec(line);
    while (found !== null) {
      if (matches.length >= perFile) {
        truncated = true;
        break;
      }
      const characters = [...found[0]].length;
      matches.push({
        line: number,
        column: [...line.slice(0, found.index)].length + 1,
        length: characters,
        preview: [...line].slice(0, MAX_PREVIEW_CHARS).join(""),
        previewTruncated: [...line].length > MAX_PREVIEW_CHARS,
      });
      // An empty match would otherwise return the same index forever.
      if (found[0] === "") matcher.lastIndex += 1;
      found = matcher.exec(line);
    }
    if (truncated) break;
  }
  return { matches, truncated };
}

/**
 * `str::lines()`: split on `\n`, drop a trailing `\r`, and do not produce a
 * final empty line for a file that ends in a newline.
 */
function lines(text: string): string[] {
  const split = text.split("\n");
  if (split[split.length - 1] === "") split.pop();
  return split.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Read a file as searchable text, or `undefined` when it is binary or
 * unreadable.
 *
 * Invalid UTF-8 is replaced rather than refused: a latin-1 source file still
 * searches usefully, and the offsets are only ever used to count characters
 * for a preview.
 */
function readSearchable(path: string): string | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return undefined;
  }
  if (bytes.length > MAX_SEARCH_FILE_BYTES) return undefined;
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
  return bytes.toString("utf8");
}

/* ---------------------------------- the walk ------------------------------ */

const SEP = process.platform === "win32" ? "\\" : "/";

interface WalkReport {
  readonly scanned: number;
  readonly truncated: boolean;
}

/**
 * Breadth-first walk of the regular files under `root`, sorted within each
 * directory, calling `visit(relativePath, fileName, size)`. A `visit` that
 * answers `false` stops the walk.
 *
 * Symbolic links are neither reported nor followed: `lstat` is what decides,
 * so a link pointing outside the workspace is simply not part of the tree.
 * Ignored directory names are skipped whole.
 */
function walk(
  root: string,
  visit: (relative: string, name: string, size: number) => boolean,
): WalkReport {
  const queue: { directory: string; depth: number }[] = [
    { directory: root, depth: 0 },
  ];
  let scanned = 0;
  let truncated = false;
  while (queue.length > 0) {
    const { directory, depth } = queue.shift() as {
      directory: string;
      depth: number;
    };
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    const children = names.map((name) => join(directory, name));
    children.sort(byteOrder);
    for (const path of children) {
      if (scanned >= MAX_SCANNED_ENTRIES) {
        return { scanned, truncated: true };
      }
      scanned += 1;
      const name = path.slice(path.lastIndexOf(SEP) + 1);
      const info = symlinkMetadata(path);
      if (info === undefined || info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (IGNORED_DIRECTORIES.includes(name) || depth + 1 > MAX_DEPTH) {
          continue;
        }
        queue.push({ directory: path, depth: depth + 1 });
        continue;
      }
      if (!info.isFile()) continue;
      let relative: string;
      try {
        relative = relativeToRoot(root, path);
      } catch {
        continue;
      }
      if (!visit(relative, name, info.size)) {
        return { scanned, truncated };
      }
    }
  }
  return { scanned, truncated };
}

/** `PathBuf`/`String` ordering: byte by byte, not by locale. */
function byteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(Math.trunc(value), low), high);
}
