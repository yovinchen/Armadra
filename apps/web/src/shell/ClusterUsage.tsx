import type { CSSProperties } from "react";
import { Gauge } from "lucide-react";
import type { Usage, UsageProvider } from "@armadra/shared";

import { useUsage } from "../app/use-usage";
import {
  usePreferencesStore,
  useT,
  type Translate,
} from "../app/preferences-store";
import {
  usagePercent,
  usageReasonKey,
  usageWindowLabel as windowLabel,
} from "../lib/usage";
import { useCanvasStore } from "../store/canvas-store";
import { useCompactLayout } from "../platform/layout";
import { IconButton } from "@/ui/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

/**
 * Dock 右端的用量指示（用户实测反馈 F9）。
 *
 * 以前它是右下角一个独立的浮层（`shell/UsageOrb.tsx`），悬停展开一整块面板。
 * 用户的意见是「并入底部 Dock」：画布右下角本来就已经有缩略图和归属链接，
 * 再摆一个球就是第三层浮层。现在它是 Dock 里的一格——环形 + 百分比，点一下
 * 开用量面板（`panels/UsageDashboard.tsx`），那里有每个 provider 的明细与
 * 刷新按钮，不必再为一次悬停维护一份缩略版面板。
 *
 * 关掉「显示用量」或者这台机器上一个 provider 都没有时，这一格退回一个普通
 * 的仪表图标：面板本身仍然要够得到（里面可以重新打开轮询），但不画一个
 * 永远是 `—` 的环。
 */

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

/** 只有 `ok` 与 `error` 上环；`unavailable` 当作这台机器上没有这个 CLI。 */
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

/** 环上只有一个数字，所以整段摘要塞进 `aria-label` 与悬停提示。 */
function summary(
  t: Translate,
  providers: UsageProvider[],
  now: number,
): string {
  return providers
    .map((provider) => {
      const name = t(`usage.provider.${provider.id}`);
      if (provider.status === "error")
        return `${name} ${t("usage.status.error")} · ${t(
          usageReasonKey(provider.reason),
          { provider: name },
        )}`;
      const windows = provider.windows
        .map(
          (w) =>
            `${windowLabel(t, w)} ${
              usagePercent(provider, w, now) === null
                ? t("usage.awaitingRefresh")
                : t("usage.percent", { value: Math.round(w.usedPercent) })
            }`,
        )
        .join(" ");
      return `${name} ${windows}`;
    })
    .join(" · ");
}

/**
 * The quota ring, in the right-hand cluster under "resources": the dock is
 * for editing the canvas, the cluster is for the panels, and this opens a
 * panel. Same 28px footprint as the cluster's icon buttons.
 */
export function ClusterUsage() {
  const t = useT();
  const compact = useCompactLayout();
  const usagePanel = useCanvasStore((state) => state.panels.usage);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const showUsage = usePreferencesStore((state) => state.showUsage);
  const { usage, now } = useUsage(showUsage);

  const providers = visible(usage.data).map((provider) =>
    usage.isError ? { ...provider, status: "error" as const } : provider,
  );
  const open = () =>
    setPanel("usage", usagePanel === "closed" ? "drawer" : "closed");

  /*
   * 手机上只画图标：底部导航已经占掉一条，Dock 在 390px 宽里要放下新建、
   * 撤销、重做、整理、用量、工具与缩放，一个带百分比的环会把工具按钮挤出去。
   * 「要不要看用量」仍然是同一个偏好（设置 → 通用），它记在本机。
   */
  if (!showUsage || providers.length === 0 || compact) {
    return (
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <IconButton
            size="cluster"
            label={t("usage.dashboard.open")}
            active={usagePanel !== "closed"}
            onClick={open}
          >
            <Gauge />
          </IconButton>
        </TooltipTrigger>
        <TooltipContent side="left">{t("usage.dashboard.open")}</TooltipContent>
      </Tooltip>
    );
  }

  const percent = maxPercent(providers, now);
  const ringLevel = percent === null ? null : level(percent);
  const detail = summary(t, providers, now);

  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-slot="cluster-usage"
          data-level={ringLevel ?? "none"}
          aria-label={t("usage.dockLabel", { value: detail })}
          aria-pressed={usagePanel !== "closed"}
          onClick={open}
          className="grid size-7 shrink-0 place-items-center rounded-full p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
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
          <span className="grid size-[22px] place-items-center rounded-full bg-panel text-[10px] leading-none font-medium tabular-nums text-foreground">
            {percent === null ? "—" : Math.round(percent)}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{detail}</TooltipContent>
    </Tooltip>
  );
}
