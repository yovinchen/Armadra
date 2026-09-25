/**
 * 主机与每个会话的采样。移植自 合并前的实现。
 *
 * ## 选型：`ps`，不是 `pidusage`
 *
 * Rust 那边用 `sysinfo`。这里用的是 **`ps` 一次全表读**（`ps -Ao
 * pid=,ppid=,rss=,time=,lstart=,state=,comm=`），理由有三条：
 *
 *   1. `terminal/process.ts` 已经在用同一条命令读进程树，两处用同一个来源比一个
 *      新的原生依赖更不容易在两边给出不同的父子关系；
 *   2. `pidusage` 在 macOS 上自己也 fork `ps`，多的是一层依赖而不是多的是信息；
 *   3. 走一个真的 `ps` 意味着**没有原生模块**——core 要能被 `node out/core/main.js`
 *      直接跑起来，一个需要 rebuild 的原生扩展会把那条路弄脏。
 *
 * 代价写清楚：Windows 上 `ps` 不存在，所以那里每一项都是 `null`（见下面第二条
 * 规矩），而不是被编出来的零。
 *
 * ## 三条规矩，面板全靠它们
 *
 * 1. **测不到的指标是 `null`，永远不是 `0`**。前端把 `null` 画成破折号；一个零会
 *    被读成「空闲」，那是另一句话，而且是错的。
 * 2. **CPU 需要两个样本**。`ps` 给的是进程**累计**的 CPU 时间，所以第一次采样没有
 *    可减的东西，CPU 报 `null`（Rust 侧同样的理由：`sysinfo` 的 CPU 是两次刷新之
 *    间的差）。
 * 3. **身份是 `(pid, startTime)` 这一对**。操作系统会重用 pid，只看 pid 会让一个
 *    已经死掉的进程和一个继承了它号码的无关进程合并。
 *
 * ## `rss` 的语义
 *
 * `ps -o rss` 给的是**常驻集大小**（KiB），和 `sysinfo` 的 `Process::memory()`
 * 在 Linux（`/proc/<pid>/statm` 的 resident 页）与 macOS 上报的是同一件事。这里
 * 刻意**不**用 Linux 的 `RssAnon`：Rust 侧没有用它，换一个更窄的口径会让同一台机
 * 器在两种 core 下给出不同的数字，而这一轮要的是逐平台对照得上。
 */

import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import {
  loadavg,
  platform as osPlatform,
  totalmem,
  freemem,
  uptime,
} from "node:os";

/** CPU 基线超过这么久就不再是可用基线：进程表已经变了，差会摊在一个未知窗口上。 */
export const MAX_CPU_BASELINE_AGE_MS = 60_000;

/** 每个会话最多列这么多子进程。面板的可展开树是为了找出吃内存的那个。 */
export const MAX_LISTED_CHILDREN = 32;

/** `root` 加上它的所有后代，宽度优先，硬上限防一个 fork 炸弹把样本撑破。 */
const MAX_TREE = 4096;

/** 一次测量来自哪里。远端的会话不带数字——控制机的内存不是 SSH 主机的。 */
export type Location = "local" | "remote";

export interface MemoryUsage {
  readonly totalBytes: number | null;
  readonly usedBytes: number | null;
  readonly availableBytes: number | null;
  readonly swapTotalBytes: number | null;
  readonly swapUsedBytes: number | null;
  /**
   * 操作系统自己的内存压力判断，只在它真的发布一个的地方报。`null` 表示这个平台
   * 没被问或者不肯答——**从来不是「正常」**。
   *
   * 它刻意不从上面几个字段推导：一台大部分内存在可回收缓存里的机器读起来是 95%
   * 已用而完全没有压力，把比例打扮成压力等级会说出与事实相反的话。
   */
  readonly pressure: string | null;
}

export interface LoadAverage {
  readonly one: number;
  readonly five: number;
  readonly fifteen: number;
}

/** core 自己数据目录所在的那个文件系统。一块盘，不是整张表。 */
export interface DiskUsage {
  readonly mountPoint: string;
  readonly totalBytes: number | null;
  readonly availableBytes: number | null;
}

/**
 * 电池与市电状态。没有电池的台式机报 `source: "ac"` 加一个 null 百分比，那和
 * 「我们没看」是两回事。
 */
export interface PowerSource {
  readonly source: string | null;
  readonly batteryPercent: number | null;
  readonly charging: boolean | null;
}

export interface HostResources {
  readonly hostId: string;
  readonly location: Location;
  readonly platform: string;
  readonly cpuPercent: number | null;
  readonly cpuCores: number | null;
  readonly memory: MemoryUsage;
  readonly loadAverage: LoadAverage | null;
  readonly disk: DiskUsage | null;
  readonly power: PowerSource;
  readonly uptimeSeconds: number | null;
  readonly sampledAt: string;
}

/**
 * core 测到的一个进程。
 *
 * `name` 是可执行文件的文件名，别的什么都不是。没有命令行、没有参数、没有终端
 * 内容——采样只读进程表。
 */
export interface ProcessSample {
  readonly pid: number;
  readonly startTimeUnixMs: number | null;
  readonly name: string;
  readonly parentPid: number | null;
  readonly memoryBytes: number | null;
  readonly cpuPercent: number | null;
}

/**
 * 一个受管终端会话的进程树。
 *
 * `memoryBytes` 是这棵树常驻大小的和，因此是一个**估计**：共享页的进程各算一次。
 * `memoryEstimated` 在线上说出这件事，好让面板标出来而不是把它当成独占内存。
 */
export interface SessionResources {
  readonly sessionId: string;
  readonly sessionKey: string;
  readonly workspaceId: string;
  readonly nodeId: string | null;
  readonly generation: number;
  readonly backend: string;
  readonly location: Location;
  readonly cwd: string;
  readonly pid: number | null;
  readonly alive: boolean;
  readonly cpuPercent: number | null;
  readonly memoryBytes: number | null;
  readonly memoryEstimated: boolean;
  readonly childCount: number | null;
  readonly state: string | null;
  readonly startTimeUnixMs: number | null;
  /** 树里最重的在前，截到 {@link MAX_LISTED_CHILDREN}。 */
  readonly children: readonly ProcessSample[];
  /**
   * 数字缺席时的原因：`remote`、`no-pid`、`warming-up` 或 `hibernated`。另外两个意思是「这个进程
   * 已经不在这台机器上了」的原因——`exited` 与 `not-found`——**永远不到客户端**：
   * {@link GONE_REASONS} 把那些行从样本里丢掉。
   */
  readonly unknownReason: string | null;
}

/**
 * 领头进程已经退出、或者 pid 不在进程表里的会话不是一行破折号——它根本不是一行。
 * 结束了的会话从样本里被丢掉，而不是被列成测不到，所以面板的会话列表里永远只有
 * 还在的会话。
 */
export const GONE_REASONS = ["exited", "not-found"] as const;

/** 采样器被要求测什么。由终端会话的实时记录构成。 */
export interface SessionTarget {
  readonly sessionId: string;
  readonly sessionKey: string;
  readonly workspaceId: string;
  readonly nodeId: string | null;
  readonly generation: number;
  readonly backend: string;
  readonly cwd: string;
  readonly pid: number | null;
  readonly exited: boolean;
  /** 会话的进程是 `ssh`，活儿发生在另一台主机上。 */
  readonly remote: boolean;
  /**
   * Eco 休眠着（终端宿主设计 §7.2）：进程已经结束，恢复信息留在库里。面板照列
   * 这一行、写明「已休眠」，但它不占内存，数字恒为空。
   */
  readonly hibernated?: boolean;
}

/** `ps` 一行读出来的东西。 */
export interface ProcessRow {
  readonly pid: number;
  readonly parent: number;
  readonly rssBytes: number;
  /** 累计 CPU 时间，毫秒。 */
  readonly cpuMs: number;
  readonly startTimeUnixMs: number | null;
  readonly state: string | null;
  readonly name: string;
  /**
   * `ps -o comm` 给的可执行路径。它是「这个进程属不属于这次安装」的唯一证据，
   * 所以整条留着而不是只留文件名。读不到时是空串——空的来源就是来源不明。
   */
  readonly path: string;
}

/**
 * `ps` 的 `time` 列 → 毫秒。
 *
 * macOS 给 `mm:ss.cc`，Linux 给 `[dd-]hh:mm:ss`。两种都认，认不出来就是 0——那是
 * 「没读到」，让 CPU 停在 `null` 而不是编一个数出来。
 */
export function parseCpuTime(value: string): number {
  const raw = value.trim();
  if (raw === "") return 0;
  let days = 0;
  let rest = raw;
  const dash = rest.indexOf("-");
  if (dash > 0) {
    days = Number.parseInt(rest.slice(0, dash), 10);
    if (!Number.isFinite(days)) return 0;
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(":");
  if (parts.length < 2 || parts.length > 3) return 0;
  let seconds = 0;
  for (const part of parts) {
    const number = Number.parseFloat(part);
    if (!Number.isFinite(number)) return 0;
    seconds = seconds * 60 + number;
  }
  return Math.round((days * 86_400 + seconds) * 1000);
}

/** `ps` 的 `lstart` 列（`Wed Sep  9 22:19:25 2026`）→ 毫秒；解析不了就是 null。 */
export function parseStartTime(value: string): number | null {
  const parsed = Date.parse(value.trim().replace(/\s+/g, " "));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `ps` 的状态码 → `sysinfo` 的 `ProcessStatus` 小写名。
 *
 * 对齐是有意的：两种 core 在同一台机器上该给同一个词，否则面板会在切换实现时
 * 显示出一个看起来是「变了」的状态。认不出来的码是 `unknown`，不是最接近的猜测。
 */
export function processState(code: string): string | null {
  const first = code.trim().charAt(0);
  switch (first) {
    case "R":
      return "runnable";
    case "S":
      return "sleeping";
    case "I":
      return "idle";
    case "T":
    case "t":
      return "stopped";
    case "Z":
      return "zombie";
    case "D":
    case "U":
      return "uninterruptible";
    case "":
      return null;
    default:
      return "unknown";
  }
}

/** 一行 `ps` 输出 → {@link ProcessRow}。认不出来的行返回 `undefined`。 */
export function parseProcessRow(line: string): ProcessRow | undefined {
  // `lstart` 自己带空格，所以前四列按空白切，`lstart` 固定五个词，剩下的是 comm。
  const match =
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)\s+([\s\S]*)$/.exec(
      line,
    );
  if (match === null) return undefined;
  const pid = Number.parseInt(match[1] as string, 10);
  const parent = Number.parseInt(match[2] as string, 10);
  const rssKib = Number.parseInt(match[3] as string, 10);
  if (!Number.isInteger(pid) || !Number.isInteger(parent)) return undefined;
  const path = (match[7] as string).trim();
  return {
    pid,
    parent,
    rssBytes: rssKib * 1024,
    cpuMs: parseCpuTime(match[4] as string),
    startTimeUnixMs: parseStartTime(match[5] as string),
    state: processState(match[6] as string),
    name: executableName(path),
    path,
  };
}

/** 可执行文件的文件名，去掉 Windows 扩展名。 */
export function executableName(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  return base.replace(/\.exe$/i, "");
}

/** 一次全表读。Windows 上没有 `ps`，返回空表——每一项据此报 `null`。 */
export function readProcessTable(): Map<number, ProcessRow> {
  const table = new Map<number, ProcessRow>();
  if (process.platform === "win32") return table;
  let output: string;
  try {
    output = execFileSync(
      "ps",
      ["-Ao", "pid=,ppid=,rss=,time=,lstart=,state=,comm="],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    return table;
  }
  for (const line of output.split("\n")) {
    const row = parseProcessRow(line);
    if (row !== undefined) table.set(row.pid, row);
  }
  return table;
}

/** 一次完整刷新：进程表、读它的时刻，以及上一次刷新留下的 CPU 基线。 */
export interface Refresh {
  readonly table: Map<number, ProcessRow>;
  readonly atMs: number;
  /** 上一次的表，够新才在；`undefined` 表示这一轮的 CPU 一律 `null`。 */
  readonly previousTable: Map<number, ProcessRow> | undefined;
  /** 距上一次刷新过了多久，毫秒。没有基线时是 0。 */
  readonly elapsedMs: number;
}

/**
 * 跨样本持有进程表与 CPU 基线。必须复用：每次都新建一个会让每一个 CPU 读数都是
 * `null`。
 */
export class Sampler {
  private previous: Map<number, ProcessRow> | undefined;
  private previousAtMs = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly read: () => Map<number, ProcessRow> = readProcessTable,
  ) {}

  /** 刷新一次，并把上一次的表（如果还算数）一起交出去。 */
  refresh(): Refresh {
    const atMs = this.now();
    const elapsedMs = atMs - this.previousAtMs;
    const fresh =
      this.previous !== undefined &&
      elapsedMs > 0 &&
      elapsedMs <= MAX_CPU_BASELINE_AGE_MS;
    const previous = fresh ? this.previous : undefined;
    const table = this.read();
    this.previous = table;
    this.previousAtMs = atMs;
    return {
      table,
      atMs,
      previousTable: previous,
      elapsedMs: fresh ? elapsedMs : 0,
    };
  }
}

/**
 * 两次刷新之间一个进程的 CPU 百分比。
 *
 * 没有上一次、上一次没有这个 pid、或者那个 pid 被重用了（启动时间对不上）都返回
 * `null`：这三种情况里差都不是这个进程的负载。
 */
export function cpuPercent(
  row: ProcessRow,
  previous: Map<number, ProcessRow> | undefined,
  elapsedMs: number,
): number | null {
  if (previous === undefined || elapsedMs <= 0) return null;
  const before = previous.get(row.pid);
  if (before === undefined) return null;
  if (before.startTimeUnixMs !== row.startTimeUnixMs) return null;
  const delta = row.cpuMs - before.cpuMs;
  if (delta < 0) return null;
  return round((delta / elapsedMs) * 100);
}

/** 一位小数。十五位数字的百分比是噪声，而且每个样本都在变。 */
export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `parent -> children`，每个样本建一次，让 N 棵树的遍历是线性而不是 N × 表。 */
export function childrenByParent(
  table: ReadonlyMap<number, ProcessRow>,
): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const row of table.values()) {
    const list = children.get(row.parent);
    if (list === undefined) children.set(row.parent, [row.pid]);
    else list.push(row.pid);
  }
  return children;
}

/** `root` 加它的后代，有界而且不重访：一张变动中的表可以把一个 pid 说成自己的祖先。 */
export function collectTree(
  root: number,
  children: ReadonlyMap<number, number[]>,
): number[] {
  const tree = [root];
  const seen = new Set([root]);
  for (
    let index = 0;
    index < tree.length && tree.length < MAX_TREE;
    index += 1
  ) {
    for (const pid of children.get(tree[index] as number) ?? []) {
      if (tree.length >= MAX_TREE) break;
      if (seen.has(pid)) continue;
      seen.add(pid);
      tree.push(pid);
    }
  }
  return tree;
}

export function processSample(
  row: ProcessRow,
  previous: Map<number, ProcessRow> | undefined,
  elapsedMs: number,
): ProcessSample {
  return {
    pid: row.pid,
    startTimeUnixMs: row.startTimeUnixMs,
    name: row.name,
    parentPid: row.parent,
    memoryBytes: row.rssBytes,
    cpuPercent: cpuPercent(row, previous, elapsedMs),
  };
}

/** 会话的领头进程是不是一个 SSH 客户端，也就是真正的活儿在另一台执行主机上。 */
export function isRemoteExecutable(executable: string): boolean {
  const name = executableName(executable);
  return name.toLowerCase() === "ssh";
}

/** 这个平台的名字，和 Rust 侧同一套拼法。 */
export function platformName(): string {
  if (osPlatform() === "darwin") return "macos";
  if (osPlatform() === "win32") return "windows";
  if (osPlatform() === "linux") return "linux";
  return "unknown";
}

/** Unix 才有负载均值；Windows 上报零会凭空造出一台空闲机器。 */
export function loadAverage(): LoadAverage | null {
  if (process.platform === "win32") return null;
  const [one, five, fifteen] = loadavg();
  return {
    one: round(one ?? 0),
    five: round(five ?? 0),
    fifteen: round(fifteen ?? 0),
  };
}

/** 数据目录所在的那块盘。读不到就是 `null`，不是零。 */
export function diskForDataDir(dataDir: string): DiskUsage | null {
  try {
    const stats = statfsSync(dataDir);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const available = Number(stats.bavail) * Number(stats.bsize);
    return {
      mountPoint: dataDir,
      totalBytes: total > 0 ? total : null,
      availableBytes: total > 0 ? available : null,
    };
  } catch {
    return null;
  }
}

export interface HostSampleOptions {
  readonly dataDir: string;
  readonly cpuCores: number;
  readonly pressure: string | null;
  readonly power: PowerSource;
  readonly swap: { totalBytes: number | null; usedBytes: number | null };
  /** 全机 CPU：所有进程的 CPU 差之和除以核数。 */
  readonly cpuPercent: number | null;
  readonly sampledAt: string;
}

export function hostResources(options: HostSampleOptions): HostResources {
  const total = totalmem();
  const free = freemem();
  return {
    hostId: "local",
    location: "local",
    platform: platformName(),
    cpuPercent: options.cpuPercent,
    cpuCores: options.cpuCores > 0 ? options.cpuCores : null,
    memory: {
      totalBytes: total > 0 ? total : null,
      usedBytes: total > 0 ? total - free : null,
      availableBytes: total > 0 ? free : null,
      swapTotalBytes: options.swap.totalBytes,
      swapUsedBytes: options.swap.usedBytes,
      pressure: options.pressure,
    },
    loadAverage: loadAverage(),
    disk: diskForDataDir(options.dataDir),
    power: options.power,
    uptimeSeconds: Math.round(uptime()),
    sampledAt: options.sampledAt,
  };
}

/** 一个会话的一行，包括「数字为什么缺席」。 */
export function sessionResources(
  target: SessionTarget,
  refresh: Refresh,
  previous: Map<number, ProcessRow> | undefined,
  elapsedMs: number,
  children: ReadonlyMap<number, number[]>,
): SessionResources {
  const unknown = (reason: string): SessionResources => ({
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    workspaceId: target.workspaceId,
    nodeId: target.nodeId,
    generation: target.generation,
    backend: target.backend,
    location: target.remote ? "remote" : "local",
    cwd: target.cwd,
    pid: target.pid,
    alive: !target.exited,
    cpuPercent: null,
    memoryBytes: null,
    memoryEstimated: false,
    childCount: null,
    state: null,
    startTimeUnixMs: null,
    children: [],
    unknownReason: reason,
  });

  // SSH 会话的树住在另一台主机上。把本地那个 `ssh` 客户端的几兆报成这个会话的
  // 占用是撒谎。
  if (target.hibernated === true) {
    return { ...unknown("hibernated"), pid: null, alive: false };
  }
  if (target.remote) return unknown("remote");
  if (target.exited) return unknown("exited");
  if (target.pid === null || target.pid <= 0) return unknown("no-pid");
  const leader = refresh.table.get(target.pid);
  if (leader === undefined) return unknown("not-found");

  const tree = collectTree(target.pid, children);
  let memory = 0;
  let cpu = 0;
  let cpuKnown = false;
  let found = 0;
  // `(pid, startTime)` 而不是只看 pid：一张在遍历中变过的表可以两次说出一个被
  // 重用的 pid，把它的内存算两次会把这个会话吹大。
  const seen = new Set<string>();
  const listed: ProcessSample[] = [];
  for (const pid of tree) {
    const row = refresh.table.get(pid);
    if (row === undefined) continue;
    const key = `${row.pid}:${row.startTimeUnixMs ?? "?"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found += 1;
    memory += row.rssBytes;
    const percent = cpuPercent(row, previous, elapsedMs);
    if (percent !== null) {
      cpu += percent;
      cpuKnown = true;
    }
    if (pid !== target.pid) {
      listed.push(processSample(row, previous, elapsedMs));
    }
  }
  // 最重的在前，被截掉的尾巴是没人在找的那部分。并列时保持 pid 顺序，样本不抖。
  listed.sort(
    (left, right) =>
      (right.memoryBytes ?? 0) - (left.memoryBytes ?? 0) ||
      left.pid - right.pid,
  );

  return {
    ...unknown("warming-up"),
    memoryBytes: memory,
    memoryEstimated: true,
    childCount: Math.max(found - 1, 0),
    state: leader.state,
    startTimeUnixMs: leader.startTimeUnixMs,
    children: listed.slice(0, MAX_LISTED_CHILDREN),
    ...(cpuKnown ? { cpuPercent: round(cpu), unknownReason: null } : {}),
  };
}

/** 这一行描述的会话的进程是不是已经不在了。见 {@link GONE_REASONS}。 */
export function isGone(session: SessionResources): boolean {
  return (
    session.unknownReason !== null &&
    (GONE_REASONS as readonly string[]).includes(session.unknownReason)
  );
}
