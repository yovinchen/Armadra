import { describe, expect, it } from "vitest";
import {
  CEILING_MS,
  CELLS,
  FLOOR_MS,
  bar,
  parseMiniUsage,
  pollIntervalMs,
  refreshMinutes,
  usageLine,
  usageLines,
  type MiniBar,
} from "./usage";
import { desktop } from "../../../web/src/i18n/desktop";

/**
 * The assertions are `src-tauri/src/usage.rs`'s own, ported one for one — the
 * strip is the same readout whichever shell draws it, so the port is only
 * honest if it keeps being checked against the same payloads and the same
 * rendered strings.
 */

const zh = {
  session: desktop["zh-CN"]["tray.usage.session"]!,
  week: desktop["zh-CN"]["tray.usage.week"]!,
  unknown: desktop["zh-CN"]["tray.usage.unknown"]!,
};
const en = {
  session: desktop.en["tray.usage.session"]!,
  week: desktop.en["tray.usage.week"]!,
  unknown: desktop.en["tray.usage.unknown"]!,
};

function value(percent: number): MiniBar {
  return { provider: "claude", label: "5h", usedPercent: percent };
}

describe("the tray usage strip", () => {
  it("says unknown for a missing window, and never draws an empty bar", () => {
    for (const strings of [zh, en]) {
      const text = usageLine(strings.session, strings.unknown, null);
      expect(text).toContain(strings.unknown);
      expect(text).not.toContain("▯");
      expect(text).not.toContain("%");
    }
  });

  it("makes zero percent look different from unknown", () => {
    const zero = usageLine(en.session, en.unknown, value(0));
    expect(zero).toContain("0%");
    expect(zero.match(/▯/g)).toHaveLength(CELLS);
    expect(zero).not.toBe(usageLine(en.session, en.unknown, null));
  });

  it("fills the bar with the percentage and clamps at both ends", () => {
    expect(bar(0)).toBe("▯".repeat(CELLS));
    expect(bar(50)).toBe("▮▮▮▮▮▯▯▯▯▯");
    expect(bar(100)).toBe("▮".repeat(CELLS));
    // A provider over its own limit has still only filled the bar once.
    expect(bar(140)).toBe("▮".repeat(CELLS));
    expect(bar(-5)).toBe("▯".repeat(CELLS));
    expect(usageLine(en.week, en.unknown, value(140))).toContain("100%");
  });

  it("renders both rows even when only one window answered", () => {
    const [session, week] = usageLines(zh, {
      session: value(42),
      week: null,
    });
    expect(session.startsWith(zh.session)).toBe(true);
    expect(session).toContain("42%");
    expect(session).toContain("claude·5h");
    expect(week.startsWith(zh.week)).toBe(true);
    expect(week.endsWith(zh.unknown)).toBe(true);
    // Nothing fetched yet is two unknowns, not two empty bars.
    for (const line of usageLines(en, null))
      expect(line.endsWith(en.unknown)).toBe(true);
  });

  it("parses the payload and keeps an absent window absent", () => {
    const usage = parseMiniUsage(
      '{"session":{"provider":"codex","label":"7d","usedPercent":12.5,"resetsAt":null},"week":null,"fetchedAt":null}',
    );
    expect(usage?.session?.provider).toBe("codex");
    expect(usage?.week).toBeNull();
    // An empty document is two unknowns, and an unreadable one is null.
    expect(parseMiniUsage("{}")?.session).toBeNull();
    expect(parseMiniUsage("not json")).toBeNull();
    // A window that is present but malformed is absent, not a NaN bar.
    expect(parseMiniUsage('{"session":{"provider":"x"}}')?.session).toBeNull();
  });

  /** The exact body a running Runtime answered `GET /api/usage/mini` with,
   * kept verbatim from `usage.rs` so the strip is checked against a real
   * payload rather than against a shape this file invented. */
  it("renders both rows of a real Runtime answer", () => {
    const body =
      '{"session":{"provider":"claude","label":"5h","usedPercent":26.0,"resetsAt":"2026-09-05T22:10:00.461989+00:00"},"week":{"provider":"claude","label":"7d","usedPercent":21.0,"resetsAt":"2026-09-11T11:00:00.462016+00:00"},"fetchedAt":"2026-09-05T19:17:32.108356+00:00"}';
    const usage = parseMiniUsage(body);
    expect(usageLines(zh, usage)).toEqual([
      "会话  ▮▮▮▯▯▯▯▯▯▯  26%  claude·5h",
      "周窗口  ▮▮▯▯▯▯▯▯▯▯  21%  claude·7d",
    ]);
    expect(usageLines(en, usage)[0]).toBe(
      "Session  ▮▮▮▯▯▯▯▯▯▯  26%  claude·5h",
    );
  });

  it("follows the refresh setting within bounds", () => {
    expect(pollIntervalMs(1)).toBe(CEILING_MS);
    expect(pollIntervalMs(15)).toBe(900_000);
    // Manual-only and a missing setting both fall back to the floor rather
    // than polling continuously or not at all.
    expect(pollIntervalMs(0)).toBe(FLOOR_MS);
    expect(pollIntervalMs(null)).toBe(FLOOR_MS);
    expect(refreshMinutes('{"usage":{"refreshMinutes":2}}')).toBe(2);
    expect(refreshMinutes("{}")).toBeNull();
    expect(refreshMinutes("broken")).toBeNull();
    expect(refreshMinutes('{"usage":{"refreshMinutes":"soon"}}')).toBeNull();
  });
});
