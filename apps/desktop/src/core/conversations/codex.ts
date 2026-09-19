import { extname, join } from "node:path";
import { codexHome } from "../collab/transcript";
import {
  type Candidate,
  type Parsed,
  basename,
  collect,
  readLines,
  title,
} from "./scan";

/**
 * Codex rollouts — `${CODEX_HOME:-~/.codex}/sessions/ ** /rollout-*.jsonl`.
 *
 * Ported from `apps/runtime/src/index/codex.rs`. Files are filed under
 * `sessions/YYYY/MM/DD/` and named `rollout-<timestamp>-<uuid>.jsonl`. The
 * first record is a `session_meta` carrying the id and the cwd; the turns that
 * follow are `response_item` envelopes around OpenAI-shaped messages.
 *
 * The wrinkle is that codex replays a lot of machinery *as the user*: the
 * permissions block, `AGENTS.md`, the plugin catalogue. Those come first and
 * they are large — the median real first message starts tens of kilobytes into
 * the file, all within the first ten lines. Hence the generous byte budget and
 * the tight line budget.
 */

const HEAD_BYTES = 512 * 1024;
const HEAD_LINES = 24;

/**
 * Openings that mean "codex is talking to itself". A human message that
 * happens to start with `<` does not survive being mistaken for one often
 * enough to matter — the next user turn is used instead.
 */
const SYNTHETIC_PREFIXES = [
  "<user_instructions>",
  "<environment_context>",
  "<recommended_plugins>",
  "<permissions instructions>",
  "<INSTRUCTIONS>",
  "# AGENTS.md instructions",
] as const;

export function root(): string {
  return join(codexHome(), "sessions");
}

export function candidates(root: string): Candidate[] {
  return collect(
    root,
    (path) =>
      extname(path) === ".jsonl" &&
      (basename(path) ?? "").startsWith("rollout-"),
  );
}

export function parse(path: string): Parsed | undefined {
  const stem = (basename(path) ?? "").replace(/\.jsonl$/, "");
  if (stem === "") return undefined;
  return parseLines(stem, readLines(path, HEAD_BYTES, HEAD_LINES));
}

export function parseLines(stem: string, lines: readonly string[]): Parsed {
  let sessionId = sessionIdFromStem(stem) ?? "";
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
    const kind = typeof record.type === "string" ? record.type : "";
    const payload =
      record.payload !== null && typeof record.payload === "object"
        ? (record.payload as Record<string, unknown>)
        : {};
    if (kind === "session_meta") {
      if (sessionId === "" && typeof payload.id === "string") {
        sessionId = payload.id;
      }
      if (cwd === "" && typeof payload.cwd === "string") cwd = payload.cwd;
    } else if (kind === "turn_context") {
      // `turn_context` repeats the cwd; useful when the meta record was
      // written by a version that did not carry one.
      if (cwd === "" && typeof payload.cwd === "string") cwd = payload.cwd;
    }
    if (found === "") {
      const text = userText(kind, payload);
      const candidate = text === undefined ? undefined : usable(text);
      if (candidate !== undefined) found = title(candidate);
    }
    if (cwd !== "" && found !== "" && sessionId !== "") break;
  }
  return { sessionId: sessionId === "" ? stem : sessionId, title: found, cwd };
}

/**
 * The user's words in this record, if it holds any.
 *
 * Two shapes: the persisted conversation item (`response_item` wrapping a
 * `message` with `role: "user"`) and the UI event stream (`event_msg` /
 * `user_message`), which newer builds also write.
 */
function userText(
  kind: string,
  payload: Record<string, unknown>,
): string | undefined {
  if (kind === "response_item") {
    if (payload.type !== "message" || payload.role !== "user") return undefined;
    const content = payload.content;
    if (!Array.isArray(content)) return undefined;
    return content
      .map((block) =>
        block !== null && typeof block === "object"
          ? (block as Record<string, unknown>).text
          : undefined,
      )
      .filter((text): text is string => typeof text === "string")
      .join(" ");
  }
  if (kind === "event_msg") {
    if (payload.type !== "user_message") return undefined;
    return typeof payload.message === "string" ? payload.message : undefined;
  }
  return undefined;
}

export function usable(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (SYNTHETIC_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return undefined;
  }
  return trimmed;
}

/**
 * `rollout-2026-09-04T02-06-15-01a06873-…-2224a11ce547` → the trailing UUID.
 *
 * The timestamp in the middle also contains dashes, so the id is taken as the
 * last 36 characters and only accepted if it is shaped like a UUID; anything
 * else falls back to the `session_meta` record.
 */
export function sessionIdFromStem(stem: string): string | undefined {
  const characters = [...stem];
  if (characters.length < 36) return undefined;
  const tail = characters.slice(characters.length - 36).join("");
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    tail,
  )
    ? tail
    : undefined;
}
