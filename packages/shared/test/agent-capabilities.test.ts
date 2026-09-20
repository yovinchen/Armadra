import { describe, expect, it } from "vitest";

import {
  agentProbeSchema,
  compareVersions,
  effectiveCapabilities,
  hostSupports,
  modelSuggestions,
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
    // opencode has no account-usage adapter; nothing downstream can add one.
    const resolved = resolveAgentCapabilities({
      baseAgent: "opencode",
      probe: probe({ agentId: "opencode" }),
    });
    const usage = resolved.find((entry) => entry.capability === "usage");
    expect(usage).toEqual({
      capability: "usage",
      state: "unsupported",
      source: "base",
    });
    expect(
      effectiveCapabilities({ baseAgent: "opencode", probe: probe() }),
    ).not.toContain("usage");
  });

  it("lets a custom entry switch a capability off and reports it as the source", () => {
    const resolved = resolveAgentCapabilities({
      baseAgent: "claude",
      disabledCapabilities: ["usage"],
      probe: probe(),
    });
    expect(resolved.find((entry) => entry.capability === "usage")).toEqual({
      capability: "usage",
      state: "unsupported",
      source: "custom",
    });
  });

  it("drops account usage on an SSH execution host", () => {
    const resolved = resolveAgentCapabilities({
      baseAgent: "claude",
      probe: probe(),
      host: "ssh",
    });
    const state = (capability: string) =>
      resolved.find((entry) => entry.capability === capability);
    expect(state("usage")).toEqual({
      capability: "usage",
      state: "unsupported",
      source: "host",
    });
    // Everything else survives the crossing.
    expect(state("resume")?.state).toBe("supported");
    expect(hostSupports("local", "usage")).toBe(true);
    expect(hostSupports("ssh", "usage")).toBe(false);
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
    for (const agent of ["claude", "codex", "opencode"] as const) {
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

describe("model suggestions", () => {
  it("offers suggestions only where the CLI documents aliases", () => {
    expect(modelSuggestions("claude")).toContain("sonnet");
    expect(modelSuggestions("copilot")).toEqual([]);
    expect(modelSuggestions("custom:whatever")).toEqual([]);
  });
});
