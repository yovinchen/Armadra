/**
 * 指标格式化（T02，终端宿主设计 §8）。
 *
 * 这一层只有一条规则：**`null` 是一个值，不是 0**。Runtime 对测不出来的
 * 指标发 `null`，这里一律渲染成短横线；把它当 0 显示会变成「这台机器很
 * 闲」——那是另一句话，而且是假话。
 *
 * 所以每个 `format*` 都接受 `number | null | undefined`，并且只有拿到有限
 * 数值时才格式化。
 */
import { formatBytes } from "@/lib/format";
import type {
  HostResources,
  ResourceUnknownReason,
  SessionResources,
} from "@armadra/shared";

/** 测不出来时显示的东西。整个面板只有这一个占位符。 */
export const UNKNOWN = "—";

export function formatMetricBytes(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? formatBytes(value)
    : UNKNOWN;
}

/** 百分比保留一位小数，整数不带 `.0`。 */
export function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return UNKNOWN;
  const rounded = value.toFixed(1).replace(/\.0$/, "");
  return `${rounded}%`;
}

export function formatCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : UNKNOWN;
}

export function formatLoad(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(2)
    : UNKNOWN;
}

/** 运行时长：`3 天 4 小时` / `5 小时 12 分` / `40 分`。 */
export function formatUptime(
  seconds: number | null | undefined,
  labels: { day: string; hour: string; minute: string },
): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return UNKNOWN;
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}${labels.day} ${hours}${labels.hour}`;
  if (hours > 0) return `${hours}${labels.hour} ${minutes}${labels.minute}`;
  return `${minutes}${labels.minute}`;
}

/**
 * 内存已用比例。
 *
 * 刻意只在 total 与 used 都有的时候才算：缺一个就是 `null`，因为
 * 「已用比例」是从两个数推出来的，推不出来就不该猜。
 *
 * 设计 §8 还要求它与「内存压力」分开——已用比例高不等于系统有压力，
 * 所以这里只回一个比例，不回任何压力判断。
 */
export function memoryUsedPercent(host: HostResources): number | null {
  const { totalBytes, usedBytes } = host.memory;
  if (typeof totalBytes !== "number" || totalBytes <= 0) return null;
  if (typeof usedBytes !== "number") return null;
  return (usedBytes / totalBytes) * 100;
}

/** 磁盘已用比例，同样是两个数都在才算。 */
export function diskUsedPercent(host: HostResources): number | null {
  const disk = host.disk;
  if (!disk) return null;
  const { totalBytes, availableBytes } = disk;
  if (typeof totalBytes !== "number" || totalBytes <= 0) return null;
  if (typeof availableBytes !== "number") return null;
  return ((totalBytes - availableBytes) / totalBytes) * 100;
}

/** 会话表格默认按 CPU 从高到低；测不出来的排在最后，而不是当 0 混进来。 */
export type SessionSort = "cpu" | "memory" | "name";

export function sortSessions(
  sessions: readonly SessionResources[],
  sort: SessionSort,
  titleOf: (session: SessionResources) => string,
): SessionResources[] {
  const rows = [...sessions];
  if (sort === "name") {
    return rows.sort((left, right) =>
      titleOf(left).localeCompare(titleOf(right)),
    );
  }
  const key = sort === "cpu" ? "cpuPercent" : "memoryBytes";
  return rows.sort((left, right) => {
    const a = left[key];
    const b = right[key];
    const aKnown = typeof a === "number";
    const bKnown = typeof b === "number";
    if (aKnown && bKnown) return b - a;
    if (aKnown) return -1;
    if (bKnown) return 1;
    return 0;
  });
}

/** `unknownReason` → i18n 键；`null`（有数字）时不显示任何徽标。 */
export function unknownReasonKey(
  reason: ResourceUnknownReason | null,
): string | null {
  return reason === null ? null : `resources.unknown.${reason}`;
}
