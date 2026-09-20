import type { CostRangeKey, CostTokens } from "@armadra/shared";

import {
  formatTokens,
  formatUsd,
  shortDate,
  totalTokens,
} from "../../lib/cost";

/** 看板的两个轴：时间范围（契约给的四段）与指标。 */
export type UsageMetric = "tokens" | "cost";

export const RANGE_KEYS: readonly CostRangeKey[] = ["24h", "7d", "30d", "all"];

export const METRIC_KEYS: readonly UsageMetric[] = ["tokens", "cost"];

/** 系列色。第六条用品牌色，`其他` 与无来源用 muted，都随主题翻转。 */
export const SERIES_COLORS: readonly string[] = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--brand)",
];

export const MUTED_SERIES_COLOR = "var(--muted-foreground)";

export const TOKEN_FIELDS: readonly (keyof CostTokens)[] = [
  "input",
  "output",
  "cacheRead",
  "cacheCreation",
];

export function metricValue(
  entry: { tokens: CostTokens; costUsd: number | null },
  metric: UsageMetric,
): number {
  if (metric === "cost") return entry.costUsd ?? 0;
  return totalTokens(entry.tokens);
}

export function formatMetric(value: number, metric: UsageMetric): string {
  return metric === "cost" ? formatUsd(value) : formatTokens(value);
}

/** 小时粒度的点只显示 `HH`，日粒度显示 `月/日`。 */
export function pointLabel(key: string): string {
  const hour = key.slice(11, 13);
  return key.includes("T") && hour ? hour : shortDate(key);
}

/** 相对峰值分 4 档，柱子与热力格之间有轻重但不至于让小值消失。 */
export function intensity(value: number, peak: number): number {
  if (value <= 0) return 0;
  const ratio = peak > 0 ? value / peak : 0;
  if (ratio > 0.75) return 1;
  if (ratio > 0.5) return 0.78;
  if (ratio > 0.25) return 0.56;
  return 0.36;
}

export const INTENSITY_STEPS: readonly number[] = [0, 0.36, 0.56, 0.78, 1];
