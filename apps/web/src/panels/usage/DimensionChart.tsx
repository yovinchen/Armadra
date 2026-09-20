import { type ReactNode, useMemo, useState } from "react";
import type { CostPoint } from "@armadra/shared";
import { useReducedMotion } from "motion/react";
import { Area, AreaChart, ReferenceLine, XAxis } from "recharts";

import { useT } from "../../app/preferences-store";
import { ColorDot } from "@/ui/color-dot";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/ui/chart";
import { formatMetric, pointLabel, type UsageMetric } from "./metrics";

export type DimensionSeries = {
  /** CSS 变量名的一段，所以是 `m0` / `a1` 这样的合成 key，不是模型名。 */
  key: string;
  label: string;
  color: string;
  total: number;
  value: (point: CostPoint) => number;
};

export function DimensionChart({
  title,
  points,
  series,
  metric,
  selected,
  noteBelow,
}: {
  title: string;
  points: CostPoint[];
  series: DimensionSeries[];
  metric: UsageMetric;
  selected: CostPoint | null;
  noteBelow?: ReactNode;
}) {
  const t = useT();
  const reduced = useReducedMotion();
  const [focused, setFocused] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      points.map((point) => {
        const row: Record<string, number | string> = { key: point.key };
        for (const item of series) row[item.key] = item.value(point);
        return row;
      }),
    [points, series],
  );

  const config: ChartConfig = useMemo(
    () =>
      Object.fromEntries(
        series.map((item) => [
          item.key,
          { label: item.label, color: item.color },
        ]),
      ),
    [series],
  );

  const share = (item: DimensionSeries) =>
    selected ? item.value(selected) : item.total;
  const sum = series.reduce((acc, item) => acc + share(item), 0);
  const tick = Math.max(0, Math.ceil(points.length / 6) - 1);

  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {series.length > 0 && (
        <ChartContainer
          config={config}
          className="aspect-auto h-[96px] w-full [&_g:focus]:outline-none"
        >
          <AreaChart
            data={rows}
            margin={{ top: 4, right: 10, bottom: 0, left: 10 }}
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
            {selected && (
              <ReferenceLine
                x={selected.key}
                stroke="var(--muted-foreground)"
                strokeDasharray="2 2"
              />
            )}
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(label) => pointLabel(String(label))}
                  formatter={(value, name) => (
                    <span className="flex flex-1 justify-between gap-2">
                      <span className="text-muted-foreground">
                        {config[String(name)]?.label ?? name}
                      </span>
                      <span className="font-medium tabular-nums">
                        {formatMetric(Number(value), metric)}
                      </span>
                    </span>
                  )}
                />
              }
            />
            {series.map((item) => {
              const dimmed = focused !== null && focused !== item.key;
              return (
                <Area
                  key={item.key}
                  dataKey={item.key}
                  type="monotone"
                  stackId="usage"
                  stroke={`var(--color-${item.key})`}
                  strokeWidth={1}
                  strokeOpacity={dimmed ? 0.15 : 1}
                  fill={`var(--color-${item.key})`}
                  fillOpacity={dimmed ? 0.15 : 0.45}
                  dot={false}
                  activeDot={{ r: 2 }}
                  isAnimationActive={!reduced}
                  animationDuration={350}
                  animationEasing="ease-out"
                />
              );
            })}
          </AreaChart>
        </ChartContainer>
      )}
      <div className="flex flex-col gap-0.5">
        {series.map((item) => (
          <button
            key={item.key}
            type="button"
            data-slot="usage-legend-item"
            data-series={item.key}
            data-dimmed={focused !== null && focused !== item.key}
            aria-pressed={focused === item.key}
            onClick={() =>
              setFocused((current) => (current === item.key ? null : item.key))
            }
            className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs transition-opacity hover:bg-muted data-[dimmed=true]:opacity-40"
          >
            <ColorDot color={item.color} size={8} />
            <span className="min-w-0 flex-1 truncate" title={item.label}>
              {item.label}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {t("usage.percent", {
                value: sum > 0 ? Math.round((share(item) / sum) * 100) : 0,
              })}
            </span>
          </button>
        ))}
      </div>
      {noteBelow}
    </section>
  );
}
