import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import {
  type ContextReport,
  ContextUsageCache,
  contextCapacity,
  contextUsage,
  parseReport,
  reportsALiveWindow,
} from "./context-usage";

/** Ported from the `mod tests` in the pre-merge implementation. */

const NOW = 1_788_566_400_000;

function report(revision: number): ContextReport {
  return {
    sessionId: "s",
    generation: 1,
    sourceRevision: String(revision),
    data: {
      session_id: "provider",
      model: { id: "fixture-model" },
      // Never summed into the total: these are the billing numbers.
      cost: { total_input_tokens: 999_999_999 },
      context_window: {
        context_window_size: 200_000,
        total_input_tokens: 999_999_999,
        current_usage: {
          input_tokens: 8_500,
          output_tokens: 1_200,
          cache_creation_input_tokens: 5_000,
          cache_read_input_tokens: 2_000,
        },
      },
    },
  };
}

function withWindow(
  base: ContextReport,
  patch: Record<string, unknown>,
): ContextReport {
  const data = base.data as Record<string, unknown>;
  return {
    ...base,
    data: {
      ...data,
      context_window: {
        ...(data.context_window as Record<string, unknown>),
        ...patch,
      },
    },
  };
}

describe("parsing a provider report", () => {
  it("counts the three disjoint input buckets once and never guesses a capacity", () => {
    const snapshot = parseReport("n", report(1), NOW);
    expect(snapshot?.usedTokens).toBe(15_500);
    expect(snapshot?.capacityTokens).toBe(200_000);
    expect(snapshot?.reservedOutputTokens).toBeNull();
    expect(snapshot?.source).toBe("provider_hook");
    expect(snapshot?.quality).toBe("reported");

    const noCapacity = parseReport(
      "n",
      withWindow(report(1), { context_window_size: null }),
      NOW,
    );
    expect(noCapacity?.capacityTokens).toBeNull();

    const cleared = parseReport(
      "n",
      withWindow(report(1), { current_usage: null }),
      NOW,
    );
    expect(cleared?.usedTokens).toBeNull();
    expect(cleared?.quality).toBe("unknown");
    expect(cleared?.unknownReason).toBe("awaiting_response");
  });

  it("never reads a malformed count as zero", () => {
    for (const value of [-1, 1.2, "100", Number.MAX_SAFE_INTEGER + 2]) {
      const broken = withWindow(report(1), {
        current_usage: {
          input_tokens: value,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      });
      expect(parseReport("n", broken, NOW)).toBeUndefined();
    }
    expect(
      parseReport("n", { ...report(1), sourceRevision: "0" }, NOW),
    ).toBeUndefined();
    expect(
      parseReport("n", { ...report(1), sessionId: "" }, NOW),
    ).toBeUndefined();
  });

  it("keeps a known capacity when the usage key goes missing", () => {
    const data = report(1).data as Record<string, unknown>;
    const window = {
      ...(data.context_window as Record<string, unknown>),
    } as Record<string, unknown>;
    delete window.current_usage;
    const snapshot = parseReport(
      "n",
      { ...report(1), data: { ...data, context_window: window } },
      NOW,
    );
    expect(snapshot?.capacityTokens).toBe(200_000);
    expect(snapshot?.usedTokens).toBeNull();
    expect(snapshot?.unknownReason).toBe("source_unavailable");
  });
});

describe("the cache", () => {
  it("rejects an old revision even when the clock moves backwards", () => {
    const cache = new ContextUsageCache();
    expect(cache.report("n", report(1), NOW)).toBe(true);
    const compact = withWindow(report(3), { current_usage: null });
    expect(cache.report("n", compact, NOW - 1000)).toBe(true);
    expect(cache.report("n", report(2), NOW + 1000)).toBe(false);
    expect(cache.report("n", compact, NOW)).toBe(false);
  });

  it("counts a compaction only when the provider cleared the usage itself", () => {
    const cache = new ContextUsageCache();
    cache.report("n", report(1), NOW);
    cache.report("n", withWindow(report(2), { current_usage: null }), NOW);
    expect(cache.snapshot("n", "s", 1).compactionEpoch).toBe(1);

    const other = new ContextUsageCache();
    other.report("n", report(1), NOW);
    // A smaller number is a normal turn, not evidence of anything.
    other.report(
      "n",
      withWindow(report(2), {
        current_usage: {
          input_tokens: 1,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
      NOW,
    );
    expect(other.snapshot("n", "s", 1).compactionEpoch).toBe(0);
  });

  it("does not carry old numbers across a model or session change", () => {
    const cache = new ContextUsageCache();
    cache.report("n", report(1), NOW);
    const next = {
      ...withWindow(report(2), {
        current_usage: null,
        context_window_size: null,
      }),
      data: {
        ...(report(2).data as Record<string, unknown>),
        model: { id: "other-model" },
        context_window: { context_window_size: null, current_usage: null },
      },
    };
    cache.report("n", next, NOW);
    const snapshot = cache.snapshot("n", "s", 1);
    expect(snapshot.modelId).toBe("other-model");
    expect(snapshot.usedTokens).toBeNull();
    expect(snapshot.capacityTokens).toBeNull();
    expect(snapshot.compactionEpoch).toBe(0);
  });

  it("answers a new generation fresh and an unseen node as unknown", () => {
    const cache = new ContextUsageCache();
    cache.report("n", report(1), NOW);
    const recycled = { ...report(1), generation: 2 };
    expect(cache.report("n", recycled, NOW)).toBe(true);
    expect(cache.snapshot("n", "s", 2).compactionEpoch).toBe(0);
    // The old generation is no longer described by this reading.
    expect(cache.snapshot("n", "s", 1).unknownReason).toBe("session_changed");
    expect(new ContextUsageCache().snapshot("n", "s", 1)).toMatchObject({
      source: "unavailable",
      quality: "unknown",
      unknownReason: "awaiting_report",
      usedTokens: null,
    });
  });

  it("calls a reading stale rather than letting it look current", () => {
    const cache = new ContextUsageCache();
    cache.report("n", report(1), NOW);
    cache.age("n", 5 * 60_000 + 1);
    expect(cache.snapshot("n", "s", 1).quality).toBe("stale");
  });
});

describe("the three sources", () => {
  it("knows which providers publish a live window", () => {
    expect(reportsALiveWindow("claude")).toBe(true);
    expect(reportsALiveWindow("pi")).toBe(true);
    expect(reportsALiveWindow("omp")).toBe(true);
    // Codex writes a rollout this core reads; that is an estimate, not a
    // measurement, and it is labelled as one.
    expect(reportsALiveWindow("codex")).toBe(false);
    expect(reportsALiveWindow("copilot")).toBe(false);
  });

  it("leaves an unrecognised model's window unknown rather than guessing", () => {
    expect(contextCapacity(null)).toBeNull();
    expect(contextCapacity("something-nobody-listed")).toBeNull();
    expect(contextCapacity("gpt-5-codex")).toBe(400_000);
  });
});

describe("the route's read", () => {
  let fixture: AgentFixture;

  beforeEach(() => {
    fixture = agentFixture();
  });

  afterEach(() => {
    fixture.close();
  });

  it("answers a live-window provider from the cache", async () => {
    const node = fixture.agentNode("Claude");
    const session = fixture.session(node, "claude");
    fixture.usage.report(node, { ...report(1), sessionId: session }, NOW);
    const answer = await fixture.call(
      "GET",
      `/api/workspaces/${fixture.workspaceId}/nodes/${node}/context-usage?sessionId=${session}&generation=1`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      source: "provider_hook",
      quality: "reported",
      usedTokens: 15_500,
      capacityTokens: 200_000,
    });
  });

  it("says unsupported rather than zero for a provider with no window", async () => {
    const node = fixture.agentNode("Copilot", "copilot");
    const session = fixture.session(node, "copilot");
    const answer = await fixture.call(
      "GET",
      `/api/workspaces/${fixture.workspaceId}/nodes/${node}/context-usage?sessionId=${session}&generation=1`,
    );
    expect(answer.body).toMatchObject({
      source: "unavailable",
      quality: "unknown",
      unknownReason: "unsupported",
      usedTokens: null,
    });
  });

  it("reports a recycled generation as changed, not as empty", async () => {
    const node = fixture.agentNode("Claude");
    const session = fixture.session(node, "claude");
    const answer = await fixture.call(
      "GET",
      `/api/workspaces/${fixture.workspaceId}/nodes/${node}/context-usage?sessionId=${session}&generation=7`,
    );
    expect(answer.body).toMatchObject({ unknownReason: "session_changed" });
  });

  it("refuses a session that belongs to another node", async () => {
    const node = fixture.agentNode("Claude");
    const other = fixture.agentNode("Other", "claude");
    const session = fixture.session(other, "claude");
    const answer = await fixture.call(
      "GET",
      `/api/workspaces/${fixture.workspaceId}/nodes/${node}/context-usage?sessionId=${session}&generation=1`,
    );
    expect(answer.status).toBe(404);
  });

  it("requires the session and generation the reading is about", async () => {
    const node = fixture.agentNode("Claude");
    expect(
      (
        await fixture.call(
          "GET",
          `/api/workspaces/${fixture.workspaceId}/nodes/${node}/context-usage`,
        )
      ).status,
    ).toBe(400);
  });
});
