import type { UsageProvider, UsageWindow } from "@armadra/shared";
import type { Translate } from "../app/preferences-store";
import { formatRelativeTime } from "./format";

export function usageWindowLabel(t: Translate, window: UsageWindow): string {
  const key = `usage.window.${window.label}`;
  const translated = t(key);
  const label = translated === key ? window.label : translated;
  return window.group ? `${window.group} · ${label}` : label;
}

export function usageIsStale(provider: UsageProvider, now: number): boolean {
  const at = Date.parse(provider.fetchedAt ?? "");
  return !Number.isFinite(at) || now - at > 10 * 60_000;
}

export function usageWindowExpired(window: UsageWindow, now: number): boolean {
  return window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
}

export function usagePercent(
  provider: UsageProvider,
  window: UsageWindow,
  now: number,
): number | null {
  if (
    provider.status !== "ok" ||
    usageIsStale(provider, now) ||
    usageWindowExpired(window, now)
  )
    return null;
  return Number.isFinite(window.usedPercent)
    ? Math.min(100, Math.max(0, window.usedPercent))
    : null;
}

export function usageResetLabel(
  t: Translate,
  window: UsageWindow,
  now: number,
): string {
  if (!window.resetsAt || !Number.isFinite(Date.parse(window.resetsAt)))
    return t("usage.resetUnknown");
  if (usageWindowExpired(window, now)) return t("usage.awaitingRefresh");
  return t("usage.resetIn", {
    value: formatRelativeTime(window.resetsAt, now),
  });
}

/** 前端能说清楚的原因代码；Runtime 的 `UsageFailure`（`usage/mod.rs`）。 */
const USAGE_REASONS: ReadonlySet<string> = new Set([
  "expired_credentials",
  "unreadable_credentials",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "provider_error",
  "network",
  "parse",
  "no_windows",
]);

/**
 * `status: "error"` 那一行的 i18n 键。一个 Runtime 新加的、前端还不认识的
 * 代码按通用原因显示，而不是把代码原样打在界面上。
 */
export function usageReasonKey(reason: string | undefined): string {
  const known = reason !== undefined && USAGE_REASONS.has(reason);
  return `usage.reason.${known ? reason : "provider_error"}`;
}
