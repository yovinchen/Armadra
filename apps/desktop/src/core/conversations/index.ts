import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import * as claude from "./claude";
import * as codex from "./codex";
import { type Parsed, clamp } from "./scan";

/**
 * The conversations index — "resume this conversation", across projects.
 *
 * Ported from `apps/runtime/src/index/mod.rs`. Every agent CLI leaves its
 * history somewhere under the user's home directory. This module walks those
 * directories, reads the first user message out of each transcript, and keeps
 * a `(provider, session_id) → title` table so the command palette can offer
 * past sessions.
 *
 * It is **read-only about other programs' files**. Nothing here writes into a
 * CLI's config home, and a directory that cannot be read is a warning and an
 * empty palette group, never a startup failure.
 *
 * Three properties make it cheap enough to run on a timer:
 *
 *   * **mtime is the cache key.** A file whose mtime matches the row already
 *     stored is never opened, so a rescan of a few thousand transcripts is a
 *     few thousand `stat` calls and no reads.
 *   * **Everything is bounded** — files per provider, walk depth, bytes and
 *     lines per file. See `scan.ts`.
 *   * **It never blocks a request.** The startup scan runs after the listener
 *     is bound.
 *
 * Rows are keyed by session id rather than by path so that a moved or
 * rewritten file updates its row instead of duplicating it; a row whose file
 * has disappeared is dropped at the end of the scan.
 */

/** Providers whose transcripts this build knows how to read. */
export const PROVIDERS = ["claude", "codex"] as const;

export type Provider = (typeof PROVIDERS)[number];

/** How often the index is refreshed once the core is up. */
export const REFRESH_INTERVAL_MS = 60_000;

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

/** A node header is narrow; anything longer than this is not a title. */
export const MAX_SUGGESTED_TITLE_CHARS = 40;

export interface Conversation {
  readonly provider: string;
  readonly sessionId: string;
  readonly title: string;
  readonly cwd: string;
  readonly updatedAt: string;
  readonly bytes: number;
}

/** What one pass over the transcript directories did. */
export interface ScanReport {
  /** Transcript files looked at, across all providers. */
  readonly scanned: number;
  /** Rows written because the file was new or its mtime moved. */
  readonly indexed: number;
  /** Rows dropped because their file is gone. */
  readonly removed: number;
  /** Rows in the index afterwards. */
  readonly total: number;
}

export type Roots = readonly (readonly [Provider, string])[];

/** Where each provider keeps its transcripts on this machine. */
export function defaultRoots(): Roots {
  return [
    ["claude", claude.root()],
    ["codex", codex.root()],
  ];
}

/**
 * One pass over every provider.
 *
 * The roots are a parameter because `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are
 * process-wide: a test that set them would race every other test in the file.
 * Passing them lets the scanners be exercised against a temporary tree.
 */
export function refresh(
  database: DatabaseSync,
  roots: Roots = defaultRoots(),
): ScanReport {
  let scanned = 0;
  let indexed = 0;
  let removed = 0;
  for (const [provider, root] of roots) {
    const known = knownMtimes(database, provider);
    const { rows, seen } = scanProvider(provider, root, known);
    scanned += seen.length;
    indexed += upsert(database, rows);
    removed += forgetMissing(database, provider, root, seen);
  }
  return { scanned, indexed, removed, total: count(database) };
}

interface IndexRow {
  readonly provider: Provider;
  readonly sessionId: string;
  readonly title: string;
  readonly cwd: string;
  readonly path: string;
  readonly updatedAt: string;
  readonly bytes: number;
}

/**
 * Walks one provider.
 *
 * Returns the rows that need writing and every path that still exists —
 * including the unchanged ones, which are what keeps the prune from deleting
 * rows it merely skipped.
 */
function scanProvider(
  provider: Provider,
  root: string,
  known: Map<string, string>,
): { rows: IndexRow[]; seen: string[] } {
  const found =
    provider === "codex" ? codex.candidates(root) : claude.candidates(root);
  const rows: IndexRow[] = [];
  const seen: string[] = [];
  for (const candidate of found) {
    seen.push(candidate.path);
    // Unchanged since the row was written: no read, no write.
    if (known.get(candidate.path) === candidate.updatedAt) continue;
    const parsed: Parsed | undefined =
      provider === "codex"
        ? codex.parse(candidate.path)
        : claude.parse(candidate.path);
    if (parsed === undefined || parsed.sessionId === "") continue;
    // A session whose opening message could not be read is still worth a row —
    // it is resumable — so it borrows its directory's name.
    const title =
      parsed.title === "" ? claude.fallbackTitle(parsed.cwd) : parsed.title;
    rows.push({
      provider,
      sessionId: parsed.sessionId,
      title,
      cwd: parsed.cwd,
      path: candidate.path,
      updatedAt: candidate.updatedAt,
      bytes: candidate.bytes,
    });
  }
  return { rows, seen };
}

/* ---------------------------------- store --------------------------------- */

/** `path → updated_at` for one provider: what makes a rescan cheap. */
function knownMtimes(
  database: DatabaseSync,
  provider: string,
): Map<string, string> {
  const rows = database
    .prepare("SELECT path, updated_at FROM conversations WHERE provider = ?")
    .all(provider) as { path: string; updated_at: string }[];
  return new Map(rows.map((row) => [row.path, row.updated_at]));
}

function upsert(database: DatabaseSync, rows: readonly IndexRow[]): number {
  if (rows.length === 0) return 0;
  const statement = database.prepare(
    "INSERT INTO conversations (provider, session_id, title, cwd, path, updated_at, bytes) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(provider, session_id) DO UPDATE SET " +
      "title = excluded.title, cwd = excluded.cwd, path = excluded.path, " +
      "updated_at = excluded.updated_at, bytes = excluded.bytes",
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      statement.run(
        row.provider,
        row.sessionId,
        row.title,
        row.cwd,
        row.path,
        row.updatedAt,
        row.bytes,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return rows.length;
}

/**
 * Drops rows whose file the walk no longer finds.
 *
 * The one special case is a provider whose root directory is gone: an absent
 * `~/.codex` means codex was uninstalled or its home moved, and every row for
 * it is stale. A root that exists but yielded nothing is the ordinary case of
 * "all of those transcripts were deleted".
 */
function forgetMissing(
  database: DatabaseSync,
  provider: string,
  root: string,
  seen: readonly string[],
): number {
  let present = false;
  try {
    present = statSync(root).isDirectory();
  } catch {
    present = false;
  }
  if (!present) {
    const deleted = database
      .prepare("DELETE FROM conversations WHERE provider = ?")
      .run(provider);
    return Number(deleted.changes);
  }
  const alive = new Set(seen);
  const stored = database
    .prepare("SELECT session_id, path FROM conversations WHERE provider = ?")
    .all(provider) as { session_id: string; path: string }[];
  let removed = 0;
  for (const row of stored) {
    if (alive.has(row.path)) continue;
    database
      .prepare("DELETE FROM conversations WHERE provider = ? AND session_id = ?")
      .run(provider, row.session_id);
    removed += 1;
  }
  return removed;
}

export function count(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT COUNT(*) AS total FROM conversations")
    .get() as { total: number };
  return Number(row.total);
}

/**
 * `GET /api/conversations?q=&limit=` — newest first, case-insensitive
 * substring match on the title or the working directory.
 *
 * The match is done in SQL with `LIKE` on lowered columns rather than in
 * TypeScript so that `limit` limits the work, not just the output. `LIKE`
 * metacharacters in the query are escaped: a user typing `100%` is searching
 * for a literal percent sign.
 */
export function listConversations(
  database: DatabaseSync,
  query: string | undefined,
  limit: number,
): Conversation[] {
  const bounded = Math.min(MAX_LIMIT, Math.max(1, limit));
  const needle = query?.trim();
  const rows =
    needle === undefined || needle === ""
      ? (database
          .prepare(
            "SELECT provider, session_id, title, cwd, updated_at, bytes FROM conversations " +
              "ORDER BY updated_at DESC LIMIT ?",
          )
          .all(bounded) as unknown as ConversationRow[])
      : (database
          .prepare(
            "SELECT provider, session_id, title, cwd, updated_at, bytes FROM conversations " +
              "WHERE lower(title) LIKE ?1 ESCAPE '\\' OR lower(cwd) LIKE ?1 ESCAPE '\\' " +
              "ORDER BY updated_at DESC LIMIT ?2",
          )
          .all(
            `%${escapeLike(needle.toLowerCase())}%`,
            bounded,
          ) as unknown as ConversationRow[]);
  return rows.map((row) => ({
    provider: row.provider,
    sessionId: row.session_id,
    title: row.title,
    cwd: row.cwd,
    updatedAt: row.updated_at,
    bytes: Number(row.bytes),
  }));
}

interface ConversationRow {
  readonly provider: string;
  readonly session_id: string;
  readonly title: string;
  readonly cwd: string;
  readonly updated_at: string;
  readonly bytes: number;
}

/* ------------------------------- suggest title ----------------------------- */

/**
 * The first user message of a transcript, if that transcript has one we can
 * read. Reuses whichever provider parser matches the agent — the same code
 * that fills the index, so a title suggested here and a title shown in the
 * palette agree.
 */
export function transcriptTitle(
  agentId: string,
  path: string,
): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const parsed =
    agentId === "codex"
      ? codex.parse(path)
      : // Custom agents borrow a base agent's adapter and claude's JSONL shape
        // is the common one, so it is also the default.
        claude.parse(path);
  if (parsed === undefined) return undefined;
  const title = clamp(parsed.title, MAX_SUGGESTED_TITLE_CHARS);
  return title === "" ? undefined : title;
}

/**
 * Prompt characters a shell may end its prompt with.
 *
 * `❯` covers the common zsh themes; `#` is deliberately absent because a root
 * prompt and a comment look the same and guessing wrong turns a comment into a
 * title.
 */
const PROMPT_MARKERS = ["$", "%", "❯"];

/**
 * The last command typed in a terminal, read out of a capture snapshot.
 *
 * Scans upward for a line that carries a prompt marker and has something after
 * it. Output lines do not, which is what keeps a stack trace or a file listing
 * from being offered as the node's name. The prompt itself is dropped: the
 * text after the *last* marker on the line is the command, because a path in
 * the prompt may well contain a `%` of its own.
 */
export function commandFromCapture(capture: string): string | undefined {
  const lines = capture.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] as string).trimEnd();
    let marker = -1;
    for (const candidate of PROMPT_MARKERS) {
      marker = Math.max(marker, line.lastIndexOf(candidate));
    }
    if (marker === -1) continue;
    const command = line.slice(marker + 1).trim();
    if (command === "") continue;
    const title = clamp(command, MAX_SUGGESTED_TITLE_CHARS);
    if (title !== "") return title;
  }
  return undefined;
}

function escapeLike(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

export { claude, codex };
