import type { TargetState } from "../agent/target-state";
import { redact } from "./redact";

/**
 * `context summary` 真的变成一份摘要（设计 `agent-delivery.md` §13 第 1 条）。
 *
 * 在这之前 `summary` 是一个名字上的谎：它给的是对方转录最近 40 条**原文**，上
 * 限 200 KB。一个 Agent 连着三个节点各读一次，就是十几万 token 进它的上下文，
 * 而它想知道的通常只有五句话：对方是谁、在干什么、最后有人跟它说了什么、它回
 * 了什么、它碰了哪些文件。
 *
 * 这个模块就是那五句话，纯函数、没有 I/O：输入是一段转录文本加几条外面查好的
 * 事实，输出是一段 ≤ {@link MAX_SUMMARY_BYTES} 的散文。读文件、查状态、查待审
 * 批是 `context-link.ts` 的事——它们都要数据库或磁盘，而摘要的规则一条也不需
 * 要，分开之后这一半可以被用例整表覆盖。
 */

/** 摘要的字节上限。超出就截断，因为「摘要很长」本身就是摘要写坏了。 */
export const MAX_SUMMARY_BYTES = 2 * 1024;

/** 最后一条提示 / 回复各留这么多个字符。 */
export const MAX_QUOTE_CHARS = 500;

/** 最多列这么多个碰过的文件路径。 */
export const MAX_FILES = 20;

/** 从转录里读出来的那几件事。 */
export interface TranscriptDigest {
  /** 最后一条人类提示，已截断。 */
  readonly lastUser?: string;
  /** 最后一条助手回复，已截断。 */
  readonly lastAssistant?: string;
  /** 这一份转录里碰过的文件路径，去重、保序、最多 {@link MAX_FILES} 条。 */
  readonly files: readonly string[];
  /** 文件路径是不是被上限截掉了一部分。 */
  readonly filesTruncated: boolean;
  /** 工具调用次数。 */
  readonly toolCalls: number;
  /** 认出来的条目数，用来说明这份摘要是从多少条里读出来的。 */
  readonly entries: number;
}

/** 摘要头一行要的那几条事实，都由调用方查好。 */
export interface SummaryFacts {
  readonly title: string;
  /** `node_handles` 里的名字，没有就没有。 */
  readonly handle?: string | undefined;
  /** `agent/target-state.ts` 的五态。 */
  readonly state: TargetState;
  /** `agent/approvals.ts::hasOpenApproval` 的答案。 */
  readonly pendingApproval: boolean;
  /** 转录是从哪找到的，一句话。 */
  readonly origin: string;
}

const STATE_LABELS: Record<TargetState, string> = {
  starting: "刚起来，还没报过状态",
  idle: "空闲",
  busy: "正在一轮里",
  "awaiting-approval": "停在权限提示上",
  exited: "会话已经不在了",
};

/** 五态的中文说法。散文给模型读，机器码在别处（回执的 `targetState`）。 */
export function stateLabel(state: TargetState): string {
  return STATE_LABELS[state];
}

/* --------------------------------- 提取 ---------------------------------- */

/**
 * 一段转录 → 摘要要的那几件事。
 *
 * 宽容到底，与 `transcript.ts::render` 同一条态度：每个 CLI 的转录形状都不一
 * 样、都没承诺过，认不出来的行直接跳过。认出一半也比报错有用。
 */
export function digestTranscript(text: string): TranscriptDigest {
  let lastUser: string | undefined;
  let lastAssistant: string | undefined;
  const files: string[] = [];
  const seen = new Set<string>();
  let dropped = false;
  let toolCalls = 0;
  let entries = 0;

  for (const value of entriesOf(text)) {
    const entry = readEntry(value);
    if (entry === undefined) continue;
    entries += 1;
    toolCalls += entry.toolCalls;
    for (const path of entry.files) {
      if (seen.has(path)) continue;
      if (files.length >= MAX_FILES) {
        dropped = true;
        continue;
      }
      seen.add(path);
      files.push(path);
    }
    if (entry.text === "") continue;
    if (entry.role === "user") lastUser = entry.text;
    else if (entry.role === "assistant") lastAssistant = entry.text;
  }

  return {
    ...(lastUser === undefined ? {} : { lastUser: quote(lastUser) }),
    ...(lastAssistant === undefined ? {} : { lastAssistant: quote(lastAssistant) }),
    files,
    filesTruncated: dropped,
    toolCalls,
    entries,
  };
}

/* --------------------------------- 渲染 ---------------------------------- */

/** 摘要的散文。调用方直接把它交给 Agent。 */
export function renderSummary(
  facts: SummaryFacts,
  digest: TranscriptDigest,
): string {
  const name = facts.handle === undefined ? "" : `（名字=${facts.handle}）`;
  let out = `「${facts.title}」${name}摘要 —— 状态：${stateLabel(facts.state)}`;
  out += facts.pendingApproval ? "，有待审批的权限提示\n" : "\n";
  out += `来源：${facts.origin}，读了 ${digest.entries} 条；工具调用 ${digest.toolCalls} 次\n`;
  if (digest.lastUser !== undefined) {
    out += `\n最后一条人类提示：${digest.lastUser}\n`;
  }
  if (digest.lastAssistant !== undefined) {
    out += `\n最后一条助手回复：${digest.lastAssistant}\n`;
  }
  if (digest.files.length > 0) {
    out += `\n这一轮碰过的文件（${digest.files.length} 个${digest.filesTruncated ? "，还有更多" : ""}）：\n`;
    for (const path of digest.files) out += `- ${path}\n`;
  }
  if (
    digest.lastUser === undefined &&
    digest.lastAssistant === undefined &&
    digest.files.length === 0
  ) {
    out += "\n转录里还没有可读的对话。\n";
  }
  out +=
    "\n要原文用 `context transcript --node ...`（默认 20 条，`--since` 只给新的）。\n";
  // 脱敏在最后一步：提示与回复都可能整句带着一个 token。
  return cut(redact(out), MAX_SUMMARY_BYTES);
}

/* -------------------------------- 内部实现 -------------------------------- */

interface Parsed {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly files: readonly string[];
  readonly toolCalls: number;
}

/** 转录文本 → 一串待解析的条目。JSONL、JSON 数组与 `{messages: []}` 都收。 */
export function entriesOf(text: string): unknown[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      value = undefined;
    }
    const items = documentItems(value);
    if (items !== undefined) return items;
  }
  const out: unknown[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return out;
}

function documentItems(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["messages", "history", "chat", "turns", "items"]) {
    const items = record[key];
    if (Array.isArray(items)) return items;
  }
  return undefined;
}

const ROLES = ["user", "assistant", "system"] as const;

function readEntry(value: unknown): Parsed | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  // Codex 把一切包进 `{type, payload}`，剥一层。
  const payload = record.payload;
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload)
  ) {
    return readEntry(payload);
  }
  const kind = record.type;
  const named =
    typeof kind === "string" && (ROLES as readonly string[]).includes(kind)
      ? kind
      : typeof record.role === "string"
        ? record.role
        : undefined;
  if (named === undefined || !(ROLES as readonly string[]).includes(named)) {
    return undefined;
  }
  const message = record.message;
  const content =
    message !== null && typeof message === "object" && !Array.isArray(message)
      ? ((message as Record<string, unknown>).content ??
        record.content ??
        record.text)
      : (record.content ?? record.text);
  if (content === undefined || content === null) return undefined;

  const parts: string[] = [];
  const files: string[] = [];
  let toolCalls = 0;
  walk(content, parts, files, () => {
    toolCalls += 1;
  });
  return {
    role: named as Parsed["role"],
    text: collapse(parts.join(" ")),
    files,
    toolCalls,
  };
}

function walk(
  content: unknown,
  parts: string[],
  files: string[],
  countTool: () => void,
): void {
  if (typeof content === "string") {
    parts.push(content);
    return;
  }
  if (Array.isArray(content)) {
    for (const block of content) walk(block, parts, files, countTool);
    return;
  }
  if (content === null || typeof content !== "object") return;
  const record = content as Record<string, unknown>;
  const kind = typeof record.type === "string" ? record.type : "text";
  switch (kind) {
    case "text":
    case "output_text":
    case "input_text": {
      if (typeof record.text === "string") parts.push(record.text);
      return;
    }
    case "tool_use":
    case "function_call": {
      countTool();
      const path = filePath(record.input ?? record.arguments);
      if (path !== undefined) files.push(path);
      return;
    }
    // 工具结果是摘要里最没用、最长的一段：只数进 `toolCalls` 的那一头，正文
    // 一个字都不带。
    default:
      return;
  }
}

/** `tool_use` 参数里的 `file_path` / `path`，只认字符串。 */
function filePath(input: unknown): string | undefined {
  let value: unknown = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["file_path", "path"]) {
    const found = record[key];
    if (typeof found === "string" && found.trim() !== "") return found.trim();
  }
  return undefined;
}

function collapse(text: string): string {
  return text.trim().split(/\s+/).filter(Boolean).join(" ");
}

function quote(text: string): string {
  const characters = [...text];
  if (characters.length <= MAX_QUOTE_CHARS) return text;
  return `${characters.slice(0, MAX_QUOTE_CHARS).join("")}…`;
}

/** 按字节截断，不切碎一个码点。 */
function cut(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const characters = [...text];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      Buffer.byteLength(characters.slice(0, middle).join(""), "utf8") <=
      maxBytes - 24
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${characters.slice(0, low).join("")}\n…（摘要已截断）\n`;
}
