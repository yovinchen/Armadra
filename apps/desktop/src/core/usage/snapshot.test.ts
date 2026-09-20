/**
 * `GET /api/usage/mini`.
 *
 * Ported from the `MiniUsage` cases in the pre-merge implementation. The
 * empty case is the one this build actually serves — no provider module has
 * been written yet — so it is asserted first and in full.
 */

import { describe, expect, it } from "vitest";

import {
  emptySnapshot,
  labelHours,
  miniUsage,
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

  it("makes nothing to show empty rather than zero", () => {
    expect(miniUsage(emptySnapshot())).toEqual({
      session: null,
      week: null,
      fetchedAt: null,
    });
  });
});

describe("miniUsage", () => {
  it("takes the most pressed short and long window across every provider", () => {
    const mini = miniUsage({
      refreshAvailableAt: null,
      providers: [
        ok("claude", [window("5h", 40), window("7d", 90)]),
        ok("codex", [window("5h", 65), window("7d", 10)]),
      ],
    });
    expect(mini.session).toEqual({
      provider: "codex",
      label: "5h",
      usedPercent: 65,
      resetsAt: null,
    });
    expect(mini.week?.provider).toBe("claude");
    expect(mini.week?.usedPercent).toBe(90);
    expect(mini.fetchedAt).toBe("2026-09-05T10:00:00Z");
  });

  it("ignores a provider that did not answer", () => {
    const mini = miniUsage({
      refreshAvailableAt: null,
      providers: [
        {
          ...ok("claude", [window("5h", 99)]),
          status: "error",
          reason: "unauthorized",
        },
        { ...ok("codex", [window("5h", 10)]), status: "unavailable" },
        ok("copilot", [window("5h", 20)]),
      ],
    });
    expect(mini.session?.provider).toBe("copilot");
    expect(mini.session?.usedPercent).toBe(20);
  });

  /**
   * An unlimited bucket has no pressure to report — `usedPercent` is 0 and
   * means nothing — and a window with no readable size cannot be sorted into
   * either bar.
   */
  it("leaves out the unlimited and the undatable windows", () => {
    const mini = miniUsage({
      refreshAvailableAt: null,
      providers: [
        ok("copilot", [
          window("5h", 80, { unlimited: true }),
          window("quota", 70),
          window("primary", 60),
        ]),
      ],
    });
    expect(mini.session).toBeNull();
    expect(mini.week).toBeNull();
    // It still answered, so its timestamp is the strip's.
    expect(mini.fetchedAt).toBe("2026-09-05T10:00:00Z");
  });

  it("splits the two bars at a day", () => {
    expect(labelHours("5h")).toBe(5);
    expect(labelHours("24h")).toBe(24);
    expect(labelHours("7d")).toBe(168);
    expect(labelHours("1m")).toBe(1);
    expect(labelHours("quota")).toBeUndefined();
    expect(labelHours("primary")).toBeUndefined();
    expect(labelHours("h")).toBeUndefined();
    expect(labelHours("")).toBeUndefined();

    const mini = miniUsage({
      refreshAvailableAt: null,
      providers: [ok("claude", [window("24h", 10), window("25h", 20)])],
    });
    expect(mini.session?.label).toBe("24h");
    expect(mini.week?.label).toBe("25h");
  });

  it("takes the timestamp of the first provider that had one", () => {
    const mini = miniUsage({
      refreshAvailableAt: null,
      providers: [
        ok("claude", [window("5h", 1)], null),
        ok("codex", [window("5h", 2)], "2026-09-05T11:00:00Z"),
      ],
    });
    expect(mini.fetchedAt).toBe("2026-09-05T11:00:00Z");
  });
});
