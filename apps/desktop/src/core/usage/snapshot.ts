/**
 * The usage snapshot and the two bars the tray strip reads.
 *
 * Ported from the shape half of `apps/runtime/src/usage/mod.rs`. What is *not*
 * here is the fetching: the three provider modules read a CLI's stored
 * credentials and call a quota endpoint, and that — along with the cost scan
 * and the Copilot device flow — is the usage domain's own phase.
 *
 * What this batch owes is the contract, and the contract's most important case
 * is the one with no data in it. Three rules from the Rust module apply
 * verbatim and are the reason this file exists at all:
 *
 *  1. **Tokens never leave the module that read them.** Nothing here holds,
 *     caches or serialises a credential; a provider reports only *where* its
 *     token was found (`keychain` / `file` / `none`).
 *  2. **Only percentages and reset times reach the API.** The upstream payloads
 *     carry account ids, e-mail addresses and plan names; none of that is
 *     mapped into a snapshot.
 *  3. **A failure carries a reason code, never a message.** A user who sees
 *     「取不到用量」and nothing else cannot tell an expired sign-in from a proxy
 *     problem. `unavailable` with no reason means "no credentials on this
 *     machine", which is a different thing again and is what an empty snapshot
 *     reports.
 */

/** Every provider the core has a module for, in the order the snapshot lists them. */
export const USAGE_PROVIDER_IDS = ["claude", "codex", "copilot"] as const;

export type UsageProviderId = (typeof USAGE_PROVIDER_IDS)[number];

export type UsageStatus = "ok" | "unavailable" | "error";

/** Where a provider's token was found. Only the *location* is ever reported. */
export type CredentialSource = "keychain" | "file" | "none";

/** Why a provider is `error`, as a code. Nothing here names an account or a URL. */
export type UsageFailure =
  | "expired_credentials"
  | "unreadable_credentials"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "provider_error"
  | "network"
  | "parse"
  | "no_windows";

/**
 * One rate-limit window. `label` is a unit abbreviation (`5h`, `7d`), not
 * prose: the web maps it through i18n and falls back to it verbatim.
 */
export interface UsageWindow {
  readonly key: string;
  readonly label: string;
  readonly group?: string;
  /** 0–100, already rounded to one decimal by the provider module. */
  readonly usedPercent: number;
  /**
   * A bucket with no ceiling. `usedPercent` is 0 and means nothing; the UI
   * prints 无限制 rather than an empty bar.
   */
  readonly unlimited?: boolean;
  /** RFC 3339, or `null` when the provider does not say. */
  readonly resetsAt: string | null;
}

export interface UsageCredits {
  readonly balance: number;
}

export interface ProviderUsage {
  readonly id: UsageProviderId;
  readonly status: UsageStatus;
  /** Only with `status: "error"`. */
  readonly reason?: UsageFailure;
  readonly credentialSource: CredentialSource;
  readonly windows: readonly UsageWindow[];
  readonly credits?: UsageCredits;
  readonly viaCli?: boolean;
  readonly fetchedAt: string | null;
}

export interface UsageSnapshot {
  readonly providers: readonly ProviderUsage[];
  readonly refreshAvailableAt: string | null;
}

function unavailable(id: UsageProviderId): ProviderUsage {
  return {
    id,
    status: "unavailable",
    credentialSource: "none",
    windows: [],
    fetchedAt: null,
  };
}

/**
 * What the API answers before the first fetch, and whenever `usage.enabled` is
 * off: every provider `unavailable`, which is exactly the state in which the
 * pill does not render.
 */
export function emptySnapshot(): UsageSnapshot {
  return {
    providers: USAGE_PROVIDER_IDS.map(unavailable),
    refreshAvailableAt: null,
  };
}

/** One bar of the tray strip. */
export interface MiniBar {
  /** The provider the number came from, so the tray can label it. */
  readonly provider: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
}

/**
 * The two bars a tray strip shows: the most pressed short (session) window and
 * the most pressed long (week) window across every provider that answered.
 *
 * Kept deliberately small and separate from the snapshot so a shell can render
 * the strip without understanding the whole payload.
 */
export interface MiniUsage {
  /** Windows of a day or less. */
  readonly session: MiniBar | null;
  /** Windows longer than a day. */
  readonly week: MiniBar | null;
  readonly fetchedAt: string | null;
}

/**
 * `"5h"` → 5, `"7d"` → 168. Anything else (`quota`, `primary`) has no duration
 * and is left out of the strip rather than guessed at.
 */
export function labelHours(label: string): number | undefined {
  if (label.length < 2) return undefined;
  const unit = label.slice(-1);
  const head = label.slice(0, -1);
  if (!/^[0-9]+$/.test(head)) return undefined;
  const value = Number.parseInt(head, 10);
  if (!Number.isSafeInteger(value)) return undefined;
  if (unit === "h") return value;
  if (unit === "d") return value * 24;
  // A minute-scale window is still a session window; its exact length does not
  // change which of the two bars it belongs in.
  if (unit === "m") return 1;
  return undefined;
}

/** `GET /api/usage/mini`, derived from whatever the snapshot holds. */
export function miniUsage(snapshot: UsageSnapshot): MiniUsage {
  let session: MiniBar | null = null;
  let week: MiniBar | null = null;
  let fetchedAt: string | null = null;
  for (const provider of snapshot.providers) {
    if (provider.status !== "ok") continue;
    if (provider.fetchedAt !== null && fetchedAt === null) {
      fetchedAt = provider.fetchedAt;
    }
    for (const window of provider.windows) {
      // An unlimited bucket has no pressure to report, and a window with no
      // readable size cannot be sorted into either bar.
      if (window.unlimited === true) continue;
      const hours = labelHours(window.label);
      if (hours === undefined) continue;
      const bar: MiniBar = {
        provider: provider.id,
        label: window.label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
      };
      if (hours <= 24) {
        if (session === null || window.usedPercent > session.usedPercent) {
          session = bar;
        }
        continue;
      }
      if (week === null || window.usedPercent > week.usedPercent) week = bar;
    }
  }
  return { session, week, fetchedAt };
}
