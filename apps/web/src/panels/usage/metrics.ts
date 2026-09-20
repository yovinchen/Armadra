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

/** 五档实色，随主题翻转；0 档是「这一格没有活动」的底色。 */
export const HEAT_LEVELS: readonly string[] = [
  "var(--heat-0)",
  "var(--heat-1)",
  "var(--heat-2)",
  "var(--heat-3)",
  "var(--heat-4)",
];

export type HeatThresholds = readonly [number, number, number];

/**
 * 非零值的四分位当分档线。
 *
 * 不按峰值线性分：一天 11.4B 的极端峰值会把其余每一天都压进最浅一档，
 * 整张图看起来就只剩一个亮点。四分位让每一档都有大致同样多的格子。
 */
export function heatThresholds(values: readonly number[]): HeatThresholds {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return [0, 0, 0];
  const at = (quantile: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))
    ] as number;
  return [at(0.25), at(0.5), at(0.75)];
}

/** 0（没有活动）到 4（最深）。 */
export function heatLevel(value: number, thresholds: HeatThresholds): number {
  if (value <= 0) return 0;
  if (value <= thresholds[0]) return 1;
  if (value <= thresholds[1]) return 2;
  if (value <= thresholds[2]) return 3;
  return 4;
}
