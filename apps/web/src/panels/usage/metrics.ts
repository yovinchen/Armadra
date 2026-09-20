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
