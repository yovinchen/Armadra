import type { UsageProvider } from "@armadra/shared";

import { useT } from "../../app/preferences-store";
import { formatRelativeTime } from "../../lib/format";
import { paceDelta } from "../../lib/cost";
import {
  usageIsStale,
  usagePercent,
  usageResetLabel,
  usageWindowLabel,
} from "../../lib/usage";

/**
 * 用量看板里的 Provider 卡（§4.2）。
 *
 * 和用量球共用 `lib/usage` 的判定，但多三件事：pace（按时间推算的预期
 * 用量）、credits 余额、以及数字是否来自本地 CLI 回退。
 *
 * `unavailable / error / stale` 一律显示状态文字，不显示 0。
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

  return (
    <section
      data-slot="usage-provider-card"
      data-provider={provider.id}
      aria-label={name}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-panel p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{name}</span>
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
