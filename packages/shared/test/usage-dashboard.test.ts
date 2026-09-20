import { describe, expect, it } from "vitest";
import {
  copilotAuthSchema,
  copilotPollSchema,
  costSummarySchema,
  usageSchema,
} from "../src/index.js";

/** 额度、用量与成本看板的传输契约（roadmap §4.2）。 */
describe("usage dashboard contracts", () => {
  const tokens = { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 };
  const window = { tokens, costUsd: 1.5, complete: true, models: [] };
  const range = {
    granularity: "day",
    points: [],
    totals: window,
    byModel: [],
    byAgent: [],
    peak: null,
    activeIntervals: 0,
    longestStreak: 0,
    sessions: 0,
  };
  const ranges = { "24h": range, "7d": range, "30d": range, all: range };

  it("accepts Copilot as a provider and carries unlimited buckets and credits", () => {
    const parsed = usageSchema.parse({
      providers: [
        {
          id: "copilot",
          status: "ok",
          credentialSource: "file",
          fetchedAt: "2026-09-05T10:00:00Z",
          windows: [
            {
              key: "chat",
              label: "chat",
              usedPercent: 0,
              unlimited: true,
              resetsAt: null,
            },
          ],
        },
        {
          id: "codex",
          status: "ok",
          credentialSource: "file",
          fetchedAt: "2026-09-05T10:00:00Z",
          credits: { balance: 12.5 },
          viaCli: true,
          windows: [],
        },
      ],
    });
    expect(parsed.providers[0]!.windows[0]!.unlimited).toBe(true);
    expect(parsed.providers[1]!.credits?.balance).toBe(12.5);
    expect(parsed.providers[1]!.viaCli).toBe(true);
  });

  it("keeps a window from an older runtime that has no unlimited flag", () => {
    const parsed = usageSchema.parse({
      providers: [
        {
          id: "claude",
          status: "ok",
          credentialSource: "keychain",
          fetchedAt: null,
          windows: [
            { key: "5h", label: "5h", usedPercent: 24, resetsAt: null },
          ],
        },
      ],
    });
    expect(parsed.providers[0]!.windows[0]!.unlimited).toBeUndefined();
  });

  it("reads an unpriced model as null cost rather than zero", () => {
    const parsed = costSummarySchema.parse({
      status: "ok",
      today: {
        ...window,
        complete: false,
        models: [{ model: "gpt-5-codex", tokens, costUsd: null }],
      },
      last30Days: window,
      daily: [{ date: "2026-09-05", ...window }],
      ranges,
      unpricedModels: ["gpt-5-codex"],
      files: { claude: 2, codex: 1 },
      truncated: false,
      scannedAt: "2026-09-05T10:00:00Z",
    });
    expect(parsed.today.models[0]!.costUsd).toBeNull();
    expect(parsed.today.complete).toBe(false);
    expect(parsed.currentSession).toBeUndefined();
  });

  it("rejects a cost summary whose unpriced model is reported as a number", () => {
    expect(
      costSummarySchema.safeParse({
        status: "ok",
        today: { ...window, models: [{ model: "x", tokens }] },
        last30Days: window,
        daily: [],
        unpricedModels: [],
        files: {},
        truncated: false,
      }).success,
    ).toBe(false);
  });

  it("never models a device code on the Copilot sign-in payloads", () => {
    const auth = copilotAuthSchema.parse({
      signedIn: false,
      backend: "keychain",
      pending: {
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
        intervalSeconds: 5,
        expiresAt: "2026-09-05T10:15:00Z",
        // A runtime that leaked one must not make it reachable through the
        // parsed shape.
        deviceCode: "secret",
      },
    });
    expect(auth.pending).not.toHaveProperty("deviceCode");
    expect(
      copilotPollSchema.parse({
        signedIn: true,
        backend: "file",
        progress: "authorized",
      }).progress,
    ).toBe("authorized");
    expect(
      copilotPollSchema.safeParse({
        signedIn: true,
        backend: "file",
        progress: "unknown",
      }).success,
    ).toBe(false);
  });
});
