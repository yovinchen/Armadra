import type { ProcessMetric } from "electron";

import type { DriveEvent } from "../../shell-core/browser/drive";

/**
 * 壳自身的进程占用，报给 core 的资源域（roadmap §3.10「平台组件」）。
 *
 * core 只看得见自己和自己起的进程；Electron 主进程、界面渲染进程、GPU 进程和
 * 浏览器节点的 `<webview>` guest 都是壳的，面板上过去一行都没有——而一个开着
 * 五个浏览器节点的窗口，大头恰恰在这里。
 *
 * 为什么由壳报而不是 core 自己按名字去找：平台组件的规矩是「发现靠证据，从不
 * 靠长得像」（`core/resources/platform.ts`）。哪个 pid 是 GPU、哪个渲染进程
 * 属于 guest，只有 `app.getAppMetrics()` 与 `webContents.getOSProcessId()`
 * 说得清。
 *
 * 走的是已有的 drive 通道（`browser:drive` 的 WebSocket）：它本来就是壳 → core
 * 的事件通道，不为这件事再开一条。
 */

/** 与 `core/resources/platform.ts` 的 `ShellProcessKind` 同一组值。 */
export type ShellProcessKind =
  | "shellMain"
  | "shellRenderer"
  | "shellGpu"
  | "shellUtility"
  | "browserGuest";

export interface ShellProcessReport {
  readonly pid: number;
  readonly kind: ShellProcessKind;
  /** 进程创建时间（Unix 毫秒），与 pid 一起才构成身份。 */
  readonly startTimeUnixMs: number | null;
  readonly memoryBytes: number | null;
  readonly cpuPercent: number | null;
}

/** 多久报一次。面板的采样间隔是秒级，更勤没有意义。 */
export const SHELL_METRICS_INTERVAL_MS = 5_000;

export const SHELL_METRICS_EVENT = "shellMetrics";

export function classifyMetrics(
  metrics: readonly Pick<
    ProcessMetric,
    "pid" | "type" | "creationTime" | "memory" | "cpu"
  >[],
  guestPids: ReadonlySet<number>,
): ShellProcessReport[] {
  return metrics
    .filter((metric) => Number.isInteger(metric.pid) && metric.pid > 0)
    .map((metric) => ({
      pid: metric.pid,
      kind: kindOf(metric.type, guestPids.has(metric.pid)),
      startTimeUnixMs: Number.isFinite(metric.creationTime)
        ? Math.round(metric.creationTime)
        : null,
      // `workingSetSize` 的单位是 KB。
      memoryBytes: Number.isFinite(metric.memory?.workingSetSize)
        ? metric.memory.workingSetSize * 1024
        : null,
      cpuPercent: Number.isFinite(metric.cpu?.percentCPUUsage)
        ? Math.round(metric.cpu.percentCPUUsage * 10) / 10
        : null,
    }))
    .sort((left, right) => left.pid - right.pid);
}

function kindOf(type: string, guest: boolean): ShellProcessKind {
  if (type === "Browser") return "shellMain";
  if (type === "GPU") return "shellGpu";
  if (type === "Tab") return guest ? "browserGuest" : "shellRenderer";
  return "shellUtility";
}

export function shellMetricsEvent(
  processes: readonly ShellProcessReport[],
): DriveEvent {
  // `nodeId` 是 drive 事件的必填字段；这一条不属于任何节点，给空串。
  return { type: "event", event: SHELL_METRICS_EVENT, nodeId: "", processes };
}
