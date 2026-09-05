/**
 * 额度、用量与成本看板（§4.2）。
 *
 * 从用量球或 Dock 打开。两种形态和资源管理器一致：右侧抽屉，或 pin 成
 * 常驻浮卡。上半是每个 Provider 一张卡，下半是本地成本——30 天日柱状图
 * 加模型分解。
 *
 * 状态显示是这一页的重点：采集时间、过期、错误各自有文字，`unavailable /
 * error / stale` 都不会渲染成 0。
 */
import { useState } from "react";
import { Pin, PinOff, RefreshCw, X } from "lucide-react";

import { useT } from "../app/preferences-store";
import { useCost } from "../app/use-cost";
import { useUsage } from "../app/use-usage";
import { useRuntimeSettings } from "./settings/use-runtime-settings";
import { useCanvasStore } from "../store/canvas-store";
import { formatRelativeTime } from "../lib/format";
import { formatTokens, formatUsd, totalTokens } from "../lib/cost";
import { CostChart } from "./usage/CostChart";
import { ProviderCard } from "./usage/ProviderCard";
import { IconButton } from "../ui/icon-button";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet";

export function UsageDashboard() {
  const mode = useCanvasStore((state) => state.panels.usage);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const t = useT();

  if (mode === "closed") return null;

  const header = (Title: typeof SheetTitle | "h2") => (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
      <Title className="flex-1 truncate text-[13px] font-semibold">
        {t("usage.dashboard.title")}
      </Title>
      <IconButton
        label={
          mode === "pinned"
            ? t("usage.dashboard.unpin")
            : t("usage.dashboard.pin")
        }
        active={mode === "pinned"}
        onClick={() =>
          setPanel("usage", mode === "pinned" ? "drawer" : "pinned")
        }
      >
        {mode === "pinned" ? <PinOff /> : <Pin />}
      </IconButton>
      <IconButton
        label={t("usage.close")}
        onClick={() => setPanel("usage", "closed")}
      >
        <X />
      </IconButton>
    </div>
  );

  const body = (
    <ScrollArea className="min-h-0 flex-1">
      <DashboardBody />
    </ScrollArea>
  );

  if (mode === "pinned") {
    return (
      <aside
        aria-label={t("usage.dashboard.title")}
        className="fixed top-[96px] right-[14px] bottom-[14px] z-[var(--z-cluster)] flex w-[360px] max-w-[calc(100vw-28px)] flex-col overflow-hidden rounded-xl border border-border bg-[color-mix(in_srgb,var(--card)_96%,transparent)] shadow-[var(--shadow-overlay)] backdrop-blur-md"
      >
        {header("h2")}
        {body}
      </aside>
    );
  }

  return (
    <Sheet
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) setPanel("usage", "closed");
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        className="w-[400px] gap-0 p-0 sm:max-w-none"
      >
        {header(SheetTitle)}
        {body}
      </SheetContent>
    </Sheet>
  );
}

function DashboardBody() {
  const t = useT();
  const { settings } = useRuntimeSettings();
  const usageEnabled = settings.data?.usage?.enabled !== false;
  const costEnabled = settings.data?.usage?.cost?.enabled !== false;
  const { usage, refresh, refreshing, now, cooldown } = useUsage(usageEnabled);
  // 设置还没到之前不查成本：Runtime 侧那是一次磁盘扫描，不能凭默认值触发。
  const { cost, refresh: rescan } = useCost(
    Boolean(settings.data) && costEnabled,
  );
  const [selected, setSelected] = useState<string | null>(null);

  const providers = usage.data?.providers ?? [];
  const summary = cost.data;
  const day = summary?.daily.find((entry) => entry.date === selected);
  // 选中某一天就看那天的模型分解，否则看 30 天窗口。
  const breakdown = day ?? summary?.last30Days;

  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {cooldown > 0
            ? t("usage.cooldown", { seconds: cooldown })
            : t("usage.cadence")}
        </span>
        <IconButton
          label={t("usage.refresh")}
          disabled={!usageEnabled || refreshing || cooldown > 0}
          onClick={() => {
            refresh.mutate();
            if (costEnabled) rescan.mutate();
          }}
        >
          <RefreshCw className={refreshing ? "animate-spin" : undefined} />
        </IconButton>
      </div>

      {!usageEnabled ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("usage.paused")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={
                usage.isError ? { ...provider, status: "error" } : provider
              }
              now={now}
            />
          ))}
        </div>
      )}

      <Separator />

      <section
        aria-label={t("usage.cost.title")}
        className="flex flex-col gap-3"
      >
        <h2 className="text-sm font-medium">{t("usage.cost.title")}</h2>
        {!costEnabled || summary?.status === "disabled" ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t("usage.cost.disabled")}
          </p>
        ) : cost.isError ? (
          <p role="status" className="text-xs text-danger">
            {t("usage.cost.error")}
          </p>
        ) : !summary || summary.status === "unavailable" ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t("usage.cost.empty")}
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-2">
              <Total
                label={t("usage.cost.today")}
                tokens={totalTokens(summary.today.tokens)}
                usd={summary.today.costUsd}
                complete={summary.today.complete}
              />
              <Total
                label={t("usage.cost.window")}
                tokens={totalTokens(summary.last30Days.tokens)}
                usd={summary.last30Days.costUsd}
                complete={summary.last30Days.complete}
              />
            </dl>

            {summary.currentSession && (
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
                <span className="text-muted-foreground">
                  {t("usage.cost.session", {
                    value: t(
                      `usage.provider.${summary.currentSession.provider}`,
                    ),
                  })}
                </span>
                <span className="tabular-nums">
                  {formatTokens(totalTokens(summary.currentSession.tokens))} ·{" "}
                  {summary.currentSession.complete
                    ? formatUsd(summary.currentSession.costUsd)
                    : t("usage.cost.unpricedShort")}
                </span>
              </div>
            )}

            <CostChart
              daily={summary.daily}
              selected={selected}
              onSelect={setSelected}
            />

            {breakdown && breakdown.models.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {t("usage.cost.models")}
                </h3>
                {breakdown.models.map((model) => (
                  <div
                    key={model.model}
                    data-slot="cost-model"
                    className="flex items-baseline justify-between gap-3 text-xs"
                  >
                    <span className="min-w-0 truncate" title={model.model}>
                      {model.model}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatTokens(totalTokens(model.tokens))} ·{" "}
                      {model.costUsd === null
                        ? t("usage.cost.unpricedShort")
                        : formatUsd(model.costUsd)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {summary.unpricedModels.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("usage.cost.unpriced", {
                  value: summary.unpricedModels.join(t("usage.cost.separator")),
                })}
              </p>
            )}
            {summary.truncated && (
              <p className="text-xs text-warn">{t("usage.cost.truncated")}</p>
            )}
            {summary.scannedAt && (
              <p className="text-xs text-muted-foreground">
                {t("usage.cost.scannedAt", {
                  value: formatRelativeTime(summary.scannedAt, now),
                })}
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function Total({
  label,
  tokens,
  usd,
  complete,
}: {
  label: string;
  tokens: number;
  usd: number;
  complete: boolean;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-panel p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">
        {complete
          ? formatUsd(usd)
          : t("usage.cost.partial", { value: formatUsd(usd) })}
      </dd>
      <dd className="text-xs tabular-nums text-muted-foreground">
        {t("usage.cost.tokenCount", { value: formatTokens(tokens) })}
      </dd>
    </div>
  );
}
