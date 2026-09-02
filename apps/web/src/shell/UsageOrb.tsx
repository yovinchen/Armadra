import { useState, type CSSProperties } from "react";
import { RefreshCw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Usage,
  UsageProvider,
  UsageWindow,
} from "@ai-coding-canvas/shared";

import { runtimeApi } from "../api/client";
import {
  useT,
  usePreferencesStore,
  type Translate,
} from "../app/preferences-store";
import { formatRelativeTime } from "../lib/format";
import { IconButton } from "@/ui/icon-button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/ui/hover-card";
import { Separator } from "@/ui/separator";

/**
 * 右下角用量球（计划书 §19 + §19.1 修订）。
 *
 * 36px 圆球：外圈 conic-gradient 环表示「各 provider 各窗口里最高的占用」，
 * 球心是那个百分比（10px），没有任何文字标签（§14 第 1 条）。悬停或键盘
 * 聚焦时向左上展开 HoverCard，按 provider 列出每个窗口；触屏没有 hover，
 * 所以点击球体也切换面板。
 *
 * 数据全部来自 Runtime 的缓存快照：`GET /api/usage` 不会触发对外请求，
 * 所以这里 60s 轮询一次也只是读内存。刷新按钮走 `POST /api/usage/refresh`，
 * Runtime 侧 30s 内只真取一次。
 *
 * 三种情况整体不渲染：设置里关掉、Runtime 还没取到、所有 provider 都是
 * `unavailable`（本机没装那个 CLI 或没登录）。错误只表现为一条灰色横线，
 * 不弹 toast、不写字（§19「刷新」+ §14 第 1 条）。
 */

const POLL_INTERVAL = 60_000;

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

/** `5h` / `7d` / `primary` 走 i18n；provider 自定义的标签原样显示。 */
function windowLabel(t: Translate, window: UsageWindow): string {
  const key = `usage.window.${window.label}`;
  const translated = t(key);
  return translated === key ? t(`usage.window.${window.key}`) : translated;
}

function percentText(t: Translate, percent: number): string {
  return t("usage.percent", { value: Math.round(percent) });
}

/** 40×4 的迷你进度条。宽度是数据，颜色是状态，所以两者分开。 */
function UsageBar({ percent }: { percent: number }) {
  return (
    <span
      aria-hidden
      className="block h-1 w-10 shrink-0 overflow-hidden rounded-full bg-border-strong"
    >
      <span
        data-level={level(percent)}
        className="block h-full rounded-full bg-brand data-[level=danger]:bg-danger data-[level=warn]:bg-warn"
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </span>
  );
}

/** 只有 `ok` 与 `error` 上球；`unavailable` 当作这台机器上没有这个 CLI。 */
function visible(usage: Usage | undefined): UsageProvider[] {
  return (usage?.providers ?? []).filter(
    (provider) => provider.status !== "unavailable",
  );
}

/** 环取所有 provider 所有窗口里的最高占用；全是错误时没有数字。 */
function maxPercent(providers: UsageProvider[]): number | null {
  const values = providers
    .filter((provider) => provider.status === "ok")
    .flatMap((provider) => provider.windows.map((w) => w.usedPercent));
  return values.length === 0 ? null : Math.max(...values);
}

/** 球体本身不写字，所以整段摘要塞进 `aria-label`。 */
function summary(t: Translate, providers: UsageProvider[]): string {
  return providers
    .map((provider) => {
      const name = t(`usage.provider.${provider.id}`);
      if (provider.status === "error")
        return `${name} ${t("usage.status.error")}`;
      const windows = provider.windows
        .map((w) => `${windowLabel(t, w)} ${percentText(t, w.usedPercent)}`)
        .join(" ");
      return `${name} ${windows}`;
    })
    .join(" · ");
}

function ProviderDetail({ provider }: { provider: UsageProvider }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="font-medium">{t(`usage.provider.${provider.id}`)}</div>
      {provider.status === "error" ? (
        <div className="text-muted-foreground">{t("usage.status.error")}</div>
      ) : (
        provider.windows.map((window) => (
          <div key={window.key} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-muted-foreground">
                {windowLabel(t, window)}
              </span>
              <UsageBar percent={window.usedPercent} />
              <span className="ml-auto tabular-nums">
                {percentText(t, window.usedPercent)}
              </span>
            </div>
            {window.resetsAt && (
              <div className="pl-16 text-xs text-muted-foreground">
                {t("usage.resetIn", {
                  value: formatRelativeTime(window.resetsAt),
                })}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

export function UsageOrb() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const showUsage = usePreferencesStore((state) => state.showUsage);
  const queryClient = useQueryClient();
  const usage = useQuery({
    queryKey: ["usage"],
    queryFn: () => runtimeApi.usage(),
    refetchInterval: POLL_INTERVAL,
    enabled: showUsage,
  });
  const refresh = useMutation({
    mutationFn: () => runtimeApi.refreshUsage(),
    onSuccess: (next) => queryClient.setQueryData(["usage"], next),
  });

  const providers = visible(usage.data);
  if (!showUsage || providers.length === 0) return null;

  const percent = maxPercent(providers);
  const ringLevel = percent === null ? null : level(percent);

  return (
    <HoverCard
      open={open}
      onOpenChange={setOpen}
      openDelay={120}
      closeDelay={150}
    >
      {/*
        缩略图是 tldraw 的 `NavigationPanel`，`styles/canvas.css` 把它钉在
        右下、底边 44px（给 tldraw 水印让位），宽 200 高 152（150 加 1px 边）。
        球压在它上方 14px：44 + 152 + 14 = 210。
      */}
      <div
        data-slot="usage-orb"
        className="fixed right-[14px] bottom-[210px] z-[var(--z-pills)]"
      >
        <HoverCardTrigger asChild>
          <button
            type="button"
            data-level={ringLevel ?? "none"}
            aria-label={t("usage.orbLabel", { value: summary(t, providers) })}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
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
        </HoverCardTrigger>
      </div>

      <HoverCardContent
        data-slot="usage-panel"
        side="top"
        align="end"
        className="z-[var(--z-menu)] flex w-64 flex-col gap-3"
      >
        {providers.map((provider, index) => (
          <div key={provider.id} className="flex flex-col gap-3">
            {index > 0 && <Separator />}
            <ProviderDetail provider={provider} />
          </div>
        ))}
        <div className="flex justify-end">
          <IconButton
            label={t("usage.refresh")}
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw />
          </IconButton>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
