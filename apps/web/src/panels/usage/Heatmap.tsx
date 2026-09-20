import { useEffect, useMemo, useRef } from "react";
import type { CostPoint } from "@armadra/shared";
import { useReducedMotion } from "motion/react";

import { usePreferencesStore, useT } from "../../app/preferences-store";
import {
  HEAT_LEVELS,
  formatMetric,
  heatLevel,
  heatThresholds,
  metricValue,
  type UsageMetric,
} from "./metrics";

const WEEKS = 53;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const CELL = "size-[10px] shrink-0 rounded-[2px]";

/** 行号 → 星期标签，只标三行，七行全标会挤成一团。 */
const ROW_LABELS: Record<number, string> = { 1: "mon", 3: "wed", 5: "fri" };

type Cell = { key: string; value: number } | null;

export function Heatmap({
  points,
  metric,
  selected,
  onSelect,
  onHover,
}: {
  points: CostPoint[];
  metric: UsageMetric;
  selected: string | null;
  onSelect: (key: string) => void;
  onHover: (key: string | null) => void;
}) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const reduced = useReducedMotion();
  const scroller = useRef<HTMLDivElement>(null);

  const grid = useMemo(() => buildGrid(points, metric), [metric, points]);

  const month = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }),
    [locale],
  );

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [grid.columns.length]);

  if (grid.columns.length === 0) return null;

  const duration = reduced ? "0ms" : "350ms";

  return (
    <div data-slot="usage-heatmap" className="flex flex-col gap-1">
      <div className="flex gap-1">
        <div className="flex shrink-0 flex-col gap-[3px] pt-[14px] text-[9px] leading-[10px] text-muted-foreground">
          {Array.from({ length: 7 }, (_, row) => (
            <span key={row} className="h-[10px]">
              {ROW_LABELS[row]
                ? t(`usage.heatmap.weekday.${ROW_LABELS[row]}`)
                : ""}
            </span>
          ))}
        </div>
        <div ref={scroller} className="min-w-0 flex-1 overflow-x-auto">
          <div className="w-max">
            <div className="flex gap-[3px]">
              {grid.columns.map((column) => (
                <div
                  key={column.start}
                  className="relative h-[14px] w-[10px] shrink-0"
                >
                  {column.monthStart !== null && (
                    <span className="absolute top-0 left-0 text-[9px] leading-[10px] whitespace-nowrap text-muted-foreground">
                      {month.format(column.monthStart)}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div className="flex gap-[3px]">
              {grid.columns.map((column) => (
                <div key={column.start} className="flex flex-col gap-[3px]">
                  {column.cells.map((cell, row) =>
                    cell === null ? (
                      <div key={row} className={CELL} />
                    ) : (
                      <button
                        key={cell.key}
                        type="button"
                        data-slot="usage-heatmap-cell"
                        data-key={cell.key}
                        data-selected={selected === cell.key}
                        aria-label={t("usage.heatmap.cell", {
                          date: cell.key,
                          value: formatMetric(cell.value, metric),
                        })}
                        onClick={() => onSelect(cell.key)}
                        onMouseEnter={() => onHover(cell.key)}
                        onMouseLeave={() => onHover(null)}
                        style={{
                          backgroundColor:
                            HEAT_LEVELS[heatLevel(cell.value, grid.levels)],
                          transitionDuration: duration,
                        }}
                        className={`${CELL} cursor-pointer transition-[background-color] data-[selected=true]:ring-1 data-[selected=true]:ring-ring`}
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1 text-[9px] text-muted-foreground">
        <span>{t("usage.heatmap.less")}</span>
        {HEAT_LEVELS.map((color) => (
          <span
            key={color}
            className={CELL}
            style={{ backgroundColor: color }}
          />
        ))}
        <span>{t("usage.heatmap.more")}</span>
      </div>
    </div>
  );
}

/** UTC 解析日粒度的 key，网格与数据用同一套日界，避免本地时区把某天挪格。 */
function dayTime(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

function buildGrid(points: CostPoint[], metric: UsageMetric) {
  const first = points[0];
  const last = points[points.length - 1];
  const levels = heatThresholds(
    points.map((point) => metricValue(point, metric)),
  );
  if (!first || !last) return { columns: [], levels };

  const values = new Map(
    points.map((point) => [point.key, metricValue(point, metric)]),
  );
  const firstTime = dayTime(first.key);
  const lastTime = dayTime(last.key);
  if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime)) {
    return { columns: [], levels };
  }

  const lastWeek = lastTime - new Date(lastTime).getUTCDay() * DAY;
  const firstWeek = firstTime - new Date(firstTime).getUTCDay() * DAY;
  const start = Math.max(firstWeek, lastWeek - (WEEKS - 1) * WEEK);
  const count = Math.round((lastWeek - start) / WEEK) + 1;

  const columns = Array.from({ length: count }, (_, index) => {
    const columnStart = start + index * WEEK;
    let monthStart: Date | null = null;
    const cells: Cell[] = Array.from({ length: 7 }, (_, row) => {
      const time = columnStart + row * DAY;
      const date = new Date(time);
      if (date.getUTCDate() === 1) monthStart = date;
      if (time < firstTime || time > lastTime) return null;
      const key = date.toISOString().slice(0, 10);
      return { key, value: values.get(key) ?? 0 };
    });
    return { start: columnStart, monthStart, cells };
  });

  return { columns, levels };
}
