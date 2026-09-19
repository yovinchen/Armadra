import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Locating and rendering another agent's transcript.
 *
 * Ported from `apps/runtime/src/collab/transcript.rs`. Every CLI writes its
 * history somewhere different and none of them promise the shape, so this
 * module is deliberately forgiving: it reads the tail of a file, renders the
 * lines it recognises, and skips the ones it does not. A transcript we can
 * only half read is far more useful to the agent asking than an error, and one
 * we cannot find at all is reported in a sentence rather than as a failure.
 */

/** Only the tail of a transcript is read; a long session is megabytes of JSON. */
export const MAX_TAIL_BYTES = 5 * 1024 * 1024;
/** `transcript` renders everything it found, up to this many bytes of prose. */
export const MAX_RENDERED_BYTES = 200 * 1024;
/** A tool's input is quoted, not dumped. */
const MAX_TOOL_DETAIL = 120;
/** One rendered message line is trimmed to this before it reaches the agent. */
const MAX_LINE = 2_000;
/** Ceiling on how many directory entries a session-id search will look at. */
const MAX_SCAN_ENTRIES = 20_000;
const MAX_SCAN_DEPTH = 6;

/** Where a transcript came from, so the reply can say so. */
export interface Located {
  readonly path: string;
  /** Human sentence naming the provider and file. */
  readonly origin: string;
}

/**
 * Reads at most the last `maxBytes` of a file, starting at the first newline
 * inside the window so the first line is never a fragment.
 */
export function readTail(path: string, maxBytes: number): string {
  const handle = openSync(path, "r");
  try {
    const length = statSync(path).size;
    const start = Math.max(0, length - maxBytes);
    const size = Math.min(length - start, maxBytes);
    const buffer = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      const read = readSync(handle, buffer, filled, size - filled, start + filled);
      if (read === 0) break;
      filled += read;
    }
    const text = buffer.subarray(0, filled).toString("utf8");
    if (start === 0) return text;
    const newline = text.indexOf("\n");
    return newline === -1 ? "" : text.slice(newline + 1);
  } finally {
    closeSync(handle);
  }
}

/**
 * Renders JSONL (or a JSON array / object of messages) into one line per
 * message. Unknown lines are skipped rather than reported.
 */
export function render(text: string): string[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      value = undefined;
    }
    if (value !== undefined) {
      const rendered = renderDocument(value);
      if (rendered.length > 0) return rendered;
    }
  }
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const rendered = renderEntry(value);
    if (rendered !== undefined) lines.push(rendered);
  }
  return lines;
}

function renderDocument(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(renderEntry)
      .filter((line): line is string => line !== undefined);
  }
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["messages", "history", "chat", "turns", "items"]) {
    const items = record[key];
    if (Array.isArray(items)) {
      return items
        .map(renderEntry)
        .filter((line): line is string => line !== undefined);
    }
  }
  return [];
}

const ROLES = ["user", "assistant", "system"];

/** One transcript entry → one prose line, or nothing. */
export function renderEntry(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  // Codex wraps everything in `{type, payload}`; unwrap once.
  const payload = record.payload;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    return renderEntry(payload);
  }
  const kind = record.type;
  const role =
    typeof kind === "string" && ROLES.includes(kind)
      ? kind
      : typeof record.role === "string"
        ? record.role
        : undefined;
  if (role === undefined) return undefined;

  const message = record.message;
  const content =
    message !== null && typeof message === "object" && !Array.isArray(message)
      ? ((message as Record<string, unknown>).content ??
        record.content ??
        record.text)
      : (record.content ?? record.text);
  if (content === undefined || content === null) return undefined;

  const body = renderContent(content).trim();
  if (body === "") return undefined;
  const label =
    role === "user" ? "[用户]" : role === "assistant" ? "[助手]" : "[系统]";
  // A tool line already carries its own label.
  if (body.startsWith("[工具") || body.startsWith("[结果")) return clamp(body);
  return clamp(`${label} ${body}`);
}

/** `content` is a string in some CLIs and a block array in others. */
function renderContent(content: unknown): string {
  if (typeof content === "string") return collapse(content);
  if (Array.isArray(content)) {
    return content
      .map(renderBlock)
      .filter((part): part is string => part !== undefined)
      .join(" ");
  }
  if (content !== null && typeof content === "object") {
    return renderBlock(content) ?? "";
  }
  return "";
}

function renderBlock(block: unknown): string | undefined {
  if (block === null || typeof block !== "object") return undefined;
  const record = block as Record<string, unknown>;
  const kind = typeof record.type === "string" ? record.type : "text";
  switch (kind) {
    case "text":
    case "output_text":
    case "input_text": {
      const text = record.text;
      if (typeof text !== "string") return undefined;
      const collapsed = collapse(text);
      return collapsed === "" ? undefined : collapsed;
    }
    case "tool_use":
    case "function_call": {
      const name =
        typeof record.name === "string" ? record.name : "未命名工具";
      const input = record.input ?? record.arguments;
      const detail = input === undefined ? "" : summarizeInput(input);
      return detail === "" ? `[工具 ${name}]` : `[工具 ${name} ${detail}]`;
    }
    case "tool_result":
    case "function_call_output": {
      const detail =
        record.content === undefined ? "" : renderContent(record.content);
      return `[结果 ${shorten(detail.trim(), MAX_TOOL_DETAIL)}]`;
    }
    // Thinking blocks are the model talking to itself; not somebody else's
    // context.
    default:
      return undefined;
  }
}

/** A tool's arguments reduced to the one field a reader cares about. */
function summarizeInput(input: unknown): string {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const key of [
      "file_path",
      "path",
      "command",
      "pattern",
      "query",
      "url",
      "description",
      "prompt",
    ]) {
      const value = record[key];
      if (typeof value === "string") {
        return shorten(collapse(value), MAX_TOOL_DETAIL);
      }
    }
    if (Object.keys(record).length === 0) return "";
  }
  if (typeof input === "string") return shorten(collapse(input), MAX_TOOL_DETAIL);
  return shorten(collapse(JSON.stringify(input) ?? ""), MAX_TOOL_DETAIL);
}

function collapse(text: string): string {
  return text.trim().split(/\s+/).filter(Boolean).join(" ");
}

function shorten(text: string, maxChars: number): string {
  const characters = [...text];
  if (characters.length <= maxChars) return text;
  return `${characters.slice(0, maxChars).join("")}…`;
}

function clamp(line: string): string {
  return shorten(line, MAX_LINE);
}

/* -------------------------------- locating -------------------------------- */

export function home(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir() ?? ".";
}

export function codexHome(): string {
  const configured = process.env.CODEX_HOME;
  if (configured !== undefined && configured !== "") return configured;
  return join(home(), ".codex");
}

/**
 * Finds the transcript for a node.
 *
 * `transcriptPath` is what the CLI itself reported (claude); the others are
 * found by session id under their own config home. A provider with neither is
 * `undefined`, which the caller must report as "this CLI keeps nothing
 * readable" rather than as an empty conversation.
 */
export function locate(
  agentId: string,
  transcriptPath: string | undefined,
  sessionId: string | undefined,
): Located | undefined {
  if (transcriptPath !== undefined && isFile(transcriptPath)) {
    return { path: transcriptPath, origin: `转录文件 ${transcriptPath}` };
  }
  if (sessionId === undefined || sessionId === "") return undefined;
  if (agentId !== "codex") return undefined;
  const found = findUnder(
    join(codexHome(), "sessions"),
    (name) =>
      name.startsWith("rollout-") &&
      name.includes(sessionId) &&
      name.endsWith(".jsonl"),
  );
  return found === undefined
    ? undefined
    : { path: found, origin: `Codex 会话记录 ${found}` };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A bounded walk that answers with the newest matching file.
 *
 * Codex does not document its directory layout, so the search is by file name;
 * the bounds are what keep a surprising layout (a symlink loop, a
 * million-file cache) from turning a read into a hang.
 */
export function findUnder(
  root: string,
  matches: (name: string) => boolean,
): string | undefined {
  if (!isDirectory(root)) return undefined;
  const frontier: [string, number][] = [[root, 0]];
  let seen = 0;
  let best: { modified: number; path: string } | undefined;
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
      if (seen > MAX_SCAN_ENTRIES) return best?.path;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH) frontier.push([path, depth + 1]);
        continue;
      }
      if (!entry.isFile() || !matches(entry.name)) continue;
      let modified = 0;
      try {
        modified = statSync(path).mtimeMs;
      } catch {
        modified = 0;
      }
      if (best === undefined || modified > best.modified) {
        best = { modified, path };
      }
    }
  }
  return best?.path;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
