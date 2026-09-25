/**
 * Armadra 自己的进程，和用户的 CLI 会话分开报（设计 §8「平台组件」）。移植自
 * 合并前的实现。
 *
 * 「我的 agent 花了我多少」和「Armadra 花了我多少」是两个问题，一个数字回答不了
 * 两个。面板把这一组单独列出来，所以终端里一次重编译永远不会被读成应用臃肿，而
 * 应用臃肿也永远不会藏在会话总数里。
 *
 * ## 发现靠证据，从不靠长得像
 *
 * 这里没有任何东西因为「看起来像我们的」就认领一个进程。组件要么由它**相对这个
 * 进程**的位置找到，要么来自 core 自己记下的 pid：
 *
 *   * **core** —— 这个进程，按 pid。
 *   * **会话主机** —— `armadra-session-host`（Windows）。它刻意活得比 core 久、
 *     也不是我们的子进程，这正是持久会话的意义所在，所以它按可执行文件名匹配，
 *     **并且**要求和这个 core 住在同一个安装目录里——另一份安装的会话主机于是
 *     永远不会被认成我们的。
 *
 * 相比 Rust 版少了两类：`host` 与 `commandWorker`。它们在 TS core 里不存在——
 * Go Host 与 Rust Worker 就是被这次合并删掉的那两个进程。字段保留而不是删掉，
 * 因为前端按 `kind` 分组，一个它不认识的新值比一个从不出现的旧值更危险。
 */

import { dirname } from "node:path";

import {
  MAX_LISTED_CHILDREN,
  childrenByParent,
  collectTree,
  cpuPercent,
  executableName,
  processSample,
  round,
  type Location,
  type ProcessRow,
  type ProcessSample,
} from "./sample";

/** Windows 持久会话主机的可执行文件名（T01）。 */
const SESSION_HOST_BINARY = "armadra-session-host";

/** 这一行是 Armadra 的哪个进程。 */
export type ComponentKind =
  | "runtime"
  | "host"
  | "commandWorker"
  | "languageServer"
  | "sessionHost"
  | "browserWorker"
  | ShellProcessKind;

/**
 * 桌面壳报上来的它自己的进程（`main/browser/metrics.ts`）：Electron 主进程、
 * 界面渲染进程、GPU、其余辅助进程，以及浏览器节点的 `<webview>` guest。
 */
export type ShellProcessKind =
  | "shellMain"
  | "shellRenderer"
  | "shellGpu"
  | "shellUtility"
  | "browserGuest";

const SHELL_KINDS: readonly ShellProcessKind[] = [
  "shellMain",
  "shellRenderer",
  "shellGpu",
  "shellUtility",
  "browserGuest",
];

/**
 * 一个 Armadra 启动过、并且还有记录的进程：一个语言服务器，或者一个受管浏览器。
 *
 * 启动时间跟着 pid 一起走，因为**只有 pid 不构成身份**：采样的时候，一个已经退出
 * 的进程的 pid 可能已经被重用，认领那一个会把别人的内存放进 Armadra 自己的总数。
 */
export interface TrackedProcess {
  readonly pid: number;
  readonly startTimeUnixMs: number | null;
}

export interface PlatformComponent {
  readonly kind: ComponentKind;
  /** 这个进程在哪台机器上。远端的行不带数字。 */
  readonly location: Location;
  readonly process: ProcessSample;
  /** 数字覆盖后代。core 是 `false`：它的子进程是用户的会话，各自有自己的行。 */
  readonly tree: boolean;
  readonly childCount: number | null;
  readonly children: readonly ProcessSample[];
  /** CPU 还没有基线时是 `warming-up`；有了就是 `null`。 */
  readonly unknownReason: string | null;
}

export interface ComponentOptions {
  readonly table: ReadonlyMap<number, ProcessRow>;
  readonly previousTable: Map<number, ProcessRow> | undefined;
  readonly elapsedMs: number;
  /** core 自己的 pid。 */
  readonly selfPid: number;
  /** 语言域记下来的服务器进程。 */
  readonly language: readonly TrackedProcess[];
  /** 受管浏览器；Electron 壳里浏览器节点的页面是窗口的客人，所以通常是空的。 */
  readonly browsers: readonly TrackedProcess[];
}

/**
 * 这一次刷新看到的 Armadra 自己的进程。
 *
 * 顺序是稳定的——core，然后会话主机、按 pid——所以面板不会在两次采样之间重排。行
 * 按 `(pid, startTime)` 去重。
 */
export function components(options: ComponentOptions): PlatformComponent[] {
  const children = childrenByParent(options.table);
  const found: PlatformComponent[] = [];
  const seen = new Set<string>();

  const push = (kind: ComponentKind, pid: number, tree: boolean): void => {
    const row = options.table.get(pid);
    if (row === undefined) return;
    const sample = processSample(row, options.previousTable, options.elapsedMs);
    const key = `${sample.pid}:${sample.startTimeUnixMs ?? "?"}`;
    if (seen.has(key)) return;
    seen.add(key);
    const warming = sample.cpuPercent === null;
    if (!tree) {
      found.push({
        kind,
        location: "local",
        process: sample,
        tree: false,
        childCount: null,
        children: [],
        unknownReason: warming ? "warming-up" : null,
      });
      return;
    }
    const totals = treeTotals(pid, options, children);
    found.push({
      kind,
      location: "local",
      process: {
        ...sample,
        memoryBytes: totals.memoryBytes,
        cpuPercent: totals.cpuPercent,
      },
      tree: true,
      childCount: totals.childCount,
      children: totals.children,
      unknownReason: totals.cpuPercent === null ? "warming-up" : null,
    });
  };

  // core 按单个进程算，不算树。它启动的终端会话是它的子进程，把它们算进来会在
  // 平台自己的总数里把用户的 agent 再数一遍。
  push("runtime", options.selfPid, false);
  for (const pid of sessionHostPids(options.table, options.selfPid)) {
    push("sessionHost", pid, true);
  }
  // 记下来的 pid，不是名字匹配。按树算：`rust-analyzer` 会跑 `cargo check`，
  // 浏览器的渲染进程是它存在的理由，把子进程漏掉会让一个忙碌的看起来空闲。
  for (const [kind, targets] of [
    ["languageServer", options.language],
    ["browserWorker", options.browsers],
  ] as const) {
    for (const target of targets) {
      const pid = livePid(options.table, target);
      if (pid !== undefined) push(kind, pid, true);
    }
  }
  return found;
}

function treeTotals(
  root: number,
  options: ComponentOptions,
  children: ReadonlyMap<number, number[]>,
): {
  memoryBytes: number;
  cpuPercent: number | null;
  childCount: number;
  children: ProcessSample[];
} {
  const tree = collectTree(root, children);
  let memory = 0;
  let cpu = 0;
  let cpuKnown = false;
  let count = 0;
  const listed: ProcessSample[] = [];
  for (const pid of tree) {
    const row = options.table.get(pid);
    if (row === undefined) continue;
    count += 1;
    memory += row.rssBytes;
    const percent = cpuPercent(row, options.previousTable, options.elapsedMs);
    if (percent !== null) {
      cpu += percent;
      cpuKnown = true;
    }
    if (pid !== root) {
      listed.push(processSample(row, options.previousTable, options.elapsedMs));
    }
  }
  listed.sort(
    (left, right) =>
      (right.memoryBytes ?? 0) - (left.memoryBytes ?? 0) ||
      left.pid - right.pid,
  );
  return {
    memoryBytes: memory,
    cpuPercent: cpuKnown ? round(cpu) : null,
    childCount: Math.max(count - 1, 0),
    children: listed.slice(0, MAX_LISTED_CHILDREN),
  };
}

/**
 * 一个记下来的 `(pid, startTime)` 对着实时进程表解析。
 *
 * pid 越界、或者现在在那个号码上的进程启动时间不一样——号码被重用了，那个进程
 * 不是我们的——就是 `undefined`。
 */
export function livePid(
  table: ReadonlyMap<number, ProcessRow>,
  target: TrackedProcess,
): number | undefined {
  if (target.pid <= 0) return undefined;
  const row = table.get(target.pid);
  if (row === undefined) return undefined;
  if (target.startTimeUnixMs === null || row.startTimeUnixMs === null) {
    return target.pid;
  }
  // 这点余量吸收 `ps` 的一秒分辨率。
  return Math.abs(target.startTimeUnixMs - row.startTimeUnixMs) > 2_000
    ? undefined
    : target.pid;
}

/**
 * 属于这次安装的会话主机。
 *
 * 这是让一次名字匹配不会认领另一份安装的会话主机——或者共享机器上同事那一份——的
 * 东西。读不到可执行路径的进程**不**被认领：读不到的来源就是来源不明，来源不明
 * 就不是我们的。
 */
export function sessionHostPids(
  table: ReadonlyMap<number, ProcessRow>,
  selfPid: number,
  installDirectory: string = dirname(process.execPath),
): number[] {
  if (installDirectory === "") return [];
  const hosts: number[] = [];
  for (const row of table.values()) {
    if (row.pid === selfPid) continue;
    if (row.name !== SESSION_HOST_BINARY) continue;
    // 读不到路径的进程不被认领。
    if (row.path === "" || dirname(row.path) !== installDirectory) continue;
    hosts.push(row.pid);
  }
  return hosts.sort((left, right) => left - right);
}

/**
 * 一个跑在远端执行主机上的语言服务器。
 *
 * 它被列出来是为了让面板能说编辑器在某处启动了一个进程，而它不带 CPU 与内存，
 * 因为这台机器没有办法测量它们。`unknownReason` 说明是哪一种，而不是显示会被读成
 * 空闲服务器的零。
 */
export function remoteLanguageComponent(server: {
  readonly pid: number;
  readonly startTimeUnixMs: number | null;
  readonly executable: string;
  readonly serverId: string;
}): PlatformComponent {
  const name = executableName(server.executable);
  return {
    kind: "languageServer",
    location: "remote",
    process: {
      pid: server.pid,
      startTimeUnixMs: server.startTimeUnixMs,
      name: name === "" ? server.serverId : name,
      parentPid: null,
      memoryBytes: null,
      cpuPercent: null,
    },
    tree: false,
    childCount: null,
    children: [],
    unknownReason: "remote",
  };
}

/* ------------------------- 来自 core 之外的进程来源 ------------------------ */

/**
 * headless 浏览器后端登记的来源（`core/browser/headless`）。放一个模块级的槽
 * 而不是让资源域去找浏览器域：两个域各自装配，谁先谁后不固定，这里只在采样
 * 那一刻问一次。
 */
let browserSource: (() => readonly TrackedProcess[]) | undefined;

export function setBrowserProcessSource(
  source: (() => readonly TrackedProcess[]) | undefined,
): void {
  browserSource = source;
}

export function browserProcesses(): readonly TrackedProcess[] {
  try {
    return browserSource?.() ?? [];
  } catch {
    return [];
  }
}

/** 壳报上来的一行，已经校验过形状。 */
export interface ShellProcessReport {
  readonly pid: number;
  readonly kind: ShellProcessKind;
  readonly startTimeUnixMs: number | null;
  readonly memoryBytes: number | null;
  readonly cpuPercent: number | null;
}

/**
 * 壳每 5 秒报一次；超过这个时间没有新报告，就当壳已经不在（或者通道断了），
 * 不再把旧数字当成现在的。
 */
export const SHELL_REPORT_TTL_MS = 30_000;

let shellReport: { atMs: number; processes: ShellProcessReport[] } | undefined;

/**
 * 收下壳的一次报告。壳是另一个进程，这里按不可信的输入逐行校验：形状不对的
 * 行丢掉，整份不是数组就当没报。
 */
export function reportShellProcesses(raw: unknown, atMs = Date.now()): void {
  if (!Array.isArray(raw)) return;
  const processes: ShellProcessReport[] = [];
  for (const entry of raw.slice(0, 256)) {
    const row = entry as Record<string, unknown> | null;
    if (typeof row !== "object" || row === null) continue;
    const pid = row.pid;
    const kind = row.kind;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
    if (!SHELL_KINDS.includes(kind as ShellProcessKind)) continue;
    processes.push({
      pid,
      kind: kind as ShellProcessKind,
      startTimeUnixMs: finiteOrNull(row.startTimeUnixMs),
      memoryBytes: finiteOrNull(row.memoryBytes),
      cpuPercent: finiteOrNull(row.cpuPercent),
    });
  }
  shellReport = { atMs, processes };
}

export function shellProcesses(nowMs = Date.now()): ShellProcessReport[] {
  if (shellReport === undefined) return [];
  if (nowMs - shellReport.atMs > SHELL_REPORT_TTL_MS) return [];
  return shellReport.processes;
}

/** 测试用。 */
export function resetExternalProcesses(): void {
  shellReport = undefined;
  browserSource = undefined;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * 壳的进程 → 面板上的行。
 *
 * 都按单个进程算（`tree: false`）：Electron 的每个进程各自一行，主进程的子进程
 * 里还有 core 本身，按树算就把 core 和用户的会话又数一遍。
 *
 * 数字优先用本机进程表里那一行——和其余各行同一种量法；进程表里没有（或者
 * pid 对不上启动时间）才用壳自己量的。
 */
export function shellComponents(options: {
  readonly reports: readonly ShellProcessReport[];
  readonly table: ReadonlyMap<number, ProcessRow>;
  readonly previousTable: Map<number, ProcessRow> | undefined;
  readonly elapsedMs: number;
  readonly selfPid: number;
}): PlatformComponent[] {
  const order = new Map(SHELL_KINDS.map((kind, index) => [kind, index]));
  return options.reports
    .filter((report) => report.pid !== options.selfPid)
    .map((report): PlatformComponent => {
      const live = livePid(options.table, report);
      const row = live === undefined ? undefined : options.table.get(live);
      const measured =
        row === undefined
          ? undefined
          : processSample(row, options.previousTable, options.elapsedMs);
      const sample: ProcessSample = measured ?? {
        pid: report.pid,
        startTimeUnixMs: report.startTimeUnixMs,
        name: report.kind,
        parentPid: null,
        memoryBytes: report.memoryBytes,
        cpuPercent: report.cpuPercent,
      };
      return {
        kind: report.kind,
        location: "local",
        process: sample,
        tree: false,
        childCount: null,
        children: [],
        unknownReason: sample.cpuPercent === null ? "warming-up" : null,
      };
    })
    .sort(
      (left, right) =>
        (order.get(left.kind as ShellProcessKind) ?? 0) -
          (order.get(right.kind as ShellProcessKind) ?? 0) ||
        left.process.pid - right.process.pid,
    );
}
