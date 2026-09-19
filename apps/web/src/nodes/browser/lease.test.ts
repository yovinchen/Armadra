import { describe, expect, it } from "vitest";
import type { BrowserLease } from "@armadra/shared";

import { controllerKey, sinceLabel } from "./Lease";
import { bandwidthClass, renewDelay } from "./geometry";
import { nextStreamDelay } from "./stream";

const held = (
  state: BrowserLease["state"],
  holder?: BrowserLease["holder"],
): BrowserLease => ({
  state,
  generation: 3,
  expiresAt: "",
  ...(holder ? { holder } : {}),
});

describe("controllerKey", () => {
  it("tells this device apart from another one", () => {
    const mine = held("human", { kind: "human", id: "d-1", displayName: "" });
    expect(controllerKey(mine, "d-1").key).toBe("browser.lease.you");
    expect(controllerKey(mine, "d-2").key).toBe("browser.lease.otherDevice");
  });

  it("names the agent so the badge says which one", () => {
    const lease = held("agent", {
      kind: "agent",
      id: "n-7",
      displayName: "Claude",
    });
    expect(controllerKey(lease, "d-1")).toEqual({
      key: "browser.lease.agent",
      name: "Claude",
    });
  });

  it("says nobody is driving for a free lease, however it arrives", () => {
    expect(controllerKey(undefined, "d-1").key).toBe("browser.lease.free");
    expect(controllerKey(held("free"), "d-1").key).toBe("browser.lease.free");
    // A holder-less `human` cannot be attributed, so it is not claimed to be
    // this device.
    expect(controllerKey(held("human"), "d-1").key).toBe("browser.lease.free");
  });
});

describe("sinceLabel", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");
  it("counts in seconds, then minutes, then hours", () => {
    expect(sinceLabel("2026-09-06T11:59:58Z", now)).toBe("2s");
    expect(sinceLabel("2026-09-06T11:57:00Z", now)).toBe("3m");
    expect(sinceLabel("2026-09-06T10:00:00Z", now)).toBe("2h");
  });

  it("says nothing rather than NaN for a timestamp it cannot read", () => {
    expect(sinceLabel("not a time", now)).toBe("");
  });

  it("never counts backwards when a clock is a little ahead", () => {
    expect(sinceLabel("2026-09-06T12:00:05Z", now)).toBe("0s");
  });
});

describe("bandwidthClass", () => {
  it("honours the user's own save-data choice above anything inferred", () => {
    expect(bandwidthClass({ hostname: "127.0.0.1" }, { saveData: true })).toBe(
      "metered",
    );
  });

  it("treats loopback as LAN and everything else as WAN", () => {
    expect(bandwidthClass({ hostname: "127.0.0.1" }, undefined)).toBe("lan");
    expect(bandwidthClass({ hostname: "localhost" }, undefined)).toBe("lan");
    expect(bandwidthClass({ hostname: "[::1]" }, undefined)).toBe("lan");
    // Reached through the Host from a phone: not on this machine.
    expect(bandwidthClass({ hostname: "mac.local" }, undefined)).toBe("wan");
    expect(bandwidthClass({ hostname: "192.168.1.9" }, undefined)).toBe("wan");
  });
});

describe("reconnect and renewal timing", () => {
  it("backs the stream off exponentially and then holds", () => {
    expect(nextStreamDelay(null)).toBe(500);
    expect(nextStreamDelay(500)).toBe(1_000);
    expect(nextStreamDelay(4_000)).toBe(5_000);
    expect(nextStreamDelay(5_000)).toBe(5_000);
  });

  it("renews a subscription before it lapses, and guesses safely otherwise", () => {
    const now = Date.parse("2026-09-06T12:00:00Z");
    expect(renewDelay("2026-09-06T12:00:15Z", now)).toBe(10_000);
    // Already lapsed: retry at the floor rather than immediately in a loop.
    expect(renewDelay("2026-09-06T11:59:00Z", now)).toBe(1_000);
    expect(renewDelay("nonsense", now)).toBe(30_000);
  });
});
