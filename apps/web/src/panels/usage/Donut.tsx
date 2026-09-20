import { useMemo } from "react";
import { useReducedMotion } from "motion/react";
import { Cell, Pie, PieChart } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/ui/chart";
import { formatMetric, type UsageMetric } from "./metrics";

export type DonutSlice = {
  key: string;
  label: string;
  value: number;
  color: string;
};

export function Donut({
  slices,
  metric,
}: {
  slices: DonutSlice[];
  metric: UsageMetric;
}) {
  const reduced = useReducedMotion();

  const config: ChartConfig = useMemo(
    () =>
      Object.fromEntries(
        slices.map((slice) => [
          slice.key,
          { label: slice.label, color: slice.color },
        ]),
      ),
    [slices],
  );

  return (
    <ChartContainer
      config={config}
      data-slot="usage-donut"
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
          isAnimationActive={!reduced}
          animationBegin={0}
          animationDuration={350}
          animationEasing="ease-out"
        >
          {slices.map((slice) => (
            <Cell key={slice.key} fill={`var(--color-${slice.key})`} />
          ))}
        </Pie>
      </PieChart>
    </ChartContainer>
  );
}
