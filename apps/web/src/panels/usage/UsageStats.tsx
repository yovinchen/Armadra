import type { CostPoint, CostRange } from "@armadra/shared";

import { useT } from "../../app/preferences-store";
import { formatTokens, totalTokens } from "../../lib/cost";
import { AnimatedNumber } from "./AnimatedNumber";
import {
  formatMetric,
  metricValue,
  pointLabel,
  TOKEN_FIELDS,
  type UsageMetric,
} from "./metrics";

export function UsageStats({
  range,
  point,
  metric,
}: {
  range: CostRange;
  point: CostPoint | null;
  metric: UsageMetric;
}) {
  const t = useT();
  const source = point ?? range.totals;
  const spread = range.points.length;

  const cells: {
    key: string;
    label: string;
    value: number;
    format: (value: number) => string;
  }[] = [
    {
      key: "total",
      label: t("usage.stats.total"),
      value: totalTokens(source.tokens),
      format: formatTokens,
    },
    ...TOKEN_FIELDS.map((field) => ({
      key: field,
      label: t(`usage.stats.${field}`),
      value: source.tokens[field],
      format: formatTokens,
    })),
    {
      key: "sessions",
      label: t("usage.stats.sessions"),
      value: point ? point.sessions : range.sessions,
      format: (value: number) => String(Math.round(value)),
    },
    {
      key: "peak",
      label: range.peak
        ? `${t("usage.stats.peak")} ${pointLabel(range.peak.key)}`
        : t("usage.stats.peak"),
      value: range.peak ? metricValue(range.peak, metric) : 0,
      format: (value: number) => formatMetric(value, metric),
    },
    {
      key: "active",
      label: t("usage.stats.active"),
      value: range.activeIntervals,
      format: (value: number) => `${Math.round(value)}/${spread}`,
    },
    {
      key: "streak",
      label: t("usage.stats.streak"),
      value: range.longestStreak,
      format: (value: number) => String(Math.round(value)),
    },
  ];

  return (
    <dl
      data-slot="usage-stats"
      className="grid grid-cols-3 gap-x-2 gap-y-2 rounded-lg border border-border bg-panel p-3"
    >
      {cells.map((cell) => (
        <div key={cell.key} data-slot="usage-stat" data-stat={cell.key}>
          <dt className="truncate text-[11px] text-muted-foreground">
            {cell.label}
          </dt>
          <dd className="text-xs font-medium tabular-nums">
            <AnimatedNumber
              value={cell.value}
              unit={metric}
              format={cell.format}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}
