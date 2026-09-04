import type { UsageProvider } from "@armadra/shared";
import { useT } from "../app/preferences-store";
import { formatRelativeTime } from "../lib/format";
import {
  usageIsStale,
  usagePercent,
  usageResetLabel,
  usageWindowLabel,
} from "../lib/usage";

/** One consistent quota presentation for the canvas and account settings. */
export function ProviderDetail({
  provider,
  now,
  showCredentialSource = false,
}: {
  provider: UsageProvider;
  now: number;
  showCredentialSource?: boolean;
}) {
  const t = useT();
  const fetchedAt = Date.parse(provider.fetchedAt ?? "");
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-sm font-medium">
            {t(`usage.provider.${provider.id}`)}
          </span>
          {Number.isFinite(fetchedAt) && (
            <time
              dateTime={provider.fetchedAt!}
              className="text-xs text-muted-foreground"
              title={new Date(fetchedAt).toLocaleString()}
            >
              {t("usage.updated", {
                value: formatRelativeTime(fetchedAt, now),
              })}
            </time>
          )}
        </div>
        {showCredentialSource &&
          provider.credentialSource &&
          provider.credentialSource !== "none" && (
            <span className="text-xs text-muted-foreground">
              {t("settings.credentialSource")} ·{" "}
              {t(`settings.credential.${provider.credentialSource}`)}
            </span>
          )}
      </div>
      {provider.status !== "ok" ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(
            provider.status === "error"
              ? "usage.status.error"
              : "usage.status.unavailable",
          )}
          {provider.status === "error" && (
            <span className="block">{t("usage.recoveryHint")}</span>
          )}
        </p>
      ) : (
        <>
          {usageIsStale(provider, now) && (
            <p className="text-xs text-warn">{t("usage.stale")}</p>
          )}
          {provider.windows.map((window) => {
            const percent = usagePercent(provider, window, now);
            const name = usageWindowLabel(t, window);
            const resetAt = Date.parse(window.resetsAt ?? "");
            return (
              <div key={window.key} className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 break-words text-muted-foreground">
                    {name}
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">
                    {percent === null
                      ? "—"
                      : t("usage.used", { value: Math.round(percent) })}
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-label={`${t(`usage.provider.${provider.id}`)} · ${name}`}
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
                <span
                  className="text-xs text-muted-foreground"
                  title={
                    Number.isFinite(resetAt)
                      ? new Date(resetAt).toLocaleString()
                      : undefined
                  }
                >
                  {usageResetLabel(t, window, now)}
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
