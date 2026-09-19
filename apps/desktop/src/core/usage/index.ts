/**
 * The usage domain, as far as this batch takes it: one route, `GET
 * /api/usage/mini`.
 *
 * The other eight usage routes stay 501 with their feature name. They need the
 * provider modules — reading a CLI's stored credentials out of the keychain or
 * a 0600 file, calling a quota endpoint, the cost scan over local transcripts,
 * the Copilot device flow — and those arrive with the usage domain proper.
 *
 * `mini` is here because the tray strip asks for it on every start, and what it
 * must never do is hang or invent a number. A source that has fetched nothing
 * answers the same document the Rust Runtime answers before its own first
 * fetch: two null bars and a null timestamp, which is precisely the state in
 * which the pill does not render. `unavailable` is a real answer, and it is the
 * one this build gives.
 */

import type { CoreContext } from "../main";
import { emptySnapshot, miniUsage, type UsageSnapshot } from "./snapshot";

export {
  emptySnapshot,
  labelHours,
  miniUsage,
  USAGE_PROVIDER_IDS,
} from "./snapshot";
export type {
  CredentialSource,
  MiniBar,
  MiniUsage,
  ProviderUsage,
  UsageFailure,
  UsageSnapshot,
  UsageStatus,
  UsageWindow,
} from "./snapshot";

/**
 * Where the snapshot comes from.
 *
 * A function rather than a value so the provider modules can replace it without
 * this route changing: they will own a cache and a refresh loop, and `mini` is
 * a projection of whatever that cache currently holds.
 */
export type UsageSource = () => UsageSnapshot;

let source: UsageSource = emptySnapshot;

/** Point `mini` at a real cache. The provider modules call this. */
export function setUsageSource(next: UsageSource): void {
  source = next;
}

export function install(context: CoreContext): void {
  context.server.router.handle("GET", "/api/usage/mini", () => ({
    status: 200,
    body: miniUsage(source()),
  }));
}
