import { describe, expect, it } from "vitest";
import type { BrowserLease } from "@armadra/shared";

import { controllerKey, sinceLabel } from "./Lease";

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
