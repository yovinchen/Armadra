import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Locating and rendering another agent's transcript.
 *
 * Ported from the pre-merge implementation. Every CLI writes its
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
      const read = readSync(
        handle,
        buffer,
        filled,
        size - filled,
        start + filled,
      );
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
 * 渲染的两档（设计 `agent-delivery.md` §13 第 2 条）。
 *
 * 缺省这一档就是这个模块一直以来的行为，所以 `render(text)` 一个字都不用改。
 * `transcript` 那条路传的是收紧过的一档：每条消息截到 2 KB，`tool_result` 只
 * 留工具名、字节数与首行——工具结果是一份转录里最长、对读者最没用的一段，一
 * 次 `Read` 的回显就能顶掉整份预算。
 */
export interface RenderOptions {
  /** 一条消息截到这么多个字符。 */
  readonly maxLineChars?: number;
  /** `tool_result` 只留工具名、字节数与首行。 */
  readonly briefToolResults?: boolean;
}

interface RenderContext {
  readonly maxLineChars: number;
  readonly briefToolResults: boolean;
  /**
   * `tool_use_id` → 工具名，跨条目累积。
   *
   * `tool_result` 自己不带工具名，只带它回应的那次调用的 id；要说出「这是哪个
   * 工具的结果」就得记得前面那条 `tool_use`。一份转录是按时间顺序读的，所以这
   * 张表只需要往前看。
   */
  readonly toolNames: Map<string, string>;
}

function contextOf(options: RenderOptions | undefined): RenderContext {
  return {
    maxLineChars: options?.maxLineChars ?? MAX_LINE,
    briefToolResults: options?.briefToolResults ?? false,
    toolNames: new Map(),
  };
}

/**
 * 一条渲染好的记录，外加它在源文本里结束于第几个字节。
 *
 * 那个偏移是增量游标的全部实现（§13 第 3 条）：交出去 N 条之后，下次从第 N 条
 * 之后那个字节接着读。它算的是**源文本**的字节，不是渲染出来的散文的字节。
 */
export interface TranscriptRecord {
  readonly line: string;
  readonly endOffset: number;
}

/** 一次增量读取的结果：读到的文本，以及现在的文件尾在第几个字节。 */
export interface Range {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * 从 `startByte` 读到文件尾，最多 `maxBytes`（增量游标那条路）。
 *
 * 偏移大于文件长度的时候从头读：转录被换掉或者被截短了，那个偏移在新内容里指
 * 的是另一段话。路径是否还是同一个由游标自己判（`context-reads.ts`），长度这
 * 一层的判据在这里。
 */
export function readRange(
  path: string,
  startByte: number,
  maxBytes: number,
): Range {
  const handle = openSync(path, "r");
  try {
    const length = statSync(path).size;
    const start = startByte > length || startByte < 0 ? 0 : startByte;
    // 超过上限时保留**尾部**：新的那些比旧的那些有用。
    const from = Math.max(start, length - maxBytes);
    const size = Math.max(0, length - from);
    if (size === 0) return { text: "", startOffset: from, endOffset: length };
    const buffer = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      const read = readSync(
        handle,
        buffer,
        filled,
        size - filled,
        from + filled,
      );
      if (read === 0) break;
      filled += read;
    }
    return {
      text: buffer.subarray(0, filled).toString("utf8"),
      startOffset: from,
      endOffset: length,
    };
  } finally {
    closeSync(handle);
  }
}

/**
 * Renders JSONL (or a JSON array / object of messages) into one line per
 * message. Unknown lines are skipped rather than reported.
 */
export function render(text: string, options?: RenderOptions): string[] {
  return renderRecords(text, options).map((record) => record.line);
}

/** {@link render}，但每条还带着它在源文本里的结束偏移。 */
export function renderRecords(
  text: string,
  options?: RenderOptions,
): TranscriptRecord[] {
  const context = contextOf(options);
  const total = Buffer.byteLength(text, "utf8");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      value = undefined;
    }
    if (value !== undefined) {
      const rendered = renderDocument(value, context);
      // 整份 JSON 没有「读到一半」这回事：偏移一律是文件尾。
      if (rendered.length > 0) {
        return rendered.map((line) => ({ line, endOffset: total }));
      }
    }
  }
  const records: TranscriptRecord[] = [];
  let offset = 0;
  for (const raw of text.split("\n")) {
    // `+1` 是被 `split` 吃掉的那个换行；最后一段多算一个字节不影响判据（游标
    // 只会因此少读零字节），但少算会让同一条被读第二次。
    offset += Buffer.byteLength(raw, "utf8") + 1;
    const line = raw.trim();
    if (line === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const rendered = renderEntry(value, context);
    if (rendered !== undefined) {
      records.push({ line: rendered, endOffset: Math.min(offset, total) });
    }
  }
  return records;
}

function renderDocument(value: unknown, context: RenderContext): string[] {
  const render = (entry: unknown): string | undefined =>
    renderEntry(entry, context);
  if (Array.isArray(value)) {
    return value
      .map(render)
      .filter((line): line is string => line !== undefined);
  }
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["messages", "history", "chat", "turns", "items"]) {
    const items = record[key];
    if (Array.isArray(items)) {
      return items
        .map(render)
        .filter((line): line is string => line !== undefined);
    }
  }
  return [];
}

const ROLES = ["user", "assistant", "system"];

/** One transcript entry → one prose line, or nothing. */
export function renderEntry(
  value: unknown,
  options?: RenderOptions | RenderContext,
): string | undefined {
  const context = isContext(options) ? options : contextOf(options);
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  // Codex wraps everything in `{type, payload}`; unwrap once.
  const payload = record.payload;
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload)
  ) {
    return renderEntry(payload, context);
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

  const body = renderContent(content, context).trim();
  if (body === "") return undefined;
  const label =
    role === "user" ? "[用户]" : role === "assistant" ? "[助手]" : "[系统]";
  // A tool line already carries its own label.
  if (body.startsWith("[工具") || body.startsWith("[结果")) {
    return clamp(body, context.maxLineChars);
  }
  return clamp(`${label} ${body}`, context.maxLineChars);
}

function isContext(
  options: RenderOptions | RenderContext | undefined,
): options is RenderContext {
  return options !== undefined && "toolNames" in options;
}

/** `content` is a string in some CLIs and a block array in others. */
function renderContent(content: unknown, context: RenderContext): string {
  if (typeof content === "string") return collapse(content);
  if (Array.isArray(content)) {
    return content
      .map((block) => renderBlock(block, context))
      .filter((part): part is string => part !== undefined)
      .join(" ");
  }
  if (content !== null && typeof content === "object") {
    return renderBlock(content, context) ?? "";
  }
  return "";
}

function renderBlock(
  block: unknown,
  context: RenderContext,
): string | undefined {
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
      const name = typeof record.name === "string" ? record.name : "未命名工具";
      const id = record.id ?? record.tool_use_id ?? record.call_id;
      if (typeof id === "string" && id !== "") context.toolNames.set(id, name);
      const input = record.input ?? record.arguments;
      const detail = input === undefined ? "" : summarizeInput(input);
      return detail === "" ? `[工具 ${name}]` : `[工具 ${name} ${detail}]`;
    }
    case "tool_result":
    case "function_call_output": {
      const detail =
        record.content === undefined
          ? ""
          : typeof record.content === "string"
            ? record.content
            : renderContent(record.content, context);
      if (!context.briefToolResults) {
        return `[结果 ${shorten(collapse(detail), MAX_TOOL_DETAIL)}]`;
      }
      const id = record.tool_use_id ?? record.call_id ?? record.id;
      const name =
        (typeof id === "string" ? context.toolNames.get(id) : undefined) ??
        "工具";
      const bytes = Buffer.byteLength(detail, "utf8");
      const first = collapse(detail.split("\n")[0] ?? "");
      return `[结果 ${name} ${bytes} B${first === "" ? "" : ` 首行：${shorten(first, MAX_TOOL_DETAIL)}`}]`;
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
  if (typeof input === "string")
    return shorten(collapse(input), MAX_TOOL_DETAIL);
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

function clamp(line: string, maxChars: number): string {
  return shorten(line, maxChars);
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
