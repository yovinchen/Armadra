import type { UsageProvider } from "@armadra/shared";

import { useT } from "../../app/preferences-store";
import { formatRelativeTime } from "../../lib/format";
import { paceDelta } from "../../lib/cost";
import {
  usageIsStale,
  usagePercent,
  usageReasonKey,
  usageResetLabel,
  usageWindowLabel,
} from "../../lib/usage";
import { Badge } from "@/ui/badge";
import { useProviderIncident } from "./provider-status";

/**
 * 用量看板里的 Provider 卡（§4.2）。
 *
 * 和用量球共用 `lib/usage` 的判定，但多三件事：pace（按时间推算的预期
 * 用量）、credits 余额、以及数字是否来自本地 CLI 回退。
 *
 * `unavailable / error / stale` 一律显示状态文字，不显示 0；`error` 再补一句
 * 原因（登录过期、连不上、401 …），与画布弹层 `shell/ProviderDetail` 同一套键。
 */
export function ProviderCard({
  provider,
  now,
}: {
  provider: UsageProvider;
  now: number;
}) {
  const t = useT();
  const name = t(`usage.provider.${provider.id}`);
  const fetchedAt = Date.parse(provider.fetchedAt ?? "");
  const stale = provider.status === "ok" && usageIsStale(provider, now);
  const incident = useProviderIncident(provider.id);

  return (
    <section
      data-slot="usage-provider-card"
      data-provider={provider.id}
      aria-label={name}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-panel p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          {/* 状态页报了故障或维护才出现；原文（英文）只放在悬停提示里。 */}
          {incident && (
            <Badge
              data-slot="usage-incident"
              data-indicator={incident.indicator}
              variant={
                incident.indicator === "maintenance"
                  ? "secondary"
                  : "destructive"
              }
              title={incident.description}
            >
              {t(`usage.incident.${incident.indicator}`)}
            </Badge>
          )}
        </span>
        {provider.status === "ok" && Number.isFinite(fetchedAt) && (
          <time
            dateTime={provider.fetchedAt!}
            title={new Date(fetchedAt).toLocaleString()}
            className="text-xs text-muted-foreground"
          >
            {t("usage.updated", { value: formatRelativeTime(fetchedAt, now) })}
          </time>
        )}
      </div>

      {provider.status !== "ok" ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(
            provider.status === "error"
              ? "usage.status.error"
              : "usage.status.unavailable",
          )}
          {/* 原因代码来自 Runtime（`reason`）；没有的按通用原因说。 */}
          {provider.status === "error" && (
            <span className="block">
              {t(usageReasonKey(provider.reason), { provider: name })}
            </span>
          )}
          {/*
            「没有凭据」也要说怎么办。`error` 那一行有原因句，
            `unavailable` 过去只有一句陈述，而登录入口恰好不在这块面板里：
            Copilot 在设置页，其余在各自的 CLI。
          */}
          {provider.status !== "error" && (
            <span className="block">
              {t(
                provider.id === "copilot"
                  ? "usage.status.unavailableHint.copilot"
                  : "usage.status.unavailableHint",
                { provider: name },
              )}
            </span>
          )}
        </p>
      ) : (
        <>
          {stale && <p className="text-xs text-warn">{t("usage.stale")}</p>}
          {provider.viaCli && (
            <p className="text-xs text-muted-foreground">{t("usage.viaCli")}</p>
          )}
          {provider.credits && (
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-muted-foreground">
                {t("usage.credits")}
              </span>
              <span className="font-medium tabular-nums">
                {provider.credits.balance.toFixed(2)}
              </span>
            </div>
          )}
          {provider.windows.map((window) => {
            const percent = usagePercent(provider, window, now);
            const label = usageWindowLabel(t, window);
            const pace = window.unlimited ? null : paceDelta(window, now);
            return (
              <div key={window.key} className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 break-words text-muted-foreground">
                    {label}
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">
                    {window.unlimited
                      ? t("usage.unlimited")
                      : percent === null
                        ? "—"
                        : t("usage.used", { value: Math.round(percent) })}
                  </span>
                </div>
                {!window.unlimited && (
                  <div
                    role="progressbar"
                    aria-label={`${name} · ${label}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent ?? undefined}
                    aria-valuetext={
                      percent === null
                        ? t("usage.stale")
                        : t("usage.used", { value: Math.round(percent) })
                    }
                    className="h-1 w-full overflow-hidden rounded-full bg-border"
                  >
                    {percent !== null && (
                      <div
                        data-level={
                          percent >= 95
                            ? "danger"
                            : percent >= 80
                              ? "warn"
                              : "normal"
                        }
                        className="h-full rounded-full bg-brand data-[level=danger]:bg-danger data-[level=warn]:bg-warn"
                        style={{ width: `${percent}%` }}
                      />
                    )}
                  </div>
                )}
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground">
                  <span>
                    {window.unlimited
                      ? t("usage.resetUnknown")
                      : usageResetLabel(t, window, now)}
                  </span>
                  {pace !== null && percent !== null && (
                    <span
                      data-slot="usage-pace"
                      data-ahead={pace > 0 || undefined}
                      className="tabular-nums data-[ahead]:text-warn"
                    >
                      {t(pace > 0 ? "usage.paceAhead" : "usage.paceBehind", {
                        value: Math.abs(pace),
                      })}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
