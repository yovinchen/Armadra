import { useState } from "react";
import type { CostDay } from "@armadra/shared";

import { useT } from "../../app/preferences-store";
import {
  formatTokens,
  formatUsd,
  shortDate,
  totalTokens,
} from "../../lib/cost";

/**
 * 30 天日柱状图（§4.2）。
 *
 * 柱高按 token 总量，不按费用：一部分模型没有价格，用费用做高度会让那些
 * 天看起来没有活动。费用在提示与下方明细里说。
 *
 * 图形本身 `aria-hidden`，无障碍走并排的表格——每天一行，屏幕阅读器读到的
 * 是真实数字而不是一堆 div。
 */
export function CostChart({
  daily,
  onSelect,
  selected,
}: {
  daily: CostDay[];
  selected: string | null;
  onSelect: (date: string | null) => void;
}) {
  const t = useT();
  const [hovered, setHovered] = useState<string | null>(null);
  const peak = Math.max(...daily.map((day) => totalTokens(day.tokens)), 1);
  const active = daily.find((day) => day.date === (hovered ?? selected));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t("usage.cost.daily")}
        </h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {active
            ? `${shortDate(active.date)} · ${formatTokens(totalTokens(active.tokens))} · ${
                active.complete
                  ? formatUsd(active.costUsd)
                  : t("usage.cost.partial", {
                      value: formatUsd(active.costUsd),
                    })
              }`
            : t("usage.cost.dailyHint")}
        </span>
      </div>
      <div
        className="flex h-24 items-end gap-px overflow-x-auto"
        onPointerLeave={() => setHovered(null)}
      >
        {daily.map((day) => {
          const tokens = totalTokens(day.tokens);
          const isSelected = day.date === selected;
          return (
            <button
              key={day.date}
              type="button"
              data-slot="cost-bar"
              data-date={day.date}
              data-selected={isSelected || undefined}
              aria-hidden
              tabIndex={-1}
              onPointerEnter={() => setHovered(day.date)}
              onClick={() => onSelect(isSelected ? null : day.date)}
              className="flex h-full min-w-[6px] flex-1 items-end rounded-sm p-0 data-[selected]:bg-accent"
            >
              <span
                className="w-full rounded-sm bg-brand/70 hover:bg-brand"
                // 有活动的那天至少 2px，否则一天几百 token 会完全看不见。
                style={{
                  height:
                    tokens === 0 ? 1 : `max(2px, ${(tokens / peak) * 100}%)`,
                  opacity: tokens === 0 ? 0.25 : 1,
                }}
              />
            </button>
          );
        })}
      </div>
      <table className="sr-only">
        <caption>{t("usage.cost.daily")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("usage.cost.date")}</th>
            <th scope="col">{t("usage.cost.tokens")}</th>
            <th scope="col">{t("usage.cost.spend")}</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((day) => (
            <tr key={day.date}>
              <th scope="row">{day.date}</th>
              <td>{formatTokens(totalTokens(day.tokens))}</td>
              <td>
                {day.complete
                  ? formatUsd(day.costUsd)
                  : t("usage.cost.partial", { value: formatUsd(day.costUsd) })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
