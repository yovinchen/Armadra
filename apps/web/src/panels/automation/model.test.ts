import { describe, expect, it } from "vitest";
import { create } from "@armadra/protocol";
import {
  AutomationPlanSchema,
  AutomationPlanConfigSchema,
  AutomationRunSchema,
} from "@armadra/protocol";

import {
  digestLabel,
  instant,
  needsAttention,
  planStateKey,
  reasonLabel,
  receiptPhase,
  runStateKey,
  scheduleKind,
  timezoneOptions,
  unresolved,
  validCron,
  validTimezone,
} from "./model";

function config(kind: Record<string, unknown>) {
  return create(AutomationPlanConfigSchema, { schedule: { kind } } as never);
}

describe("schedule shape", () => {
  it("names each schedule kind and refuses to guess an empty one", () => {
    expect(
      scheduleKind(config({ case: "once", value: { atUnixMs: 1n } })),
    ).toBe("once");
    expect(
      scheduleKind(
        config({
          case: "interval",
          value: { anchorUnixMs: 1n, intervalMs: 1000n },
        }),
      ),
    ).toBe("interval");
    expect(
      scheduleKind(
        config({
          case: "cron",
          value: { expression: "0 3 * * *", timezone: "UTC" },
        }),
      ),
    ).toBe("cron");
    expect(
      scheduleKind(
        config({ case: "loopAfterCompletion", value: { delayMs: 1n } }),
      ),
    ).toBe("loop");
    expect(scheduleKind(create(AutomationPlanConfigSchema, {}))).toBeNull();
    expect(scheduleKind(undefined)).toBeNull();
  });
});

describe("cron validation", () => {
  it("accepts the five-field expressions the Host parses", () => {
    for (const expression of [
      "* * * * *",
      "0 3 * * *",
      "*/15 * * * 1-5",
      "0,30 0-23/2 1 1,6,12 0",
      "59 23 31 12 6",
      "0 3 * * MON",
      "0 3 * JAN-MAR *",
    ])
      expect(validCron(expression), expression).toBe(true);
  });

  it("refuses anything the Host would later reject", () => {
    for (const expression of [
      "",
      "   ",
      "* * * *",
      "0 0 * * * *",
      "0 3 * * FUNDAY",
      "60 3 * * *",
      "0 24 * * *",
      "0 3 0 * *",
      "0 3 * 13 *",
      "0 3 * * 7",
      "5-1 3 * * *",
      "*/0 * * * *",
      "? 3 * * *",
      "0 3 L * *",
      "0 3 * * 1#2",
      "0/ 3 * * *",
    ])
      expect(validCron(expression), expression).toBe(false);
  });
});

describe("timezones", () => {
  it("accepts real IANA zones and rejects invented ones", () => {
    expect(validTimezone("Asia/Shanghai")).toBe(true);
    expect(validTimezone("UTC")).toBe(true);
    expect(validTimezone("Mars/Olympus")).toBe(false);
    expect(validTimezone("")).toBe(false);
    expect(validTimezone("  ")).toBe(false);
  });

  it("always offers at least one zone to pick", () => {
    const zones = timezoneOptions();
    expect(zones.length).toBeGreaterThan(0);
    expect(zones.every((zone) => validTimezone(zone))).toBe(true);
  });
});

describe("state labels", () => {
  it("maps plan and run states onto translation keys", () => {
    expect(planStateKey(create(AutomationPlanSchema, { state: 2 }))).toBe(
      "automation.planState.active",
    );
    expect(planStateKey(undefined)).toBe("automation.planState.unspecified");
    expect(runStateKey(create(AutomationRunSchema, { state: 7 }))).toBe(
      "automation.runState.succeeded",
    );
    expect(runStateKey(create(AutomationRunSchema, { state: 12 }))).toBe(
      "automation.runState.unknown",
    );
  });

  it("keeps an unknown outcome separate from a finished one", () => {
    expect(unresolved(create(AutomationRunSchema, { state: 12 }))).toBe(true);
    expect(unresolved(create(AutomationRunSchema, { state: 7 }))).toBe(false);
  });

  it("reads the needs-attention marker straight from the Host", () => {
    expect(
      needsAttention(create(AutomationPlanSchema, { needsAttention: true })),
    ).toBe(true);
    expect(needsAttention(create(AutomationPlanSchema, {}))).toBe(false);
  });
});

describe("receipt phase", () => {
  it("never reports delivered input as finished work", () => {
    const delivered = create(AutomationRunSchema, {
      state: 5,
      dispatchAttempts: 1,
      receiptSequence: 1n,
    });
    expect(receiptPhase(delivered)).toBe("delivered");
    const settled = create(AutomationRunSchema, {
      state: 7,
      dispatchAttempts: 1,
      receiptSequence: 2n,
    });
    expect(receiptPhase(settled)).toBe("settled");
  });

  it("separates a queued attempt from one with no attempt at all", () => {
    expect(
      receiptPhase(
        create(AutomationRunSchema, { state: 1, dispatchAttempts: 0 }),
      ),
    ).toBe("none");
    expect(
      receiptPhase(
        create(AutomationRunSchema, { state: 4, dispatchAttempts: 1 }),
      ),
    ).toBe("queued");
  });

  it("keeps observed delivery visible even without a receipt sequence", () => {
    expect(
      receiptPhase(
        create(AutomationRunSchema, {
          state: 12,
          dispatchAttempts: 1,
          deliveryObserved: true,
        }),
      ),
    ).toBe("delivered");
  });
});

describe("formatting", () => {
  it("renders a set timestamp and refuses to invent one", () => {
    expect(instant(1_788_557_900_000n, "en", "UTC")).toContain("2026");
    expect(instant(0n, "en")).toBeNull();
    expect(instant(undefined, "en")).toBeNull();
    expect(instant(-1n, "en")).toBeNull();
    expect(instant(9_000_000_000_000_000n, "en")).toBeNull();
  });

  it("falls back to the runtime zone when the plan's is unusable", () => {
    expect(instant(1_788_557_900_000n, "en", "Mars/Olympus")).not.toBeNull();
  });

  it("renders a digest as hex and an empty one as nothing", () => {
    expect(digestLabel(new Uint8Array([0x0a, 0xff]))).toBe("0aff");
    expect(digestLabel(new Uint8Array())).toBe("");
    expect(digestLabel(undefined)).toBe("");
  });

  it("shows a reason code verbatim and drops anything that is not one", () => {
    expect(reasonLabel("TARGET_UNSUPPORTED")).toBe("TARGET_UNSUPPORTED");
    expect(reasonLabel("raw terminal output")).toBe("");
    expect(reasonLabel(undefined)).toBe("");
  });
});
