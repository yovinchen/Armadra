import { describe, expect, it } from "vitest";
import {
  ageContextUsage,
  contextPercentage,
  contextUsageSchema,
} from "../src/context-usage.js";

const usage = () =>
  contextUsageSchema.parse({
    nodeId: "n",
    sessionId: "s",
    generation: 1,
    providerSessionId: "provider",
    modelId: "fixture-model",
    usedTokens: 15_500,
    capacityTokens: 200_000,
    reservedOutputTokens: null,
    ageMs: 0,
    observedAt: "2026-09-05T00:00:00Z",
    source: "provider_hook",
    quality: "reported",
    sourceRevision: "1",
    compactionEpoch: 0,
    unknownReason: null,
  });
describe("current context contract", () => {
  it("never represents unknown or missing capacity as zero percent", () => {
    expect(contextPercentage(usage())).toBe(7.75);
    expect(contextPercentage({ ...usage(), quality: "unknown" })).toBeNull();
    expect(contextPercentage({ ...usage(), capacityTokens: null })).toBeNull();
    expect(contextPercentage({ ...usage(), usedTokens: null })).toBeNull();
    expect(contextPercentage({ ...usage(), usedTokens: 0 })).toBe(0);
  });
  it("ages a known observation without changing its source or timestamp", () => {
    const original = usage();
    expect(ageContextUsage(original, 300_001)).toEqual({
      ...original,
      quality: "stale",
    });
    expect(
      ageContextUsage({ ...original, quality: "unknown" }, Infinity).quality,
    ).toBe("unknown");
    expect(ageContextUsage(original, 10)).toBe(original);
    expect(
      ageContextUsage({ ...original, observedAt: "2000-01-01T00:00:00Z" }, 10)
        .quality,
    ).toBe("reported");
    expect(
      ageContextUsage(
        { ...original, observedAt: "2099-01-01T00:00:00Z", ageMs: 300_001 },
        0,
      ).quality,
    ).toBe("stale");
  });
  it("accepts explicitly estimated source without claiming provider reporting", () => {
    expect(
      contextUsageSchema.parse({
        ...usage(),
        source: "tokenizer_estimate",
        quality: "estimated",
      }).quality,
    ).toBe("estimated");
    for (const usedTokens of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        contextUsageSchema.safeParse({ ...usage(), usedTokens }).success,
      ).toBe(false);
    }
    expect(
      contextUsageSchema.safeParse({ ...usage(), capacityTokens: 0 }).success,
    ).toBe(false);
  });
});
