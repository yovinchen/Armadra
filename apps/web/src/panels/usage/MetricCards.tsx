import type { CostWindow } from "@armadra/shared";

import { useT } from "../../app/preferences-store";
import { formatTokens, formatUsd, totalTokens } from "../../lib/cost";
import { AnimatedNumber } from "./AnimatedNumber";
import type { UsageMetric } from "./metrics";

const CARD =
  "flex flex-col gap-0.5 rounded-lg border border-border bg-panel p-3 transition-colors data-[active=true]:border-ring/50";

export function MetricCards({
  totals,
  metric,
}: {
  totals: CostWindow;
  metric: UsageMetric;
}) {
  const t = useT();
  return (
    <dl className="grid grid-cols-2 gap-2">
      <div
        data-slot="usage-card"
        data-metric="tokens"
        data-active={metric === "tokens"}
        className={CARD}
      >
        <dt className="text-xs text-muted-foreground">
          {t("usage.metric.tokens")}
        </dt>
        <dd className="text-sm font-medium tabular-nums">
          <AnimatedNumber
            value={totalTokens(totals.tokens)}
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
        <dt className="text-xs text-muted-foreground">
          {t("usage.metric.cost")}
        </dt>
        <dd className="text-sm font-medium tabular-nums">
          <AnimatedNumber
            value={totals.costUsd}
            format={(value) =>
              totals.complete
                ? formatUsd(value)
                : t("usage.cost.partial", { value: formatUsd(value) })
            }
          />
        </dd>
      </div>
    </dl>
  );
}
