import { useMemo, useState } from "react";
import type { CostRange, CostRangeKey } from "@armadra/shared";
import { motion, useReducedMotion } from "motion/react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  XAxis,
} from "recharts";

import { useT } from "../../app/preferences-store";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/ui/chart";
import { AnimatedNumber } from "./AnimatedNumber";
import {
  MUTED_SERIES_COLOR,
  SERIES_COLORS,
  TOKEN_FIELDS,
  formatMetric,
  metricValue,
  pointLabel,
  type UsageMetric,
} from "./metrics";

const DONUT_MODELS = 5;

/** 相对峰值分 4 档，柱子之间有轻重但不至于让小值消失。 */
function intensity(value: number, peak: number): number {
  if (value <= 0) return 0;
  const ratio = peak > 0 ? value / peak : 0;
  if (ratio > 0.75) return 1;
  if (ratio > 0.5) return 0.78;
  if (ratio > 0.25) return 0.56;
  return 0.36;
}

export function UsageSkyline({
  range,
  rangeKey,
  metric,
}: {
  range: CostRange;
  rangeKey: CostRangeKey;
  metric: UsageMetric;
}) {
  const t = useT();
  const reduced = useReducedMotion();
  const [hovered, setHovered] = useState<string | null>(null);

  const slices = useMemo(() => {
    if (metric === "tokens") {
      return TOKEN_FIELDS.map((field, index) => ({
        key: field,
        label: t(`usage.tokens.${field}`),
        value: range.totals.tokens[field],
        color: SERIES_COLORS[index] as string,
      }));
    }
    const top = range.byModel.slice(0, DONUT_MODELS).map((model, index) => ({
      key: `m${index}`,
      label: model.model,
      value: model.costUsd ?? 0,
      color: SERIES_COLORS[index] as string,
    }));
    const rest = range.byModel
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
  }, [metric, range.byModel, range.totals.tokens, t]);

  const rows = useMemo(
    () =>
      range.points.map((point) => ({
        key: point.key,
        value: metricValue(point, metric),
      })),
    [metric, range.points],
  );

  const donutConfig: ChartConfig = useMemo(
    () =>
      Object.fromEntries(
        slices.map((slice) => [
          slice.key,
          { label: slice.label, color: slice.color },
        ]),
      ),
    [slices],
  );

  const timelineConfig: ChartConfig = useMemo(
    () => ({
      value: { label: t(`usage.metric.${metric}`), color: SERIES_COLORS[0] },
    }),
    [metric, t],
  );

  const total = metricValue(range.totals, metric);
  const peakValue = Math.max(...rows.map((row) => row.value), 0);
  const hoveredRow = rows.find((row) => row.key === hovered);
  const tick = Math.max(0, Math.ceil(range.points.length / 6) - 1);
  const gradientId = `usage-skyline-${rangeKey}`;

  return (
    <section
      aria-label={t("usage.skyline.title")}
      className="flex flex-col gap-2"
    >
      <h3 className="text-xs font-medium text-muted-foreground">
        {t("usage.skyline.title")}
      </h3>
      <div className="flex items-center gap-3">
        <div className="relative size-[104px] shrink-0">
          {/* Pie 的进场动画挂载后好几秒都不画扇区；两种指标的扇区集合又完全不同，所以关掉它换成淡入。 */}
          <motion.div
            key={metric}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: reduced ? 0 : 0.16 }}
          >
            <ChartContainer
              config={donutConfig}
              className="aspect-square size-[104px]"
            >
              <PieChart>
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      hideLabel
                      nameKey="label"
                      formatter={(value, name) => (
                        <span className="flex flex-1 justify-between gap-2">
                          <span className="text-muted-foreground">{name}</span>
                          <span className="font-medium tabular-nums">
                            {formatMetric(Number(value), metric)}
                          </span>
                        </span>
                      )}
                    />
                  }
                />
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="label"
                  innerRadius={32}
                  outerRadius={50}
                  paddingAngle={1}
                  strokeWidth={0}
                  isAnimationActive={false}
                >
                  {slices.map((slice) => (
                    <Cell key={slice.key} fill={`var(--color-${slice.key})`} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
          </motion.div>
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
            {hoveredRow ? (
              <span>{`${formatMetric(hoveredRow.value, metric)} · ${pointLabel(hoveredRow.key)}`}</span>
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
          <ChartContainer
            config={timelineConfig}
            className="aspect-auto h-[96px] w-full"
          >
            {rangeKey === "all" ? (
              <AreaChart
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
              >
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="var(--color-value)"
                      stopOpacity={0.45}
                    />
                    <stop
                      offset="100%"
                      stopColor="var(--color-value)"
                      stopOpacity={0.02}
                    />
                  </linearGradient>
                </defs>
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
                <Area
                  dataKey="value"
                  type="monotone"
                  stroke="var(--color-value)"
                  strokeWidth={1}
                  fill={`url(#${gradientId})`}
                  dot={false}
                  activeDot={{ r: 2 }}
                  isAnimationActive={!reduced}
                  animationDuration={350}
                  animationEasing="ease-out"
                />
              </AreaChart>
            ) : (
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
                  isAnimationActive={!reduced}
                  animationDuration={350}
                  animationEasing="ease-out"
                >
                  {rows.map((row) => (
                    <Cell
                      key={row.key}
                      fill="var(--color-value)"
                      fillOpacity={intensity(row.value, peakValue)}
                    />
                  ))}
                </Bar>
              </BarChart>
            )}
          </ChartContainer>
        </div>
      </div>
    </section>
  );
}
