import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Shared plumbing for the transcript scanners.
 *
 * Ported from the pre-merge implementation. Every provider needs the same
 * four things: a bounded list of candidate files, each file's mtime and size,
 * a bounded read of the file's head, and a title that has been collapsed and
 * cut. None of it is provider-specific, so it lives here and `claude.ts` /
 * `codex.ts` only describe the shape of their own JSON.
 *
 * Everything is bounded, because these directories belong to other programs: a
 * scan walks a fixed depth, stops after {@link MAX_FILES_PER_PROVIDER} files,
 * and never reads more than the caller's head budget from any one file. A
 * surprising layout costs a truncated index, never a hung core.
 */

/** Per-provider ceiling on indexed files. */
export const MAX_FILES_PER_PROVIDER = 5_000;
/** Directory depth the walk is allowed to descend from a provider's root. */
const MAX_DEPTH = 8;
/** Hard stop on directory entries examined, independent of how many match. */
const MAX_ENTRIES = 200_000;
/** Titles are one line in a palette row, not a summary. */
export const MAX_TITLE_CHARS = 120;

/** A candidate transcript file: where it is, when it last changed, how big. */
export interface Candidate {
  readonly path: string;
  /**
   * RFC 3339, UTC — the same shape `conversations.updated_at` uses, so "is
   * this row stale?" is a string comparison rather than a parse.
   */
  readonly updatedAt: string;
  readonly bytes: number;
}

/** What a provider managed to read out of one file. */
export interface Parsed {
  readonly sessionId: string;
  readonly title: string;
  readonly cwd: string;
}

/**
 * Depth-bounded walk collecting files that `matches` accepts.
 *
 * `matches` receives the whole path so a provider can require a parent
 * directory as well as a file name.
 */
export function collect(
  root: string,
  matches: (path: string) => boolean,
): Candidate[] {
  const found: Candidate[] = [];
  if (!isDirectory(root)) return found;
  const frontier: [string, number][] = [[root, 0]];
  let seen = 0;
  while (frontier.length > 0) {
    const [directory, depth] = frontier.pop() as [string, number];
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > MAX_ENTRIES || found.length >= MAX_FILES_PER_PROVIDER) {
        return found;
      }
      const path = join(directory, entry.name);
      // `isDirectory` on the dirent does not follow symlinks, which is what
      // keeps a link back up the tree from turning the walk into a loop.
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) frontier.push([path, depth + 1]);
        continue;
      }
      if (!entry.isFile() || !matches(path)) continue;
      try {
        const stats = statSync(path);
        found.push({
          path,
          updatedAt: new Date(stats.mtimeMs).toISOString(),
          bytes: stats.size,
        });
      } catch {
        // Gone between the listing and the stat; nothing to index.
      }
    }
  }
  return found;
}

/**
 * Reads the head of a JSONL file as whole lines.
 *
 * Two budgets, because one is not enough. `maxBytes` is what stops a
 * multi-megabyte transcript from being read in full. `maxLines` is what makes
 * the read *useful*: codex writes its instruction preamble as two or three
 * lines that are tens of kilobytes each, so the first real user message can
 * sit 200 KB in while still being line 5.
 *
 * A trailing partial line is dropped rather than returned half-parsed.
 */
export function readLines(
  path: string,
  maxBytes: number,
  maxLines: number,
): string[] {
  let handle: number;
  try {
    handle = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = Math.min(statSync(path).size, maxBytes);
    const buffer = scratch(size);
    let filled = 0;
    while (filled < size) {
      const read = readSync(handle, buffer, filled, size - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    const view = buffer.subarray(0, filled);
    const lines: string[] = [];
    let start = 0;
    while (lines.length < maxLines) {
      const newline = view.indexOf(10, start);
      // Ran out of budget (or hit EOF) mid-line. A fragment of JSON is not
      // worth handing to the parser, so it is dropped.
      if (newline === -1) break;
      // Decoding line by line instead of the whole head at once: a newline
      // byte never occurs inside a UTF-8 sequence, so the boundaries are safe,
      // and the transient is one line rather than the whole budget.
      lines.push(view.toString("utf8", start, newline).trim());
      start = newline + 1;
    }
    return lines;
  } catch {
    return [];
  } finally {
    closeSync(handle);
  }
}

/**
 * The one read buffer, grown on demand and never released.
 *
 * A startup scan opens on the order of a thousand transcripts back to back, and
 * `Buffer.alloc(512 KiB)` per file is half a gigabyte of external allocations
 * in one synchronous stretch — nothing keeps a reference to them, but the
 * process never gets those pages back either. Measured: the boot RSS of a core
 * with 1,378 transcripts on disk was 143 MB against a `heapUsed` of 7.5 MB.
 *
 * Reusing one buffer is safe because {@link readLines} is synchronous: it is
 * filled, decoded and finished with before any other code can run.
 */
let buffer: Buffer = Buffer.alloc(0);

function scratch(size: number): Buffer {
  if (buffer.length < size) buffer = Buffer.alloc(size);
  return buffer;
}

/** Collapses every run of whitespace to one space and trims. */
export function collapse(text: string): string {
  return text.trim().split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Collapse, then cut to `maxChars` *characters* — not bytes. These titles are
 * frequently Chinese, where a byte cut lands mid-character.
 */
export function clamp(text: string, maxChars: number): string {
  const collapsed = collapse(text);
  const characters = [...collapsed];
  return characters.length <= maxChars
    ? collapsed
    : characters.slice(0, maxChars).join("");
}

/** Title as it is stored: collapsed and cut to {@link MAX_TITLE_CHARS}. */
export function title(text: string): string {
  return clamp(text, MAX_TITLE_CHARS);
}

/**
 * The last path segment, used as a fallback label when a session has no
 * readable first message but does name its working directory.
 */
export function basename(path: string): string | undefined {
  const parts = path.split(/[/\\]/).filter((part) => part !== "");
  return parts[parts.length - 1];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
