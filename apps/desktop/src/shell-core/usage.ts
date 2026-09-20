/**
 * What the tray menu says about usage, computed from the core's answers.
 *
 * Pure: strings in, lines out. `main/tray.ts` fetches and redraws; this
 * decides the words. The rule that matters is in `traySummary`: a poll that
 * fails keeps the previous reading, so the menu never flips to "no data"
 * because one request timed out.
 */

export const FLOOR_MS = 300_000;
export const CEILING_MS = 60_000;

export interface TrayStrings {
  /** Provider display names by id; an id not in here is shown as-is. */
  readonly provider: (id: string) => string;
  /** Reason codes (`expired_credentials`, `network`, …) → one short sentence. */
  readonly reason: (code: string) => string;
  readonly signedOut: string;
  readonly noData: string;
  readonly costToday: string;
}

export interface TraySummary {
  /** One per provider, in the core's order. */
  readonly providers: readonly string[];
  /** Today's local cost, when the scan is on and has run. */
  readonly cost?: string;
}

interface UsageWindow {
  readonly label?: unknown;
  readonly usedPercent?: unknown;
  readonly unlimited?: unknown;
}

interface Provider {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly reason?: unknown;
  readonly windows?: unknown;
}

function windowText(window: UsageWindow): string | undefined {
  if (window.unlimited === true) return undefined;
  if (
    typeof window.label !== "string" ||
    typeof window.usedPercent !== "number"
  )
    return undefined;
  const percent = Math.round(Math.min(100, Math.max(0, window.usedPercent)));
  return `${window.label} ${percent}%`;
}

function providerLine(
  provider: Provider,
  strings: TrayStrings,
): string | undefined {
  if (typeof provider.id !== "string") return undefined;
  const name = strings.provider(provider.id);
  switch (provider.status) {
    case "ok": {
      const windows = Array.isArray(provider.windows)
        ? (provider.windows as UsageWindow[]).map(windowText).filter(Boolean)
        : [];
      return windows.length > 0
        ? `${name} · ${windows.join(" · ")}`
        : `${name} · ${strings.noData}`;
    }
    case "error":
      return `${name} · ${strings.reason(String(provider.reason ?? "provider_error"))}`;
    default:
      return `${name} · ${strings.signedOut}`;
  }
}

/** Lines from `GET /api/usage`; `undefined` when the body is not a snapshot. */
export function providerLines(
  body: string,
  strings: TrayStrings,
): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const providers = (parsed as { providers?: unknown })?.providers;
  if (!Array.isArray(providers)) return undefined;
  return providers
    .map((provider) => providerLine(provider as Provider, strings))
    .filter((line): line is string => line !== undefined);
}

/** The cost line from `GET /api/usage/cost`; `undefined` when off or unscanned. */
export function costLine(
  body: string,
  strings: TrayStrings,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const summary = parsed as { status?: unknown; today?: { costUsd?: unknown } };
  if (summary?.status !== "ok") return undefined;
  const cost = summary.today?.costUsd;
  if (typeof cost !== "number" || !Number.isFinite(cost)) return undefined;
  return `${strings.costToday} $${cost.toFixed(2)}`;
}

/**
 * Merges one poll into the previous summary: a part that did not arrive keeps
 * its last value, so the menu degrades to "stale" rather than to "unknown".
 */
export function traySummary(
  previous: TraySummary | null,
  answers: { usage: string | null; cost: string | null },
  strings: TrayStrings,
): TraySummary | null {
  const providers =
    answers.usage === null ? undefined : providerLines(answers.usage, strings);
  const cost =
    answers.cost === null ? undefined : costLine(answers.cost, strings);
  if (providers === undefined && cost === undefined) return previous;
  return {
    providers: providers ?? previous?.providers ?? [],
    ...(cost !== undefined
      ? { cost }
      : previous?.cost !== undefined
        ? { cost: previous.cost }
        : {}),
  };
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
 * have it — an older core, a hand-edited file — is `null`, which is the floor,
 * not zero.
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
