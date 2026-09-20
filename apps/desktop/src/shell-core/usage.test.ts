import { describe, expect, it } from "vitest";
import {
  CEILING_MS,
  FLOOR_MS,
  costLine,
  pollIntervalMs,
  providerLines,
  refreshMinutes,
  traySummary,
  type TrayStrings,
} from "./usage";

const strings: TrayStrings = {
  provider: (id) => ({ claude: "Claude", codex: "Codex" })[id] ?? id,
  reason: (code) => `reason:${code}`,
  signedOut: "signed out",
  noData: "no data",
  costToday: "Today",
};

const SNAPSHOT = JSON.stringify({
  providers: [
    {
      id: "claude",
      status: "ok",
      windows: [
        { label: "5h", usedPercent: 42.4, resetsAt: null },
        { label: "7d", usedPercent: 13, resetsAt: null },
        { label: "∞", usedPercent: 0, unlimited: true, resetsAt: null },
      ],
    },
    { id: "codex", status: "error", reason: "network", windows: [] },
    { id: "copilot", status: "unavailable", windows: [] },
  ],
});

describe("the tray readout", () => {
  it("writes one line per provider: windows, the reason, or signed out", () => {
    expect(providerLines(SNAPSHOT, strings)).toEqual([
      "Claude · 5h 42% · 7d 13%",
      "Codex · reason:network",
      "copilot · signed out",
    ]);
  });

  it("says no data for a provider that answered without windows", () => {
    const body = JSON.stringify({
      providers: [{ id: "claude", status: "ok", windows: [] }],
    });
    expect(providerLines(body, strings)).toEqual(["Claude · no data"]);
  });

  it("refuses a body that is not a snapshot", () => {
    expect(providerLines("nope", strings)).toBeUndefined();
    expect(providerLines("{}", strings)).toBeUndefined();
  });

  it("shows today's cost only when the scan is on and has run", () => {
    expect(
      costLine(
        JSON.stringify({ status: "ok", today: { costUsd: 12.345 } }),
        strings,
      ),
    ).toBe("Today $12.35");
    expect(
      costLine(
        JSON.stringify({ status: "disabled", today: { costUsd: 1 } }),
        strings,
      ),
    ).toBeUndefined();
    expect(costLine("broken", strings)).toBeUndefined();
  });

  it("keeps the previous reading for whatever did not arrive this round", () => {
    const first = traySummary(
      null,
      {
        usage: SNAPSHOT,
        cost: JSON.stringify({ status: "ok", today: { costUsd: 2 } }),
      },
      strings,
    );
    expect(first?.cost).toBe("Today $2.00");
    const stale = traySummary(first, { usage: null, cost: null }, strings);
    expect(stale).toBe(first);
    const partial = traySummary(
      first,
      { usage: null, cost: "broken" },
      strings,
    );
    expect(partial).toBe(first);
    const next = traySummary(
      first,
      { usage: JSON.stringify({ providers: [] }), cost: null },
      strings,
    );
    expect(next).toEqual({ providers: [], cost: "Today $2.00" });
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
