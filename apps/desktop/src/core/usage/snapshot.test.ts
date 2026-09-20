/**
 * `GET /api/usage/mini`.
 *
 * Ported from the pre-merge implementation. The
 * empty case is the one this build actually serves — no provider module has
 * been written yet — so it is asserted first and in full.
 */

import { describe, expect, it } from "vitest";

import {
  emptySnapshot,
  type ProviderUsage,
  type UsageWindow,
} from "./snapshot";

function ok(
  id: "claude" | "codex" | "copilot",
  windows: UsageWindow[],
  fetchedAt: string | null = "2026-09-05T10:00:00Z",
): ProviderUsage {
  return {
    id,
    status: "ok",
    credentialSource: "keychain",
    windows,
    fetchedAt,
  };
}

const window = (
  label: string,
  usedPercent: number,
  extra: Partial<UsageWindow> = {},
): UsageWindow => ({
  key: label,
  label,
  usedPercent,
  resetsAt: null,
  ...extra,
});

describe("the empty snapshot", () => {
  /**
   * What the API answers before the first fetch and whenever `usage.enabled`
   * is off. Every provider `unavailable` with no reason is a third thing,
   * distinct from `error`: it means "no credentials on this machine", and it
   * is the state in which the pill does not render.
   */
  it("reports every provider unavailable with no reason and no credentials", () => {
    const snapshot = emptySnapshot();
    expect(snapshot.refreshAvailableAt).toBeNull();
    expect(snapshot.providers.map((provider) => provider.id)).toEqual([
      "claude",
      "codex",
      "copilot",
    ]);
    for (const provider of snapshot.providers) {
      expect(provider.status).toBe("unavailable");
      expect(provider.reason).toBeUndefined();
      expect(provider.credentialSource).toBe("none");
      expect(provider.windows).toEqual([]);
      expect(provider.fetchedAt).toBeNull();
    }
  });
});
