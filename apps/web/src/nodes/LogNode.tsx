import { useMemo, useState } from "react";
import type { LogEntry } from "@ai-coding-canvas/shared";
import { usePreferences } from "../preferences/Preferences";
import { formatClock } from "./helpers";
import type { NodeContentProps, OfKind } from "./types";

type Filter = "all" | LogEntry["source"];

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "log.filter.all" },
  { id: "agent", label: "log.filter.agent" },
  { id: "terminal", label: "log.filter.terminal" },
  { id: "gateway", label: "log.filter.gateway" },
];

const SOURCE_GLYPH: Record<LogEntry["source"], string> = {
  agent: "✦",
  terminal: ">_",
  gateway: "⇄",
  system: "◈",
};

/** Log body: source filter chips over the structured entries (or raw lines). */
export function LogNode({ data }: NodeContentProps) {
  const { t } = usePreferences();
  const log = data as OfKind<"log">;
  const [filter, setFilter] = useState<Filter>("all");

  const entries = useMemo<LogEntry[]>(() => {
    if (log.entries?.length) return log.entries;
    return log.content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => ({ at: "", source: "system" as const, text: line }));
  }, [log.content, log.entries]);

  const visible = entries.filter(
    (entry) => filter === "all" || entry.source === filter,
  );

  return (
    <div className={`log-body log-body--${log.level} nodrag nowheel`}>
      <div className="log-filters">
        {FILTERS.map((item) => (
          <button
            type="button"
            key={item.id}
            className={`log-filter nodrag${filter === item.id ? " is-active" : ""}`}
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      <div className="log-entries">
        {visible.length === 0 && <p className="log-empty">{t("log.empty")}</p>}
        {visible.map((entry, index) => (
          <div className="log-row" key={`${index}-${entry.at}`}>
            {entry.at && (
              <span className="log-clock">{formatClock(entry.at)}</span>
            )}
            <span className={`log-glyph log-glyph--${entry.source}`}>
              {SOURCE_GLYPH[entry.source]}
            </span>
            <span className="log-text">{entry.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
