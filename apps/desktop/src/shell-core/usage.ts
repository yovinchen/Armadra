/**
 * The tray usage strip — roadmap §3.9「托盘迷你条」, ported from
 * the Rust shell's 合并前的实现 with one change: the wording is no longer here.
 *
 * Two disabled menu items above the tray's actions: the most pressed session
 * window and the most pressed week window, each a short bar plus a percentage.
 * The numbers come from the Runtime's `GET /api/usage/mini`, which is a read of
 * a cache the Runtime already keeps; the tray never causes an upstream quota
 * request of its own.
 *
 * The rule that matters here is the one from the design: **unknown is not
 * zero**. A provider that has not answered, is disabled, or has no window of
 * that length produces no bar at all, and the strip says so in words rather
 * than drawing an empty bar that reads as "0% used".
 *
 * The Rust version carried its own two-language table because the Rust shell
 * had no message catalogue. This one takes the three words it needs as an
 * argument; `main/tray.ts` gets them from `apps/web/src/i18n/desktop.ts`
 * (migration design §2.3).
 */

/** How wide the bar is, in characters. A tray menu is a proportional font, so
 * this is a rough gauge, not a measurement — hence the percentage next to it. */
export const CELLS = 10;

/** The floor for the poll interval, in milliseconds. `usage.refreshMinutes: 0`
 * means the user asked the Runtime not to fetch on a schedule; the tray still
 * re-reads the cache occasionally so a manual refresh shows up, which costs
 * nothing upstream. */
export const FLOOR_MS = 300_000;
/** Never poll faster than this, whatever the setting says. */
export const CEILING_MS = 60_000;

/** One bar of `GET /api/usage/mini`. */
export interface MiniBar {
  readonly provider: string;
  readonly label: string;
  readonly usedPercent: number;
}

export interface MiniUsage {
  readonly session?: MiniBar | null;
  readonly week?: MiniBar | null;
}

/** The three words the strip needs, in the window's locale. */
export interface UsageStrings {
  readonly session: string;
  readonly week: string;
  readonly unknown: string;
}

function isBar(value: unknown): value is MiniBar {
  if (typeof value !== "object" || value === null) return false;
  const bar = value as Record<string, unknown>;
  return (
    typeof bar.provider === "string" &&
    typeof bar.label === "string" &&
    typeof bar.usedPercent === "number" &&
    Number.isFinite(bar.usedPercent)
  );
}

/** `▮▮▮▯▯▯▯▯▯▯`. Clamped, because a provider that reports over 100% has still
 * only filled the bar once. */
export function bar(percent: number): string {
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.min(CELLS, Math.round((clamped / 100) * CELLS));
  return "▮".repeat(filled) + "▯".repeat(CELLS - filled);
}

/** One menu line. A missing window is rendered as the word for "unknown",
 * never as a full-width empty bar, which a reader would take for 0% used. */
export function usageLine(
  row: string,
  unknown: string,
  value: MiniBar | null | undefined,
): string {
  if (!value) return `${row}  ${unknown}`;
  const percent = Math.min(100, Math.max(0, value.usedPercent));
  return `${row}  ${bar(value.usedPercent)}  ${Math.round(percent)}%  ${
    value.provider
  }·${value.label}`;
}

/** Both lines, in menu order. */
export function usageLines(
  strings: UsageStrings,
  usage: MiniUsage | null | undefined,
): [string, string] {
  return [
    usageLine(strings.session, strings.unknown, usage?.session),
    usageLine(strings.week, strings.unknown, usage?.week),
  ];
}

/**
 * The poll interval for `usage.refreshMinutes`, in milliseconds.
 *
 * The tray reads a cache, so following the setting is about not looking stale
 * rather than about rate limiting; `0` (manual only) still gets the floor.
 */
export function pollIntervalMs(refreshMinutes: number | null): number {
  if (refreshMinutes !== null && refreshMinutes > 0)
    return Math.max(CEILING_MS, refreshMinutes * 60_000);
  return FLOOR_MS;
}

/**
 * `usage.refreshMinutes` out of `GET /api/settings`. A document that does not
 * have it — an older Runtime, a hand-edited file — is `null`, which is the
 * floor, not zero.
 */
export function refreshMinutes(settings: string): number | null {
  try {
    const parsed = JSON.parse(settings) as Record<string, unknown>;
    const usage = parsed?.usage as Record<string, unknown> | undefined;
    const minutes = usage?.refreshMinutes;
    return typeof minutes === "number" &&
      Number.isFinite(minutes) &&
      minutes >= 0
      ? Math.floor(minutes)
      : null;
  } catch {
    return null;
  }
}

/** `GET /api/usage/mini`. An unreadable body is `null` — which the caller keeps
 * the previous reading for, rather than redrawing the strip as two unknowns. */
export function parseMiniUsage(body: string): MiniUsage | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      session: isBar(parsed.session) ? parsed.session : null,
      week: isBar(parsed.week) ? parsed.week : null,
    };
  } catch {
    return null;
  }
}
