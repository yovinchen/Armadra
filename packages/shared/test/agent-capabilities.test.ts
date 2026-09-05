import { describe, expect, it } from "vitest";

import {
  agentProbeSchema,
  compareVersions,
  contextLevel,
  DEFAULT_CONTEXT_THRESHOLDS,
  effectiveCapabilities,
  estimateTokens,
  hostSupports,
  modelContextCapacity,
  modelSuggestions,
  normalizeContextThresholds,
  normalizeModelId,
  parseCliVersion,
  resolveAgentCapabilities,
  type AgentProbe,
} from "../src/index.js";

const probe = (patch: Partial<AgentProbe> = {}): AgentProbe =>
  agentProbeSchema.parse({
    agentId: "claude",
    launchCmd: "claude",
    version: "2.0.0",
    status: "ok",
    probedAt: "2026-09-05T00:00:00Z",
    ...patch,
  });

describe("capability intersection", () => {
  it("never grants a capability the base adapter did not declare", () => {
    // gemini has no account-usage adapter; nothing downstream can add one.
    const resolved = resolveAgentCapabilities({
      baseAgent: "gemini",
      probe: probe({ agentId: "gemini" }),
    });
    const usage = resolved.find((entry) => entry.capability === "usage");
    expect(usage).toEqual({
      capability: "usage",
      state: "unsupported",
      source: "base",
    });
    expect(
      effectiveCapabilities({ baseAgent: "gemini", probe: probe() }),
    ).not.toContain("usage");
  });

  it("lets a custom entry switch a capability off and reports it as the source", () => {
    const resolved = resolveAgentCapabilities({
      baseAgent: "claude",
      disabledCapabilities: ["contextUsage"],
      probe: probe(),
    });
    expect(
      resolved.find((entry) => entry.capability === "contextUsage"),
    ).toEqual({
      capability: "contextUsage",
      state: "unsupported",
      source: "custom",
    });
  });

  it("drops the two usage capabilities on an SSH execution host", () => {
    const resolved = resolveAgentCapabilities({
      baseAgent: "claude",
      probe: probe(),
      host: "ssh",
    });
    const state = (capability: string) =>
      resolved.find((entry) => entry.capability === capability);
    expect(state("contextUsage")).toEqual({
      capability: "contextUsage",
      state: "unsupported",
      source: "host",
    });
    expect(state("usage")?.source).toBe("host");
    // Everything else survives the crossing.
    expect(state("resume")?.state).toBe("supported");
    expect(hostSupports("local", "contextUsage")).toBe(true);
    expect(hostSupports("ssh", "contextUsage")).toBe(false);
  });

  it("treats an unprobed CLI as certain only where no version gate exists", () => {
    // With an empty CAPABILITY_MIN_VERSION table nothing is gated, so an
    // un-probed CLI keeps the adapter's own declaration rather than going dark.
    const unprobed = resolveAgentCapabilities({ baseAgent: "claude" });
    expect(
      unprobed.find((entry) => entry.capability === "supportsModelSelection"),
    ).toEqual({
      capability: "supportsModelSelection",
      state: "supported",
      source: "base",
    });
    // A gated capability is the case that must fall back to `unknown`.
    const gated = resolveAgentCapabilities({
      baseAgent: "claude",
      probe: probe({ status: "failed", version: null }),
    });
    expect(gated.every((entry) => entry.state !== "unknown")).toBe(true);
  });

  it("never claims nativeRecurrence for a built-in adapter", () => {
    for (const agent of ["claude", "codex", "gemini", "opencode"] as const) {
      expect(
        effectiveCapabilities({ baseAgent: agent, probe: probe() }),
      ).not.toContain("nativeRecurrence");
    }
  });
});

describe("version parsing", () => {
  it("reads the first dotted number and refuses to invent one", () => {
    expect(parseCliVersion("2.0.31 (Claude Code)")).toBe("2.0.31");
    expect(parseCliVersion("codex-cli 0.104.0")).toBe("0.104.0");
    expect(parseCliVersion("1.2")).toBe("1.2.0");
    // A `v` prefix must not push the match one segment to the right.
    expect(parseCliVersion("v18.1.8\n")).toBe("18.1.8");
    expect(parseCliVersion("unknown build")).toBeNull();
    expect(parseCliVersion("")).toBeNull();
    // One segment is an identifier that ends in digits, not a version.
    expect(parseCliVersion("sha256")).toBeNull();
    expect(parseCliVersion("7")).toBeNull();
  });
  it("compares numerically, not lexically", () => {
    expect(compareVersions("1.2.10", "1.2.9")).toBe(1);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("0.9.0", "1.0.0")).toBe(-1);
  });
});

describe("model context windows", () => {
  it("answers for documented families and null for anything else", () => {
    expect(modelContextCapacity("claude-sonnet-4-5")).toBe(200_000);
    expect(modelContextCapacity("sonnet")).toBe(200_000);
    expect(modelContextCapacity("claude-opus-5[1m]")).toBe(1_000_000);
    expect(modelContextCapacity("gpt-5-codex")).toBe(400_000);
    expect(modelContextCapacity("gemini-2.5-pro")).toBe(1_048_576);
    expect(modelContextCapacity("gemini-1.5-pro")).toBe(2_097_152);
    expect(modelContextCapacity("some-local-llm")).toBeNull();
    expect(modelContextCapacity(null)).toBeNull();
    expect(modelContextCapacity("")).toBeNull();
  });
  it("strips a router prefix before matching", () => {
    expect(normalizeModelId("Anthropic/Claude-Sonnet-4-5")).toBe(
      "claude-sonnet-4-5",
    );
    expect(modelContextCapacity("openai/gpt-5")).toBe(400_000);
  });
  it("offers suggestions only where the CLI documents aliases", () => {
    expect(modelSuggestions("claude")).toContain("sonnet");
    expect(modelSuggestions("copilot")).toEqual([]);
    expect(modelSuggestions("custom:whatever")).toEqual([]);
  });
});

describe("character estimator", () => {
  it("charges ASCII by the quarter and non-ASCII by the character", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("中文")).toBe(2);
    // Mixed text adds the two runs rather than picking one ratio for both.
    expect(estimateTokens("abcd中文")).toBe(3);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("reminder thresholds", () => {
  it("keeps danger at or above warn and clamps both into range", () => {
    expect(normalizeContextThresholds(undefined)).toEqual(
      DEFAULT_CONTEXT_THRESHOLDS,
    );
    expect(
      normalizeContextThresholds({ warnPercent: 90, dangerPercent: 50 }),
    ).toEqual({ warnPercent: 90, dangerPercent: 90 });
    expect(
      normalizeContextThresholds({ warnPercent: -5, dangerPercent: 900 }),
    ).toEqual({ warnPercent: 1, dangerPercent: 100 });
    expect(normalizeContextThresholds({ warnPercent: Number.NaN })).toEqual(
      DEFAULT_CONTEXT_THRESHOLDS,
    );
  });
  it("returns null for a reading with no percentage", () => {
    const thresholds = DEFAULT_CONTEXT_THRESHOLDS;
    expect(contextLevel(null, thresholds)).toBeNull();
    expect(contextLevel(10, thresholds)).toBe("normal");
    expect(contextLevel(80, thresholds)).toBe("warn");
    expect(contextLevel(95, thresholds)).toBe("danger");
    expect(contextLevel(60, { warnPercent: 50, dangerPercent: 55 })).toBe(
      "danger",
    );
  });
});
