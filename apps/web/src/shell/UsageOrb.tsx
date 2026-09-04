import { useEffect, useRef, useState, type CSSProperties } from "react";
import { RefreshCw, X } from "lucide-react";
import { useUsage } from "../app/use-usage";
import { usagePercent, usageWindowLabel as windowLabel } from "../lib/usage";
import type { Usage, UsageProvider } from "@armadra/shared";

import {
  useT,
  usePreferencesStore,
  type Translate,
} from "../app/preferences-store";
import { ProviderDetail } from "./ProviderDetail";
import { IconButton } from "@/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Separator } from "@/ui/separator";

/** 用量球与缩略图共享导航区，显示当前有效窗口中的最高已用比例。 */

type Level = "normal" | "warn" | "danger";

/** 阈值来自 §19：≥80% 警告色，≥95% 危险色。 */
function level(percent: number): Level {
  if (percent >= 95) return "danger";
  if (percent >= 80) return "warn";
  return "normal";
}

const RING_COLOR: Record<Level, string> = {
  normal: "var(--brand)",
  warn: "var(--warn)",
  danger: "var(--danger)",
};

function percentText(t: Translate, percent: number): string {
  return t("usage.percent", { value: Math.round(percent) });
}

/** 只有 `ok` 与 `error` 上球；`unavailable` 当作这台机器上没有这个 CLI。 */
function visible(usage: Usage | undefined): UsageProvider[] {
  return (usage?.providers ?? []).filter(
    (provider) => provider.status !== "unavailable",
  );
}

/** 环取所有 provider 所有窗口里的最高占用；全是错误时没有数字。 */
function maxPercent(providers: UsageProvider[], now: number): number | null {
  const values = providers
    .filter((provider) => provider.status === "ok")
    .flatMap((provider) =>
      provider.windows.map((w) => usagePercent(provider, w, now)),
    )
    .filter((value): value is number => value !== null);
  return values.length === 0 ? null : Math.max(...values);
}

/** 球体本身不写字，所以整段摘要塞进 `aria-label`。 */
function summary(
  t: Translate,
  providers: UsageProvider[],
  now: number,
): string {
  return providers
    .map((provider) => {
      const name = t(`usage.provider.${provider.id}`);
      if (provider.status === "error")
        return `${name} ${t("usage.status.error")}`;
      const windows = provider.windows
        .map(
          (w) =>
            `${windowLabel(t, w)} ${usagePercent(provider, w, now) === null ? t("usage.awaitingRefresh") : percentText(t, w.usedPercent)}`,
        )
        .join(" ");
      return `${name} ${windows}`;
    })
    .join(" · ");
}

export function UsageOrb() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const clearHoverTimer = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );
  const preview = (pointerType: string) => {
    if (pointerType === "touch") return;
    clearHoverTimer();
    if (!open)
      hoverTimer.current = setTimeout(() => {
        pinned.current = false;
        setOpen(true);
      }, 120);
  };
  const leavePreview = () => {
    clearHoverTimer();
    if (!pinned.current)
      hoverTimer.current = setTimeout(() => {
        if (!panelRef.current?.contains(document.activeElement)) setOpen(false);
      }, 180);
  };
  const showUsage = usePreferencesStore((state) => state.showUsage);
  const { usage, refresh, refreshing, refreshFailed, now, cooldown } =
    useUsage(showUsage);

  const providers = visible(usage.data).map((provider) =>
    usage.isError ? { ...provider, status: "error" as const } : provider,
  );
  if (!showUsage || providers.length === 0) return null;

  const percent = maxPercent(providers, now);
  const ringLevel = percent === null ? null : level(percent);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        clearHoverTimer();
        if (next) pinned.current = true;
        setOpen(next);
      }}
    >
      <div
        data-slot="usage-orb"
        className="canvas-usage-orb z-[var(--z-pills)]"
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            data-level={ringLevel ?? "none"}
            aria-label={t("usage.orbLabel", {
              value: summary(t, providers, now),
            })}
            aria-expanded={open}
            onPointerEnter={(event) => preview(event.pointerType)}
            onPointerLeave={leavePreview}
            onClick={(event) => {
              clearHoverTimer();
              if (open && !pinned.current) {
                // A click commits an already visible hover preview. Letting
                // the primitive toggle here would immediately close it.
                event.preventDefault();
                pinned.current = true;
                panelRef.current
                  ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
                  ?.focus();
              }
            }}
            className="grid size-9 place-items-center rounded-full p-0 shadow-[var(--shadow-pill)] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            style={
              {
                "--pct": percent ?? 0,
                "--ring-color": ringLevel
                  ? RING_COLOR[ringLevel]
                  : "var(--border-strong)",
                background:
                  "conic-gradient(var(--ring-color) calc(var(--pct) * 1%), var(--surface-raised) 0)",
              } as CSSProperties
            }
          >
            <span className="grid size-7 place-items-center rounded-full bg-panel text-[length:var(--text-caption)] leading-none font-medium tabular-nums text-foreground">
              {percent === null ? "—" : percentText(t, percent)}
            </span>
          </button>
        </PopoverTrigger>
      </div>

      <PopoverContent
        ref={panelRef}
        data-slot="usage-panel"
        aria-label={t("usage.label")}
        side="top"
        align="end"
        collisionPadding={12}
        onPointerEnter={clearHoverTimer}
        onPointerLeave={leavePreview}
        onFocusCapture={() => {
          // Interacting inside a preview commits it too, so Escape restores
          // focus even when the user clicked Refresh directly after hovering.
          pinned.current = true;
          clearHoverTimer();
        }}
        onOpenAutoFocus={(event) => {
          if (!pinned.current) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          if (!pinned.current) event.preventDefault();
          pinned.current = false;
        }}
        className="z-[var(--z-menu)] flex w-72 max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] flex-col gap-3 overflow-y-auto"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{t("usage.label")}</h2>
          <IconButton label={t("usage.close")} onClick={() => setOpen(false)}>
            <X />
          </IconButton>
        </div>
        <div className="text-xs text-muted-foreground">
          {t("usage.summaryHint")}
        </div>
        {providers.map((provider, index) => (
          <div key={provider.id} className="flex flex-col gap-3">
            {index > 0 && <Separator />}
            <ProviderDetail provider={provider} now={now} />
          </div>
        ))}
        {(refreshFailed || usage.isError) && (
          <div role="status" className="text-xs text-danger">
            {t("usage.refreshError")}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {cooldown > 0
              ? t("usage.cooldown", { seconds: cooldown })
              : t("usage.cadence")}
          </span>
          <IconButton
            label={t("usage.refresh")}
            disabled={refreshing || cooldown > 0}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          </IconButton>
        </div>
      </PopoverContent>
    </Popover>
  );
}
