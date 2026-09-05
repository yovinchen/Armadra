import * as React from "react";
import {
  ageContextUsage,
  contextLevel,
  contextPercentage,
  DEFAULT_CONTEXT_THRESHOLDS,
  type ContextThresholds,
  type ContextUsage,
} from "@armadra/shared";
import { usePreferencesStore, useT } from "@/app/preferences-store";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

export interface ContextUsageBadgeProps {
  nodeId: string;
  sessionId: string | null;
  generation: number | null;
  usage: ContextUsage | null;
  unavailableReason?: ContextUsage["unknownReason"];
  /** Settings → Agent; the defaults are only a fallback for tests. */
  thresholds?: ContextThresholds;
}

/** Presentation only: callers supply the current session binding and snapshot. */
export function ContextUsageBadge({
  nodeId,
  sessionId,
  generation,
  usage,
  unavailableReason,
  thresholds,
}: ContextUsageBadgeProps) {
  const t = useT();
  const stored = usePreferencesStore((state) => state.contextThresholds);
  const limits = thresholds ?? stored ?? DEFAULT_CONTEXT_THRESHOLDS;
  const [now, setNow] = React.useState(() => performance.now());
  const received = React.useRef({ usage, at: performance.now() });
  if (received.current.usage !== usage)
    received.current = { usage, at: performance.now() };
  React.useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const current =
    usage?.nodeId === nodeId &&
    usage.sessionId === sessionId &&
    usage.generation === generation
      ? ageContextUsage(usage, Math.max(0, now - received.current.at))
      : null;
  const percentage = current ? contextPercentage(current) : null;
  // `null` for an unknown reading: an absent observation is not "normal", and
  // it must not colour the bar or trip a reminder.
  const level = contextLevel(percentage, limits);
  const quality = current?.quality ?? "unknown";
  const unknown = t("context.unknown");
  const value =
    percentage === null
      ? unknown
      : `${quality === "estimated" ? "~" : ""}${Math.round(percentage)}%`;
  const reason =
    current?.unknownReason ?? unavailableReason ?? "awaiting_report";
  const number = (value: number | null | undefined) =>
    value == null ? unknown : value.toLocaleString();
  const details = [
    [t("context.model"), current?.modelId ?? unknown],
    [t("context.session"), sessionId ?? unknown],
    [t("context.providerSession"), current?.providerSessionId ?? unknown],
    [t("context.used"), number(current?.usedTokens)],
    [t("context.capacity"), number(current?.capacityTokens)],
    [t("context.reserved"), number(current?.reservedOutputTokens)],
    [t("context.source"), t(`context.${current?.source ?? "unavailable"}`)],
    [
      t("context.observed"),
      current?.observedAt
        ? new Date(current.observedAt).toLocaleString()
        : unknown,
    ],
    [t("context.generation"), number(generation)],
    [
      t("context.compaction"),
      current && current.source !== "unavailable"
        ? number(current.compactionEpoch)
        : unknown,
    ],
    [t("context.revision"), current?.sourceRevision ?? unknown],
  ];
  if (current?.estimate) {
    details.push([
      t("context.estimator"),
      `${current.estimate.heuristic} · ${t(`context.confidence.${current.estimate.confidence}`)}`,
    ]);
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex min-h-6 min-w-0 max-w-40 items-center gap-1 rounded px-1 text-[length:var(--text-caption)] text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={t("context.badge", { value })}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {current?.modelId && (
            <span className="max-w-16 truncate">{current.modelId}</span>
          )}
          {percentage !== null && (
            <span
              aria-hidden="true"
              className="h-1 w-6 shrink-0 overflow-hidden rounded bg-muted"
            >
              <span
                className={`block h-full ${level === "danger" ? "bg-destructive" : level === "warn" ? "bg-amber-500" : "bg-primary"}`}
                style={{ width: `${Math.min(100, percentage)}%` }}
              />
            </span>
          )}
          <span className="whitespace-nowrap">
            {value}
            {quality === "stale" ? ` · ${t("context.stale")}` : ""}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="max-h-[min(80dvh,36rem)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto text-xs"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h3 className="font-medium">
          {t("context.title")} · {t(`context.${quality}`)}
        </h3>
        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          {details.map(([label, content]) => (
            <React.Fragment key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="m-0 break-words text-right [overflow-wrap:anywhere]">
                {content}
              </dd>
            </React.Fragment>
          ))}
        </dl>
        {quality === "unknown" && <p role="status">{t(`context.${reason}`)}</p>}
        {quality === "unknown" && reason === "awaiting_report" && (
          <p>{t("context.setupNote")}</p>
        )}
        {quality === "estimated" && (
          <>
            <p>{t("context.estimateNote")}</p>
            {current?.estimate && (
              <p className="text-muted-foreground">
                {t("context.estimateDetail", {
                  heuristic: current.estimate.heuristic,
                  confidence: t(
                    `context.confidence.${current.estimate.confidence}`,
                  ),
                  messages: current.estimate.messages,
                })}
              </p>
            )}
            {current?.estimate?.truncated && (
              <p>{t("context.estimateFloor")}</p>
            )}
          </>
        )}
        {quality === "stale" && <p>{t("context.staleNote")}</p>}
        {level === "warn" && (
          <p>{t("context.high", { percent: limits.warnPercent })}</p>
        )}
        {level === "danger" && (
          <p>{t("context.critical", { percent: limits.dangerPercent })}</p>
        )}
        <p className="text-muted-foreground">{t("context.explanation")}</p>
        <p className="text-muted-foreground">{t("context.restartNote")}</p>
      </PopoverContent>
    </Popover>
  );
}
