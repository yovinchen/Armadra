import type { CostPoint, CostWindow } from "@armadra/shared";
import { X } from "lucide-react";

import { useT } from "../../app/preferences-store";
import { formatTokens, formatUsd, totalTokens } from "../../lib/cost";
import { IconButton } from "@/ui/icon-button";
import { AnimatedNumber } from "./AnimatedNumber";
import { pointLabel, type UsageMetric } from "./metrics";

const CARD =
  "flex flex-col gap-0.5 rounded-lg border border-border bg-panel p-3 transition-colors data-[active=true]:border-ring/50";

const HEAD = "flex items-center gap-1 text-xs text-muted-foreground";

export function MetricCards({
  totals,
  point,
  metric,
  onClear,
}: {
  totals: CostWindow;
  point: CostPoint | null;
  metric: UsageMetric;
  onClear: () => void;
}) {
  const t = useT();
  const source = point ?? totals;
  return (
    <dl className="grid grid-cols-2 gap-2">
      <div
        data-slot="usage-card"
        data-metric="tokens"
        data-active={metric === "tokens"}
        className={CARD}
      >
        <div className={HEAD}>
          <dt>{t("usage.metric.tokens")}</dt>
          {point && <span className="tabular-nums">{pointLabel(point.key)}</span>}
        </div>
        <dd className="text-sm font-medium tabular-nums">
          <AnimatedNumber
            value={totalTokens(source.tokens)}
            format={(value) =>
              t("usage.cost.tokenCount", { value: formatTokens(value) })
            }
          />
        </dd>
      </div>
      <div
        data-slot="usage-card"
        data-metric="cost"
        data-active={metric === "cost"}
        className={CARD}
      >
        <div className={HEAD}>
          <dt>{t("usage.metric.cost")}</dt>
          {point && (
            <>
              <span className="tabular-nums">{pointLabel(point.key)}</span>
              <IconButton
                label={t("usage.selection.clear")}
                className="-my-1 ml-auto"
                onClick={onClear}
              >
                <X />
              </IconButton>
            </>
          )}
        </div>
        <dd className="text-sm font-medium tabular-nums">
          <AnimatedNumber
            value={source.costUsd ?? 0}
            format={(value) => formatUsd(value)}
          />
        </dd>
      </div>
    </dl>
  );
}
