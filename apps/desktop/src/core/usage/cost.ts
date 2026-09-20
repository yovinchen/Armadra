/**
 * 本地成本统计。移植自 `apps/runtime/src/usage/cost/`。
 *
 * Claude 和 Codex 都在磁盘上留下带每次请求 token 数的 JSONL 记录。这个模块把它们
 * 变成今天 / 近 30 天 / 当前会话的总数，加上按天、按模型的拆分，**全部在这台机器上**。
 *
 * 用量模块的三条规矩在这里也成立，外加一条：
 *
 *   * **没有一行记录文本离开扫描器。** 提示词、回复、会话 id 和项目路径被读过就
 *     丢掉。到达 API 的是计数、模型 id 和日期。
 *   * 没有价格的模型**只显示 token**。不会从一个名字相近的模型估价——见
 *     {@link priceFor}。一个错的美元数字比没有更糟。
 *   * 扫描被节流：后台一趟 5 分钟，用户发起的刷新 30 秒。
 *
 * ## 增量
 *
 * 每个文件之间记着自己的长度、mtime 和字节偏移，只解析追加的那部分。一个变**短**
 * 的文件意味着记录被轮转或者重写过，于是整个缓存被丢掉重建——单独重解析那一个文件
 * 会被请求 id 的去重悄悄吃掉。
 */

import { readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { join } from "node:path";

import { homeDir } from "./providers";

/** 看板的滚动窗口，含当天。 */
export const WINDOW_DAYS = 30;
/** 两次后台扫描之间的最短间隔。 */
export const MIN_SCAN_INTERVAL_MS = 5 * 60_000;
/** 用户发起的刷新可以快四倍。 */
export const MANUAL_COOLDOWN_MS = 30_000;
/**
 * 一次扫描肯打开多少个记录文件的上限。重度用户有几千个；在一个五分钟的定时器上
 * 走完所有的不值得，而看板的 30 天窗口要的是最新的那些。
 */
export const MAX_FILES = 4_000;

/**
 * How many transcript lines are parsed before the scanner yields to the event
 * loop. A machine that has used the CLIs for a while holds a gigabyte of
 * transcripts, and one file alone can pass eighty megabytes; parsing that in
 * one synchronous stretch held the core's loop for fifteen seconds — long
 * enough for the shell's SIGTERM to time out and for every request from the
 * page to look like a dead service. Yielding this often keeps a single stall
 * in the low milliseconds.
 */
export const LINES_PER_YIELD = 500;
/** 目录遍历深度。Claude 嵌一层，Codex 三层；六层留了余量又不会走进无关的树。 */
const MAX_DEPTH = 6;

/** Token 计数。`input` 在两家都**不含**缓存读，所以四个桶永远不重复计。 */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

export function addTokens(target: TokenTotals, other: TokenTotals): void {
  target.input += other.input;
  target.output += other.output;
  target.cacheRead += other.cacheRead;
  target.cacheCreation += other.cacheCreation;
}

export function totalTokens(tokens: TokenTotals): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
}

export function isEmptyTokens(tokens: TokenTotals): boolean {
  return totalTokens(tokens) === 0;
}

export interface ModelCost {
  readonly model: string;
  readonly tokens: TokenTotals;
  /** 模型没有价格时是 `null`。UI 于是只显示 token。 */
  readonly costUsd: number | null;
}

export interface CostWindow {
  readonly tokens: TokenTotals;
  /** 只对**有**价格的模型求和。永远不是没价格那些的替身——`complete` 说有没有缺。 */
  readonly costUsd: number;
  readonly complete: boolean;
  readonly models: readonly ModelCost[];
}

export interface DailyCost extends CostWindow {
  /** 本地 `YYYY-MM-DD`。 */
  readonly date: string;
}

export interface SessionCost {
  readonly provider: string;
  readonly models: readonly string[];
  readonly tokens: TokenTotals;
  readonly costUsd: number;
  readonly complete: boolean;
  readonly updatedAt: string;
}

export type CostStatus = "ok" | "disabled" | "unavailable";

export interface CostSummary {
  readonly status: CostStatus;
  readonly today: CostWindow;
  readonly last30Days: CostWindow;
  readonly currentSession?: SessionCost;
  /** 最旧的在前，含今天共 {@link WINDOW_DAYS} 条。没有活动的那天也在，带零。 */
  readonly daily: readonly DailyCost[];
  /** 窗口里见过但没有价格的模型。报出来好让看板解释一个看起来偏低的总数。 */
  readonly unpricedModels: readonly string[];
  /** 每家供应商贡献了几个记录文件。 */
  readonly files: Readonly<Record<string, number>>;
  /** 文件数上限被顶到、更旧的记录被跳过了。 */
  readonly truncated: boolean;
  readonly scannedAt: string | null;
  readonly refreshAvailableAt: string | null;
}

function emptyWindow(): CostWindow {
  return { tokens: emptyTokens(), costUsd: 0, complete: true, models: [] };
}

export function emptySummary(status: CostStatus): CostSummary {
  return {
    status,
    today: emptyWindow(),
    last30Days: emptyWindow(),
    daily: [],
    unpricedModels: [],
    files: {},
    truncated: false,
    scannedAt: null,
    refreshAvailableAt: null,
  };
}

/* --------------------------------- 价格表 --------------------------------- */

export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** 缓存读是输入的十分之一，5 分钟缓存写是 1.25×，所以每行只写两个头条数字。 */
function standard(input: number, output: number): ModelPrice {
  return {
    input,
    output,
    cacheRead: input / 10,
    cacheWrite: input * 1.25,
  };
}

function withCacheRead(
  input: number,
  output: number,
  cacheRead: number,
): ModelPrice {
  return { input, output, cacheRead, cacheWrite: input * 1.25 };
}

/**
 * 一行 OpenAI。那边的提示缓存**不按写计费**——一个被缓存的前缀在被读时打折、创建它
 * 不花钱——所以 `cacheWrite` 是零而不是 Anthropic 的 1.25×。把 Anthropic 的惯例搬
 * 过去会凭空发明一笔费用。
 */
function openai(input: number, output: number, cacheRead: number): ModelPrice {
  return { input, output, cacheRead, cacheWrite: 0 };
}

/**
 * 每百万 token 多少美元。和 `apps/runtime/src/usage/cost/pricing.rs` 的内建表逐行
 * 一致——同一台机器在两种 core 下必须算出同一个数字。
 */
export const BUILT_IN_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": withCacheRead(10, 50, 0.25),
  "claude-mythos-5-1": withCacheRead(10, 50, 0.25),
  "claude-fable-5": withCacheRead(10, 50, 1),
  "claude-mythos-5": withCacheRead(10, 50, 1),
  "claude-opus-5": standard(5, 25),
  "claude-opus-4-8": standard(5, 25),
  "claude-opus-4-7": standard(5, 25),
  "claude-opus-4-6": standard(5, 25),
  "claude-sonnet-5": standard(2, 10),
  "claude-sonnet-4-6": standard(3, 15),
  "claude-haiku-4-5": standard(1, 5),
  "gpt-5-codex": openai(1.25, 10, 0.125),
  "gpt-5": openai(1.25, 10, 0.125),
  "gpt-5-mini": openai(0.25, 2, 0.025),
  "gpt-5-nano": openai(0.05, 0.4, 0.005),
  "codex-mini-latest": openai(1.5, 6, 0.375),
  o3: openai(2, 8, 0.5),
  "o4-mini": openai(1.1, 4.4, 0.275),
};

/**
 * `claude-opus-4-5-20251101` → `claude-opus-4-5`。带日期的快照落回它不带日期的 id，
 * 那是目录给它们起的名字。
 */
export function undated(model: string): string | undefined {
  const index = model.lastIndexOf("-");
  if (index <= 0) return undefined;
  const head = model.slice(0, index);
  const tail = model.slice(index + 1);
  if (/^\d{8}$/.test(tail)) return head;
  // `-YYYY-MM-DD`：三段，从后往前检查，这样一次部分匹配（`gpt-5-mini`、`o4-mini`）
  // 会落空而不是被截断。
  if (!/^\d{2}$/.test(tail)) return undefined;
  const second = head.lastIndexOf("-");
  if (second <= 0 || !/^\d{2}$/.test(head.slice(second + 1))) return undefined;
  const third = head.slice(0, second).lastIndexOf("-");
  if (third <= 0) return undefined;
  const year = head.slice(0, second).slice(third + 1);
  return /^\d{4}$/.test(year)
    ? head.slice(0, second).slice(0, third)
    : undefined;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

/**
 * 查价时按顺序问的那几张表。
 *
 * 三级回退：**内置 → 目录 → 未定价**。内置表在前，因为它是和 Rust Runtime 逐行
 * 对过的那一份，同一台机器在两种实现下必须算出同一个数字；models.dev 的目录在
 * 后，它覆盖的是内置表里没有的那些模型（新发布的、别家的）。一个模型两张表都
 * 没有就是**没有价格**，看板只显示它的 token——从一个名字相近的模型估价，比不
 * 报价更糟。
 */
export type PriceLookup = PriceTable | readonly PriceTable[];

function tablesOf(lookup: PriceLookup): readonly PriceTable[] {
  return Array.isArray(lookup)
    ? (lookup as readonly PriceTable[])
    : [lookup as PriceTable];
}

/**
 * 一个记录里写的模型 id 的价格。不在表里的模型**完全没有成本**——看板只显示它的
 * token。**永远不从一个名字相近的模型估**。
 *
 * 每张表都先按原名查、再按去掉日期的名字查，然后才轮到下一张：一个带日期的快照
 * 命中内置表的不带日期条目，仍然算内置表答的，目录不该把它顶掉。
 */
export function priceFor(
  lookup: PriceLookup,
  model: string,
): ModelPrice | undefined {
  const fallback = undated(model);
  for (const table of tablesOf(lookup)) {
    const direct = table[model];
    if (direct !== undefined) return direct;
    if (fallback !== undefined && table[fallback] !== undefined) {
      return table[fallback];
    }
  }
  return undefined;
}

/** 一桶 token 值多少美元。 */
export function costOf(price: ModelPrice, tokens: TokenTotals): number {
  const million = 1_000_000;
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheCreation * price.cacheWrite) /
    million
  );
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/* --------------------------------- 扫描 ---------------------------------- */

export type Provider = "claude" | "codex";

export interface ScanResult {
  /** `${date} ${model}` → token 数。 */
  readonly buckets: Map<string, TokenTotals>;
  readonly files: Record<string, number>;
  truncated: boolean;
  current:
    | {
        provider: Provider;
        tokens: TokenTotals;
        models: string[];
        updatedMs: number;
      }
    | undefined;
}

/**
 * 桶的键是 `日期 + NUL + 模型`。分隔符用 NUL 而不是空格或冒号：模型 id 里可以有
 * 那些字符，用它们分隔会让两组不同的 (日期, 模型) 拼出同一个键。
 */
const KEY_SEPARATOR = "\u0000";

export function bucketKey(date: string, model: string): string {
  return `${date}${KEY_SEPARATOR}${model}`;
}

export function splitKey(key: string): { date: string; model: string } {
  const index = key.indexOf(KEY_SEPARATOR);
  return {
    date: key.slice(0, index),
    model: key.slice(index + KEY_SEPARATOR.length),
  };
}

interface FileState {
  provider: Provider;
  len: number;
  mtimeMs: number;
  offset: number;
  modifiedMs: number;
  model: string | undefined;
  buckets: Map<string, TokenTotals>;
}

/**
 * `${CLAUDE_CONFIG_DIR:-~/.claude}/projects` 与
 * `${CODEX_HOME:-~/.codex}/sessions`。两个都尊重 CLI 自己的覆盖。
 */
export function scanRoots(): [Provider, string][] {
  const home = homeDir();
  const roots: [Provider, string][] = [];
  const claude =
    (process.env.CLAUDE_CONFIG_DIR ?? "") !== ""
      ? (process.env.CLAUDE_CONFIG_DIR as string)
      : home === undefined
        ? undefined
        : join(home, ".claude");
  const codex =
    (process.env.CODEX_HOME ?? "") !== ""
      ? (process.env.CODEX_HOME as string)
      : home === undefined
        ? undefined
        : join(home, ".codex");
  if (claude !== undefined) roots.push(["claude", join(claude, "projects")]);
  if (codex !== undefined) roots.push(["codex", join(codex, "sessions")]);
  return roots;
}

/** 深度优先的 `*.jsonl` 遍历。不跟随符号链接的目录。 */
export function collectTranscripts(
  root: string,
  depth = 0,
  out: string[] = [],
): string[] {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      collectTranscripts(path, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(path);
    }
  }
  return out;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 一个 RFC 3339 时间戳 → 它落在的本地 `YYYY-MM-DD`。一行读不出时间戳就算今天：
 * 它是一个正在跑的会话写的。
 */
export function localDate(timestamp: unknown, nowMs: number): string {
  const parsed =
    typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  const date = new Date(Number.isFinite(parsed) ? parsed : nowMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 增量扫描的状态。一次恢复或者分叉的会话会逐字重复行，所以一个 request id 在**整个
 * 扫描**里只被计一次。
 */
/**
 * 一次从磁盘搬进内存多少字节。
 *
 * 曾经这里读的是**整段追加**：一次 `Buffer.allocUnsafe(size - offset)`，再
 * `toString("utf8")`，再 `split("\n")`。一个八十兆的记录因此同时活着三份——缓冲
 * 区、整段字符串、每一行的数组——而第一趟扫描要对一千多个文件各走一遍。量出来
 * 的后果是 RSS 峰值 2.8 GB，而 `heapUsed` 全程不到 15 MB：大头是走了一趟就再也
 * 没还给系统的页，不是任何一个还被引用着的对象。
 *
 * 按块读之后，一个文件在任一时刻只欠这一个缓冲区加上它当前那一行。块大小取
 * 256 KiB：比绝大多数记录行大一个数量级，又小到峰值可以忽略。
 */
export const CHUNK_BYTES = 256 * 1024;

/**
 * 那**一个**读缓冲区。
 *
 * 每个文件自己 `allocUnsafe(CHUNK_BYTES)` 的代价是一千四百个文件 × 256 KiB =
 * 350 MB 的外部分配。没有一份被留下来，但进程也拿不回那些页——量出来成本扫描之
 * 后 RSS 从 92 MB 涨到 507 MB，而 `heapUsed` 只有 15 MB。
 *
 * 一趟扫描里文件是一个接一个走的（{@link CostService.scan} 自己保证同时只有一
 * 趟），所以一个缓冲区够用。租不到的调用者（测试里两个 `ScanState` 并发）自带一
 * 个，正确性不依赖这把锁。
 */
let chunk: Buffer | undefined;

function leaseChunk(): Buffer {
  const leased = chunk ?? Buffer.allocUnsafe(CHUNK_BYTES);
  chunk = undefined;
  return leased;
}

function returnChunk(leased: Buffer): void {
  if (chunk === undefined) chunk = leased;
}

/**
 * 一行**有可能**贡献点什么吗。在字节上判，判错的方向只能是「放过一行其实没用的」。
 *
 * * claude：{@link ScanState.absorbClaude} 第一件事就是要 `message.usage` 是个对
 *   象；没有 `usage` 这个键的行一个 token 都出不来。
 * * codex：要么是 `token_count` 的 payload，要么是某一处 `model` 声明——后者会被
 *   记进 `state.model` 给后面的事件用，所以不能只看 `token_count`。
 *
 * 判据是 JSON 里那个键**字面的**样子。理论上 `"usage"` 是同一个键而这里会漏
 * 掉它；两家 CLI 的序列化器都不会那么写，而代价（漏算）比反过来（把整份记录全解
 * 析一遍）小得多。
 */
const EMPTY_VIEW = Buffer.alloc(0);

const CLAUDE_NEEDLES = [Buffer.from('"usage"')] as const;
const CODEX_NEEDLES = [
  Buffer.from('"model"'),
  Buffer.from('"token_count"'),
] as const;

/**
 * 一条行（`view` 的 `[from, to)` 那一段）里有没有任何一个 needle。
 *
 * 每个 needle 记着自己在这一块里的下一个位置，位置落到行首后面才重新找一次——
 * 于是一块里的搜索次数是「命中数 + 1」而不是「行数」，而且**一次分配都没有**。
 * 为一行做一个 `subarray` 再 `includes` 也能算出同一个答案，代价是每行一个对象。
 */
class NeedleCursor {
  private readonly at: number[];

  private view: Buffer = EMPTY_VIEW;

  constructor(private readonly needles: readonly Buffer[]) {
    this.at = needles.map(() => -1);
  }

  /** 换了一块（或者同一块被挪过），重新定位。 */
  reset(view: Buffer, from: number): void {
    this.view = view;
    for (let i = 0; i < this.needles.length; i += 1) {
      this.at[i] = view.indexOf(this.needles[i] as unknown as Uint8Array, from);
    }
  }

  hits(from: number, to: number): boolean {
    for (let i = 0; i < this.needles.length; i += 1) {
      let at = this.at[i] as number;
      if (at !== -1 && at < from) {
        at = this.view.indexOf(this.needles[i] as unknown as Uint8Array, from);
        this.at[i] = at;
      }
      if (at !== -1 && at < to) return true;
    }
    return false;
  }
}

/**
 * `path` 的 `[offset, size)` 按行喂给 `onLine`，返回**完整行**一共占了多少字节。
 *
 * 结尾那条不完整的行不喂也不计数：CLI 可能正写到一半，而半个 JSON 对象解析出来
 * 什么都不是，它留给下一趟。
 *
 * **跨块的那半行留在同一个缓冲区里**，靠 `copyWithin` 挪到开头，下一次读接在它后
 * 面。曾经这里是 `Buffer.from(tail)` / `Buffer.concat([carry, tail])`——每块一次，
 * 五千兆的记录就是两万次几 KB 的分配。量出来那两行值 340 MB：同一趟扫描，把它们
 * 去掉之后 RSS 从 416 MB 回到 77 MB，而循环里其余部分一个字节都没变。
 *
 * 一条比缓冲区还长的行会把缓冲区翻倍（私有的那一份不还进池子）。此后的峰值就是
 * 那一行本身，仍然远小于从前的「整段追加」。
 *
 * 读到一半出错不抛：已经喂出去的行是真的被吃过了，它们的字节必须被计进返回值，
 * 否则下一趟会把同一段再吃一遍（codex 的行没有 request id，去重接不住）。
 *
 * `needles` 在**解码之前**看字节。一份记录里绝大多数行是提示词和工具结果，一个
 * 字节都进不了任何一个桶；让它们连字符串都不变成，省掉的是那一份 JSON.parse。
 */
async function eachAppendedLine(
  path: string,
  offset: number,
  size: number,
  needles: readonly Buffer[],
  onLine: (line: string) => Promise<void> | void,
): Promise<number> {
  if (size <= offset) return 0;
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return 0;
  }
  const leased = leaseChunk();
  let buffer = leased;
  let consumed = 0;
  const cursor = new NeedleCursor(needles);
  try {
    let position = offset;
    // 缓冲区开头那几个字节是上一块结尾那条没读完的行。
    let pending = 0;
    while (position < size) {
      if (pending === buffer.length) {
        // 一条比缓冲区还长的行：翻倍，把已经读到的那一段带过去。
        const grown = Buffer.allocUnsafe(buffer.length * 2);
        buffer.copy(grown, 0, 0, pending);
        buffer = grown;
      }
      const { bytesRead } = await handle.read(
        buffer,
        pending,
        Math.min(buffer.length - pending, size - position),
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      const end = pending + bytesRead;
      const view = buffer.subarray(0, end);
      cursor.reset(view, 0);
      let start = 0;
      for (;;) {
        const newline = view.indexOf(10, start);
        if (newline === -1) break;
        const from = start;
        consumed += newline - start + 1;
        start = newline + 1;
        if (cursor.hits(from, newline)) {
          await onLine(view.toString("utf8", from, newline));
        }
      }
      pending = end - start;
      if (pending > 0 && start > 0) buffer.copyWithin(0, start, end);
      // 每读完一块让一次路。`LINES_PER_YIELD` 数的是**解析过**的行，而一块里可能
      // 一行都没有人要；没有这一下，一个几百兆的文件会把循环占住。
      await yieldToLoop();
    }
  } catch {
    // 读或解析出错就停在这里；已经消费的字节仍然算数。
  } finally {
    returnChunk(leased);
    await handle.close().catch(() => undefined);
  }
  return consumed;
}

/**
 * 一个 request id 的 53 位摘要。
 *
 * 去重集合存的是这个数字而不是那个字符串。重度用户一趟扫描见到七万多个 id，每个
 * 三十多个字符——留着原文是二十多兆，留摘要是两三兆，而集合被问的问题只有「见过
 * 没有」。
 *
 * 代价是碰撞：两个不同的 id 撞到同一个数字时，后来那一行被当成重复丢掉。七万个
 * 值落在 2^53 上，生日问题给出的概率约 4×10⁻⁷——比「记录文件在扫描中途被轮转」
 * 之类的事件低好几个数量级，而它换来的是二十兆常驻内存。
 *
 * FNV-1a 的 32 位变体跑两遍（正序与反序、不同的种子），拼成 53 位里的高低两半。
 */
export function digest(value: string): number {
  let forward = 0x811c9dc5;
  let backward = 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    forward = Math.imul(forward ^ value.charCodeAt(i), 0x01000193);
    backward = Math.imul(
      backward ^ value.charCodeAt(value.length - 1 - i),
      0x85ebca6b,
    );
  }
  // 两个 32 位拼成 53 位以内的一个安全整数：高 21 位 + 低 32 位。
  return (forward >>> 11) * 0x100000000 + (backward >>> 0);
}

export class ScanState {
  private readonly files = new Map<string, FileState>();
  private readonly seen = new Set<number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** 对两棵记录树跑一趟。异步，因为文件解析要给事件循环让路。 */
  async scan(
    roots: readonly (readonly [Provider, string])[] = scanRoots(),
  ): Promise<ScanResult> {
    const result: ScanResult = {
      buckets: new Map(),
      files: {},
      truncated: false,
      current: undefined,
    };
    const discovered: [Provider, string][] = [];
    for (const [provider, root] of roots) {
      const paths = collectTranscripts(root);
      result.truncated ||= paths.length >= MAX_FILES;
      result.files[provider] = (result.files[provider] ?? 0) + paths.length;
      for (const path of paths) discovered.push([provider, path]);
    }

    // 一个变短的文件意味着记录被重写过。单独重解析它加不了任何东西（它的 request
    // id 已经在 `seen` 里），所以缓存被丢掉、整棵树重新解析。
    const shortened = discovered.some(([, path]) => {
      const state = this.files.get(path);
      if (state === undefined) return false;
      try {
        return statSync(path).size < state.offset;
      } catch {
        return false;
      }
    });
    if (shortened) {
      this.files.clear();
      this.seen.clear();
    }

    const live = new Set<string>();
    for (const [provider, path] of discovered) {
      live.add(path);
      await this.parse(provider, path);
    }
    // 消失了的文件把它的贡献一起带走。
    for (const path of [...this.files.keys()]) {
      if (!live.has(path)) this.files.delete(path);
    }

    let current: FileState | undefined;
    for (const state of this.files.values()) {
      for (const [key, tokens] of state.buckets) {
        const bucket = result.buckets.get(key) ?? emptyTokens();
        addTokens(bucket, tokens);
        result.buckets.set(key, bucket);
      }
      if (state.buckets.size === 0) continue;
      if (current === undefined || state.modifiedMs > current.modifiedMs) {
        current = state;
      }
    }
    if (current !== undefined) {
      const tokens = emptyTokens();
      const models = new Set<string>();
      for (const [key, value] of current.buckets) {
        addTokens(tokens, value);
        models.add(splitKey(key).model);
      }
      result.current = {
        provider: current.provider,
        tokens,
        models: [...models].sort(),
        updatedMs: current.modifiedMs,
      };
    }
    return result;
  }

  private async parse(provider: Provider, path: string): Promise<void> {
    let info;
    try {
      info = statSync(path);
    } catch {
      return;
    }
    const mtimeMs = Math.round(info.mtimeMs);
    const state: FileState = this.files.get(path) ?? {
      provider,
      len: 0,
      mtimeMs: 0,
      offset: 0,
      modifiedMs: 0,
      model: undefined,
      buckets: new Map(),
    };
    this.files.delete(path);
    // 同样的长度和同样的 mtime 意味着什么都没被追加。
    if (
      state.len === info.size &&
      state.mtimeMs === mtimeMs &&
      state.offset > 0
    ) {
      state.modifiedMs = mtimeMs;
      this.files.set(path, state);
      return;
    }
    state.len = info.size;
    state.mtimeMs = mtimeMs;
    state.modifiedMs = mtimeMs;

    // 只读追加的那一段：从记住的偏移量起。读整个文件再切片会让一个八十兆的记录
    // 每五分钟被完整读一次；按块读还让任一时刻常驻的只有一个 256 KiB 的缓冲区。
    let parsed = 0;
    const consumed = await eachAppendedLine(
      path,
      state.offset,
      info.size,
      provider === "claude" ? CLAUDE_NEEDLES : CODEX_NEEDLES,
      async (line) => {
        const trimmed = line.trim();
        if (trimmed === "") return;
        if (++parsed % LINES_PER_YIELD === 0) await yieldToLoop();
        let value: unknown;
        try {
          value = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (provider === "claude") this.absorbClaude(state, value);
        else this.absorbCodex(state, value);
      },
    );
    // 结尾那条不完整的行留给下一趟。
    state.offset += consumed;
    this.files.set(path, state);
  }

  private absorbClaude(state: FileState, value: unknown): void {
    const line = asRecord(value);
    const message = asRecord(line?.message);
    const usage = asRecord(message?.usage);
    if (usage === undefined) return;
    // `requestId` 是 CLI 自己的字段；`message.id` 是更老记录的兜底。两个都没有的
    // 行被计入——丢掉它比重复计更常见地少报。
    const identity =
      typeof line?.requestId === "string"
        ? line.requestId
        : typeof message?.id === "string"
          ? message.id
          : undefined;
    if (identity !== undefined) {
      const key = digest(identity);
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    const tokens: TokenTotals = {
      input: number(usage.input_tokens),
      output: number(usage.output_tokens),
      cacheRead: number(usage.cache_read_input_tokens),
      cacheCreation: number(usage.cache_creation_input_tokens),
    };
    if (isEmptyTokens(tokens)) return;
    const model =
      typeof message?.model === "string" && message.model !== ""
        ? message.model
        : "unknown";
    const key = bucketKey(localDate(line?.timestamp, this.now()), model);
    const bucket = state.buckets.get(key) ?? emptyTokens();
    addTokens(bucket, tokens);
    state.buckets.set(key, bucket);
  }

  private absorbCodex(state: FileState, value: unknown): void {
    const line = asRecord(value);
    if (line === undefined) return;
    // 模型由会话元数据和每一轮的上下文宣布；先到的那个被记住，给后面的事件用。
    for (const path of [
      ["payload", "model"],
      ["payload", "info", "model"],
      ["payload", "turn_context", "model"],
      ["model"],
    ]) {
      let node: unknown = line;
      for (const key of path) node = asRecord(node)?.[key];
      if (typeof node === "string" && node !== "") {
        state.model = node;
        break;
      }
    }
    const payload = asRecord(line.payload);
    if (payload?.type !== "token_count") return;
    // `last_token_usage` 是这一轮的增量；`total_token_usage` 是累计的，用它会把这个
    // 会话的成本乘上它的轮数。
    const info = asRecord(payload.info) ?? payload;
    const last =
      asRecord(info.last_token_usage) ?? asRecord(info.lastTokenUsage);
    if (last === undefined) return;
    const cached =
      number(last.cached_input_tokens) + number(last.cachedInputTokens);
    const rawInput = number(last.input_tokens) + number(last.inputTokens);
    const tokens: TokenTotals = {
      // Codex 把缓存的 token 报在 input **里面**，和 Claude 那边分成两个桶不一样。
      // 减掉它让 input 仍然表示「按输入价计费的那部分」。
      input: Math.max(rawInput - cached, 0),
      output: number(last.output_tokens) + number(last.outputTokens),
      cacheRead: cached,
      cacheCreation: 0,
    };
    if (isEmptyTokens(tokens)) return;
    const key = bucketKey(
      localDate(line.timestamp, this.now()),
      state.model ?? "unknown",
    );
    const bucket = state.buckets.get(key) ?? emptyTokens();
    addTokens(bucket, tokens);
    state.buckets.set(key, bucket);
  }
}

/* --------------------------------- 汇总 ---------------------------------- */

function windowFrom(
  entries: readonly (readonly [string, TokenTotals])[],
  prices: PriceLookup,
): CostWindow {
  const merged = new Map<string, TokenTotals>();
  for (const [model, tokens] of entries) {
    const bucket = merged.get(model) ?? emptyTokens();
    addTokens(bucket, tokens);
    merged.set(model, bucket);
  }
  const total = emptyTokens();
  let cost = 0;
  let complete = true;
  const models: ModelCost[] = [];
  for (const [model, tokens] of [...merged].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    addTokens(total, tokens);
    const price = priceFor(prices, model);
    const priced =
      price === undefined ? null : roundCents(costOf(price, tokens));
    if (priced !== null) cost += priced;
    else if (!isEmptyTokens(tokens)) complete = false;
    models.push({ model, tokens, costUsd: priced });
  }
  // 花得最多的在前，然后是 token 最多的：看板的模型拆分自上而下读。
  models.sort(
    (left, right) =>
      (right.costUsd ?? 0) - (left.costUsd ?? 0) ||
      totalTokens(right.tokens) - totalTokens(left.tokens) ||
      left.model.localeCompare(right.model),
  );
  return { tokens: total, costUsd: roundCents(cost), complete, models };
}

/** 把一次原始扫描变成线上形状：切窗口、定价、补齐 30 天的轴。 */
export function summarize(
  result: ScanResult,
  prices: PriceLookup,
  nowMs: number,
): CostSummary {
  const now = new Date(nowMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const dateOf = (value: Date): string =>
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  const today = dateOf(now);
  const dates: string[] = [];
  for (let back = WINDOW_DAYS - 1; back >= 0; back -= 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - back);
    dates.push(dateOf(date));
  }
  const oldest = dates[0] ?? today;

  const unpriced = new Set<string>();
  const perDay = new Map<string, [string, TokenTotals][]>();
  const windowModels: [string, TokenTotals][] = [];
  const todayModels: [string, TokenTotals][] = [];
  for (const [key, tokens] of result.buckets) {
    const { date, model } = splitKey(key);
    if (date < oldest) continue;
    const day = perDay.get(date) ?? [];
    day.push([model, tokens]);
    perDay.set(date, day);
    windowModels.push([model, tokens]);
    if (date === today) todayModels.push([model, tokens]);
    if (priceFor(prices, model) === undefined) unpriced.add(model);
  }

  const daily: DailyCost[] = dates.map((date) => ({
    date,
    ...windowFrom(perDay.get(date) ?? [], prices),
  }));

  let currentSession: SessionCost | undefined;
  if (result.current !== undefined) {
    const session = result.current;
    // 扫描状态里会话的 token 没有按模型拆开，所以只在恰好一个模型时按那个模型
    // 计价，在会话换过模型时留成没有价格。
    const price =
      session.models.length === 1
        ? priceFor(prices, session.models[0] as string)
        : undefined;
    currentSession = {
      provider: session.provider,
      models: session.models,
      tokens: session.tokens,
      costUsd:
        price === undefined ? 0 : roundCents(costOf(price, session.tokens)),
      complete: price !== undefined,
      updatedAt: new Date(session.updatedMs).toISOString(),
    };
  }

  return {
    status: result.buckets.size === 0 ? "unavailable" : "ok",
    today: windowFrom(todayModels, prices),
    last30Days: windowFrom(windowModels, prices),
    ...(currentSession === undefined ? {} : { currentSession }),
    daily,
    unpricedModels: [...unpriced].sort(),
    files: result.files,
    truncated: result.truncated,
    scannedAt: new Date(nowMs).toISOString(),
    refreshAvailableAt: null,
  };
}

/** 缓存好的汇总加上增量扫描状态。 */
export class CostService {
  private summaryValue: CostSummary = emptySummary("unavailable");
  private readonly state: ScanState;
  private lastScanMs: number | undefined;

  /**
   * `prices` 可以是一个**函数**，因为目录是会变的：models.dev 抓回来之后，下一
   * 次扫描就该用上新价格，而不是等到重启。
   */
  constructor(
    private readonly enabled: () => boolean,
    private readonly now: () => number = () => Date.now(),
    private readonly prices:
      | PriceLookup
      | (() => PriceLookup) = BUILT_IN_PRICES,
  ) {
    this.state = new ScanState(now);
  }

  /** 缓存着的汇总。从不碰文件系统。 */
  summary(): CostSummary {
    return this.enabled() ? this.summaryValue : emptySummary("disabled");
  }

  /** 后台那一趟：最多五分钟一次扫描。 */
  refreshThrottled(): Promise<CostSummary> {
    return this.cooling(MIN_SCAN_INTERVAL_MS)
      ? Promise.resolve(this.summary())
      : this.scan();
  }

  /** `POST /api/usage/cost/refresh`：一次用户手势，30 秒冷却。 */
  refreshManual(): Promise<CostSummary> {
    return this.cooling(MANUAL_COOLDOWN_MS)
      ? Promise.resolve(this.summary())
      : this.scan();
  }

  private cooling(window: number): boolean {
    return (
      this.lastScanMs !== undefined && this.now() - this.lastScanMs < window
    );
  }

  private inFlight: Promise<CostSummary> | undefined;

  /**
   * One scan at a time: the state's offsets are shared, and two scans reading
   * the same appended bytes would count them twice. A caller that arrives
   * while one runs gets that one's result.
   */
  private scan(): Promise<CostSummary> {
    if (!this.enabled()) {
      // 把扫描关掉不该为一件没做的事开始冷却，也不该覆盖缓存：重新打开该是即时的。
      return Promise.resolve(emptySummary("disabled"));
    }
    if (this.inFlight !== undefined) return this.inFlight;
    const nowMs = this.now();
    this.inFlight = this.state
      .scan()
      .then((result) => {
        this.lastScanMs = nowMs;
        this.summaryValue = {
          // 价格在这里才读：刚抓回来的目录这一趟就算得上，不必等重启。
          ...summarize(
            result,
            typeof this.prices === "function" ? this.prices() : this.prices,
            nowMs,
          ),
          refreshAvailableAt: new Date(
            nowMs + MANUAL_COOLDOWN_MS,
          ).toISOString(),
        };
        return this.summaryValue;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }
}
