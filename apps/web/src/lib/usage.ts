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
