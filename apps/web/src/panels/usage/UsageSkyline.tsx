import { useMemo, useState } from "react";
import type { CostPoint, CostRange, CostRangeKey } from "@armadra/shared";
import { useReducedMotion } from "motion/react";
import { Bar, BarChart, Cell, XAxis } from "recharts";

import { useT } from "../../app/preferences-store";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/ui/chart";
import { AnimatedNumber } from "./AnimatedNumber";
import { Donut, type DonutSlice } from "./Donut";
import { Heatmap } from "./Heatmap";
import {
  MUTED_SERIES_COLOR,
  SERIES_COLORS,
  TOKEN_FIELDS,
  formatMetric,
  intensity,
  metricValue,
  pointLabel,
  type UsageMetric,
} from "./metrics";

const DONUT_MODELS = 5;

/** Bar 的点击回调给的是矩形属性：key 有时在 payload 里，有时已被摊平。 */
function barKey(data: unknown): string | null {
  const entry = data as { key?: unknown; payload?: { key?: unknown } };
  const key = entry?.payload?.key ?? entry?.key;
  return typeof key === "string" ? key : null;
}

export function UsageSkyline({
  range,
  rangeKey,
  metric,
  selected,
  onSelect,
}: {
  range: CostRange;
  rangeKey: CostRangeKey;
  metric: UsageMetric;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const t = useT();
  const reduced = useReducedMotion();
  const [hovered, setHovered] = useState<string | null>(null);

  const point = useMemo(
    () => range.points.find((entry) => entry.key === selected) ?? null,
    [range.points, selected],
  );

  const slices = useMemo<DonutSlice[]>(() => {
    const source = point ?? range.totals;
    if (metric === "tokens") {
      return TOKEN_FIELDS.map((field, index) => ({
        key: field,
        label: t(`usage.tokens.${field}`),
        value: source.tokens[field],
        color: SERIES_COLORS[index] as string,
      }));
    }
    const models = point
      ? [...point.models].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
      : range.byModel;
    const top = models.slice(0, DONUT_MODELS).map((model, index) => ({
      key: `m${index}`,
      label: model.model,
      value: model.costUsd ?? 0,
      color: SERIES_COLORS[index] as string,
    }));
    const rest = models
      .slice(DONUT_MODELS)
      .reduce((sum, model) => sum + (model.costUsd ?? 0), 0);
    return rest > 0
      ? [
          ...top,
          {
            key: "other",
            label: t("usage.breakdown.other"),
            value: rest,
            color: MUTED_SERIES_COLOR,
          },
        ]
      : top;
  }, [metric, point, range.byModel, range.totals, t]);

  const rows = useMemo(
    () =>
      range.points.map((entry) => ({
        key: entry.key,
        value: metricValue(entry, metric),
      })),
    [metric, range.points],
  );

  const timelineConfig: ChartConfig = useMemo(
    () => ({
      value: { label: t(`usage.metric.${metric}`), color: SERIES_COLORS[0] },
    }),
    [metric, t],
  );

  const total = metricValue(point ?? range.totals, metric);
  const peakValue = Math.max(...rows.map((row) => row.value), 0);
  const marked = hovered ?? selected;
  const markedRow = rows.find((row) => row.key === marked);
  const tick = Math.max(0, Math.ceil(range.points.length / 6) - 1);

  return (
    <section
      data-slot="usage-skyline"
      aria-label={t("usage.skyline.title")}
      className="flex flex-col gap-2"
    >
      <h3 className="text-xs font-medium text-muted-foreground">
        {t("usage.skyline.title")}
      </h3>
      <div className="flex items-center gap-3">
        <div className="relative size-[104px] shrink-0">
          <Donut slices={slices} metric={metric} />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <AnimatedNumber
              value={total}
              format={(value) => formatMetric(value, metric)}
              className="text-xs font-medium"
            />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div
            data-slot="usage-skyline-meta"
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums"
          >
            {markedRow ? (
              <span>{`${formatMetric(markedRow.value, metric)} · ${pointLabel(markedRow.key)}`}</span>
            ) : (
              <>
                {range.peak && (
                  <span>
                    {t("usage.skyline.peak", {
                      value: formatMetric(
                        metricValue(range.peak, metric),
                        metric,
                      ),
                      key: pointLabel(range.peak.key),
                    })}
                  </span>
                )}
                <span>
                  {t("usage.skyline.active", {
                    value: range.activeIntervals,
                    total: range.points.length,
                  })}
                </span>
                <span>
                  {t("usage.skyline.streak", { value: range.longestStreak })}
                </span>
              </>
            )}
          </div>
          {rangeKey !== "all" && (
            <ChartContainer
              config={timelineConfig}
              data-slot="usage-timeline"
              className="aspect-auto h-[96px] w-full"
            >
              <BarChart
                data={rows}
                margin={{ top: 4, right: 8, bottom: 0, left: 8 }}
                onMouseMove={(state) =>
                  setHovered(
                    typeof state.activeLabel === "string"
                      ? state.activeLabel
                      : null,
                  )
                }
                onMouseLeave={() => setHovered(null)}
                className="cursor-pointer"
              >
                <XAxis
                  dataKey="key"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={4}
                  interval={tick}
                  tick={{ fontSize: 10 }}
                  tickFormatter={pointLabel}
                />
                <ChartTooltip cursor={false} content={() => null} />
                <Bar
                  dataKey="value"
                  radius={2}
                  onClick={(data: unknown) => {
                    const key = barKey(data);
                    if (key) onSelect(key);
                  }}
                  isAnimationActive={!reduced}
                  animationDuration={350}
                  animationEasing="ease-out"
                >
                  {rows.map((row) => (
                    <Cell
                      key={row.key}
                      fill="var(--color-value)"
                      fillOpacity={
                        row.key === selected
                          ? 1
                          : intensity(row.value, peakValue)
                      }
                      stroke={
                        row.key === selected ? "var(--color-value)" : undefined
                      }
                      strokeWidth={row.key === selected ? 1.5 : 0}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
          )}
        </div>
      </div>
      {rangeKey === "all" && (
        <Heatmap
          points={range.points as CostPoint[]}
          metric={metric}
          selected={selected}
          onSelect={onSelect}
          onHover={setHovered}
        />
      )}
    </section>
  );
}
