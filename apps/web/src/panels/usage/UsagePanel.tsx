import { type ReactNode, useMemo, useState } from "react";
import type { CostRangeKey, CostSummary } from "@armadra/shared";
import { motion, useReducedMotion } from "motion/react";

import { useT } from "../../app/preferences-store";
import { useAgentsQuery } from "../../app/use-agents";
import { DimensionChart, type DimensionSeries } from "./DimensionChart";
import { MetricCards } from "./MetricCards";
import { RangeMetricBar } from "./RangeMetricBar";
import { UsageSkyline } from "./UsageSkyline";
import {
  MUTED_SERIES_COLOR,
  SERIES_COLORS,
  metricValue,
  type UsageMetric,
} from "./metrics";

/** 前 6 个模型各占一条，其余并成「其他」。 */
const MODEL_SERIES = 6;

export function UsagePanel({ summary }: { summary: CostSummary }) {
  const t = useT();
  const agents = useAgentsQuery();
  const reduced = useReducedMotion();
  const [range, setRange] = useState<CostRangeKey>("7d");
  const [metric, setMetric] = useState<UsageMetric>("tokens");

  const current = summary.ranges[range];
  const agentList = agents.data;

  const modelSeries = useMemo<DimensionSeries[]>(() => {
    const top = current.byModel.slice(0, MODEL_SERIES);
    const named = new Set(top.map((model) => model.model));
    const series: DimensionSeries[] = top.map((model, index) => ({
      key: `m${index}`,
      label: model.model,
      color: SERIES_COLORS[index] ?? MUTED_SERIES_COLOR,
      total: metricValue(model, metric),
      value: (point) => {
        const hit = point.models.find((entry) => entry.model === model.model);
        return hit ? metricValue(hit, metric) : 0;
      },
    }));
    const rest = current.byModel
      .slice(MODEL_SERIES)
      .reduce((sum, model) => sum + metricValue(model, metric), 0);
    if (rest > 0) {
      series.push({
        key: "other",
        label: t("usage.breakdown.other"),
        color: MUTED_SERIES_COLOR,
        total: rest,
        value: (point) =>
          point.models
            .filter((entry) => !named.has(entry.model))
            .reduce((sum, entry) => sum + metricValue(entry, metric), 0),
      });
    }
    return series;
  }, [current.byModel, metric, t]);

  const agentSeries = useMemo<DimensionSeries[]>(
    () =>
      current.byAgent
        .filter((entry) => entry.source === "local")
        .map((entry, index) => {
          const info = agentList?.find((agent) => agent.id === entry.agent);
          return {
            key: `a${index}`,
            label: info?.label ?? entry.agent,
            color:
              info?.color ??
              SERIES_COLORS[index % SERIES_COLORS.length] ??
              MUTED_SERIES_COLOR,
            total: metricValue(entry, metric),
            value: (point) => {
              const hit = point.agents.find(
                (candidate) => candidate.agent === entry.agent,
              );
              return hit ? metricValue(hit, metric) : 0;
            },
          };
        }),
    [agentList, current.byAgent, metric],
  );

  const withoutSource = current.byAgent
    .filter((entry) => entry.source === "none")
    .map(
      (entry) =>
        agentList?.find((agent) => agent.id === entry.agent)?.label ??
        entry.agent,
    );

  return (
    <div className="flex flex-col gap-3">
      <RangeMetricBar
        range={range}
        metric={metric}
        onRangeChange={setRange}
        onMetricChange={setMetric}
      />
      <MetricCards totals={current.totals} metric={metric} />
      <RangeFade rangeKey={range} reduced={reduced}>
        <UsageSkyline range={current} rangeKey={range} metric={metric} />
      </RangeFade>
      <RangeFade rangeKey={range} reduced={reduced}>
        <DimensionChart
          title={t("usage.breakdown.byModel")}
          points={current.points}
          series={modelSeries}
          metric={metric}
        />
      </RangeFade>
      <RangeFade rangeKey={range} reduced={reduced}>
        <DimensionChart
          title={t("usage.breakdown.byAgent")}
          points={current.points}
          series={agentSeries}
          metric={metric}
          noteBelow={
            withoutSource.length > 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {t("usage.breakdown.noLocalSource", {
                  value: withoutSource.join(t("usage.cost.separator")),
                })}
              </p>
            ) : undefined
          }
        />
      </RangeFade>
    </div>
  );
}

/**
 * 范围切换时点数与形态都变了，原地补间没有意义，所以按 key 重挂载并淡入；
 * 不等旧内容淡出——那 160ms 里三张图都是空白。指标切换不换 key，图表保持
 * 挂载，由 recharts 自己补间。
 */
function RangeFade({
  rangeKey,
  reduced,
  children,
}: {
  rangeKey: CostRangeKey;
  reduced: boolean | null;
  children: ReactNode;
}) {
  return (
    <motion.div
      key={rangeKey}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduced ? 0 : 0.16 }}
    >
      {children}
    </motion.div>
  );
}
