import { dirname, extname, join, resolve } from "node:path";
import { home } from "../collab/transcript";
import {
  type Candidate,
  type Parsed,
  basename,
  collect,
  readLines,
  title,
} from "./scan";

/**
 * Claude Code transcripts — `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*.jsonl`.
 *
 * Ported from the pre-merge implementation. One file per session, named
 * after the session id, inside a directory named after the flattened project
 * path. Sub-agent transcripts live one level deeper and are deliberately *not*
 * indexed: they are not sessions a human resumes.
 */

/**
 * Sessions are short JSONL lines and the first user message is at the top, so
 * a small window finds it.
 */
const HEAD_BYTES = 64 * 1024;
const HEAD_LINES = 200;

/**
 * Text the CLI injects on the user's behalf. A slash command, a hook's stdout
 * or a caveat banner is not what the session is *about*, so these are skipped
 * and the next user message is tried instead.
 */
const SYNTHETIC_PREFIXES = [
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<command-name>",
  "<command-message>",
  "<task-notification>",
] as const;

export function claudeHome(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (configured !== undefined && configured !== "") return configured;
  return join(home(), ".claude");
}

export function root(): string {
  return join(claudeHome(), "projects");
}

/** `<projects>/<project>/<session>.jsonl` and nothing deeper. */
export function candidates(root: string): Candidate[] {
  const base = resolve(root);
  return collect(
    root,
    (path) =>
      extname(path) === ".jsonl" && resolve(dirname(dirname(path))) === base,
  );
}

export function parse(path: string): Parsed | undefined {
  const stem = (basename(path) ?? "").replace(/\.jsonl$/, "");
  if (stem === "") return undefined;
  return parseLines(stem, readLines(path, HEAD_BYTES, HEAD_LINES));
}

/** Split out from {@link parse} so a test can feed it literal lines. */
export function parseLines(
  sessionId: string,
  lines: readonly string[],
): Parsed {
  let cwd = "";
  let found = "";
  for (const line of lines) {
    if (line === "") continue;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== "object") continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    // Every record carries the same `cwd`; the first one that has it wins.
    if (cwd === "" && typeof record.cwd === "string") cwd = record.cwd;
    if (found === "" && record.type === "user") {
      const message = record.message;
      const content =
        message !== null && typeof message === "object"
          ? (message as Record<string, unknown>).content
          : undefined;
      const text = content === undefined ? "" : userText(content);
      const candidate = usable(text);
      if (candidate !== undefined) found = title(candidate);
    }
    if (cwd !== "" && found !== "") break;
  }
  // No fallback here: an empty title is a fact the caller may need — the
  // suggest-title endpoint must not answer with a directory name — and the
  // indexer fills it in itself.
  return { sessionId, title: found, cwd };
}

/**
 * `content` is a plain string for a typed prompt and a block array once
 * attachments or tool results are involved. Only the text blocks matter: a
 * user turn that is nothing but a `tool_result` renders empty and is skipped.
 */
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block !== null && typeof block === "object"
          ? (block as Record<string, unknown>).text
          : undefined,
      )
      .filter((text): text is string => typeof text === "string")
      .join(" ");
  }
  return "";
}

/** `undefined` when the text is CLI machinery rather than a user message. */
export function usable(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (SYNTHETIC_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return undefined;
  }
  return trimmed;
}

/**
 * A session whose first message could not be read still deserves a row: it is
 * resumable, and the directory name is what the user recognises it by.
 */
export function fallbackTitle(cwd: string): string {
  const name = basename(cwd);
  return name === undefined ? "" : title(name);
}
