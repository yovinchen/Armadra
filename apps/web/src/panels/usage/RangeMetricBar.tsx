import type { CostRangeKey } from "@armadra/shared";

import { useT } from "../../app/preferences-store";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { METRIC_KEYS, RANGE_KEYS, type UsageMetric } from "./metrics";

export function RangeMetricBar({
  range,
  metric,
  onRangeChange,
  onMetricChange,
}: {
  range: CostRangeKey;
  metric: UsageMetric;
  onRangeChange: (range: CostRangeKey) => void;
  onMetricChange: (metric: UsageMetric) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        spacing={0}
        value={range}
        onValueChange={(next) => next && onRangeChange(next as CostRangeKey)}
      >
        {RANGE_KEYS.map((key) => (
          <ToggleGroupItem key={key} value={key}>
            {t(`usage.range.${key}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        spacing={0}
        value={metric}
        onValueChange={(next) => next && onMetricChange(next as UsageMetric)}
      >
        {METRIC_KEYS.map((key) => (
          <ToggleGroupItem key={key} value={key}>
            {t(`usage.metric.${key}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
