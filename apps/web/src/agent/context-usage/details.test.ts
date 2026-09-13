import { describe, expect, it } from "vitest";
import type { ContextUsage } from "@armadra/shared";

import { translate } from "@/i18n";
import { contextUsageView, type ContextUsageViewInput } from "./details";

const t = (key: string, values?: Record<string, string | number>) =>
  translate("en", key, values);

const usage = (): ContextUsage => ({
  nodeId: "node",
  sessionId: "session",
  generation: 2,
  providerSessionId: "provider",
  modelId: "fixture-model",
  usedTokens: 15500,
  capacityTokens: 200000,
  reservedOutputTokens: null,
  ageMs: 0,
  observedAt: new Date().toISOString(),
  quality: "reported",
  source: "provider_hook",
  sourceRevision: "10",
  compactionEpoch: 1,
  unknownReason: null,
});

function view(
  snapshot: ContextUsage | null = usage(),
  overrides: Partial<ContextUsageViewInput> = {},
) {
  return contextUsageView(
    {
      nodeId: "node",
      sessionId: "session",
      generation: 2,
      usage: snapshot,
      thresholds: { warnPercent: 80, dangerPercent: 95 },
      ...overrides,
    },
    t,
  );
}

/** 行按标签取值：菜单里怎么排版是另一回事，内容必须能单独断言。 */
function row(result: ReturnType<typeof view>, label: string): string {
  const found = result.rows.find(([name]) => name === label);
  if (!found) throw new Error(`没有这一行：${label}`);
  return found[1];
}

describe("context usage row", () => {
  it("shows current input percentage and explicitly unknown reserved output", () => {
    const result = view();
    expect(result.value).toBe("8%");
    expect(result.label).toBe("Context 8%");
    expect(row(result, "Current input usage")).toBe("15,500");
    expect(row(result, "Context capacity")).toBe("200,000");
    expect(row(result, "Reserved output")).toBe("Unknown");
    expect(row(result, "Source revision")).toBe("10");
    expect(result.notes.join(" ")).toMatch(/not cumulative billing/);
  });

  it("never displays 0% for missing data, capacity, or an obsolete generation", () => {
    for (const snapshot of [
      null,
      { ...usage(), capacityTokens: null },
      { ...usage(), generation: 1 },
      { ...usage(), sessionId: "old" },
    ]) {
      const result = view(snapshot);
      expect(result.value).toBe("Unknown");
      expect(result.percentage).toBeNull();
      expect(result.level).toBeNull();
    }
  });

  it("marks stale and estimated observations without relabeling them reported", () => {
    const estimated = view({
      ...usage(),
      quality: "estimated",
      source: "tokenizer_estimate",
    });
    expect(estimated.value).toBe("~8%");
    expect(estimated.notes.join(" ")).toMatch(/estimate may omit/);

    const stale = view({ ...usage(), ageMs: 301000 });
    expect(stale.quality).toBe("stale");
    expect(stale.text).toBe("8% · Stale");
    expect(stale.title).toMatch(/Session context · Stale/);
    expect(stale.notes.join(" ")).toMatch(/No new observation/);
  });

  it("warns by the configured thresholds, not hardcoded ones", () => {
    // 8 % is normal by default; with a 5 %/7 % pair it is already critical.
    const critical = view(usage(), {
      thresholds: { warnPercent: 5, dangerPercent: 7 },
    });
    expect(critical.level).toBe("danger");
    expect(critical.notes.join(" ")).toMatch(/over 7%/);
    expect(critical.notes.join(" ")).not.toMatch(/over 5%/);

    const warned = view(usage(), {
      thresholds: { warnPercent: 5, dangerPercent: 50 },
    });
    expect(warned.level).toBe("warn");
    expect(warned.notes.join(" ")).toMatch(/over 5%/);
  });

  it("reports which heuristic produced an estimate and how far it reached", () => {
    const result = view({
      ...usage(),
      quality: "estimated",
      source: "structured_transcript",
      sourceRevision: null,
      estimate: {
        heuristic: "chars-v1",
        confidence: "low",
        sampledBytes: 8192,
        truncated: true,
        messages: 42,
      },
    });
    expect(row(result, "Source")).toMatch(/Structured transcript/);
    expect(result.notes.join(" ")).toMatch(/chars-v1, low confidence/);
    expect(result.notes.join(" ")).toMatch(/42 transcript messages/);
    // A truncated read is a floor and says so, rather than reading as a total.
    expect(result.notes.join(" ")).toMatch(/this is a floor/);
  });

  it("says why a reading is missing rather than reading as idle", () => {
    const ended = view(null, { unavailableReason: "session_ended" });
    expect(ended.quality).toBe("unknown");
    expect(ended.notes[0]).toBe(t("context.session_ended"));

    const waiting = view(null);
    expect(waiting.notes[0]).toBe(t("context.awaiting_report"));
    expect(waiting.notes[1]).toBe(t("context.setupNote"));
  });
});
