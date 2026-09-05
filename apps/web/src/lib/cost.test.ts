import { describe, expect, it } from "vitest";
import type { UsageWindow } from "@armadra/shared";

import {
  expectedPercent,
  formatTokens,
  formatUsd,
  paceDelta,
  shortDate,
  totalTokens,
  windowSeconds,
} from "./cost";

const NOW = Date.parse("2026-09-05T12:00:00Z");

function window(patch: Partial<UsageWindow> = {}): UsageWindow {
  return {
    key: "5h",
    label: "5h",
    usedPercent: 50,
    resetsAt: null,
    ...patch,
  };
}

describe("usage dashboard maths", () => {
  it("reads a window duration only from a unit abbreviation", () => {
    expect(windowSeconds("5h")).toBe(18_000);
    expect(windowSeconds("7d")).toBe(604_800);
    expect(windowSeconds("90m")).toBe(5_400);
    // Copilot 的桶名与 Gemini 的 `quota` 都没有时长，不能瞎猜一个。
    expect(windowSeconds("quota")).toBeNull();
    expect(windowSeconds("premium interactions")).toBeNull();
    expect(windowSeconds("0h")).toBeNull();
  });

  it("has no pace without both a duration and a reset time", () => {
    expect(paceDelta(window(), NOW)).toBeNull();
    expect(
      paceDelta(window({ label: "quota", resetsAt: "x" }), NOW),
    ).toBeNull();
    expect(
      paceDelta(window({ resetsAt: "2026-09-05T11:00:00Z" }), NOW),
    ).toBeNull();
  });

  it("compares usage against how far the window has run", () => {
    // 5h 窗口还剩 1h ⇒ 已经走了 80%。
    const resetsAt = new Date(NOW + 3_600_000).toISOString();
    expect(expectedPercent(window({ resetsAt }), NOW)).toBeCloseTo(80);
    expect(paceDelta(window({ resetsAt, usedPercent: 95 }), NOW)).toBe(15);
    expect(paceDelta(window({ resetsAt, usedPercent: 60 }), NOW)).toBe(-20);
  });

  it("refuses a pace when the reset time is further out than the window", () => {
    // 时钟不对或窗口标签与重置时间对不上，都不该给结论。
    const resetsAt = new Date(NOW + 10 * 3_600_000).toISOString();
    expect(expectedPercent(window({ resetsAt }), NOW)).toBeNull();
  });

  it("scales token counts and never rounds real spending to zero", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_234)).toBe("1.2K");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(123_456_789)).toBe("123M");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0004)).toBe("<$0.01");
    expect(formatUsd(12.345)).toBe("$12.35");
  });

  it("sums the four token buckets and shortens a date for the axis", () => {
    expect(
      totalTokens({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }),
    ).toBe(10);
    expect(shortDate("2026-09-05")).toBe("9/5");
    expect(shortDate("nonsense")).toBe("nonsense");
  });
});
