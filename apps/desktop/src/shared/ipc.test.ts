import { describe, expect, it } from "vitest";
import {
  ALL_CHANNELS,
  IMPLEMENTED_CHANNELS,
  IPC,
  NOT_IMPLEMENTED,
  ipcError,
} from "./ipc";

/**
 * The table is the contract three processes share, so the properties that make
 * it usable are asserted rather than assumed.
 */
describe("the IPC table", () => {
  it("has no duplicate channel names", () => {
    const names = ALL_CHANNELS.map((spec) => spec.channel);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names every channel `domain:action`", () => {
    for (const spec of ALL_CHANNELS) {
      expect(spec.channel, spec.channel).toMatch(/^[a-z]+:[a-z-]+$/);
    }
  });

  it("records a reach for every channel", () => {
    for (const spec of ALL_CHANNELS) {
      expect(["window", "shared"], spec.channel).toContain(spec.reach);
    }
  });

  it("only claims channels that exist as implemented", () => {
    const declared = new Set(ALL_CHANNELS.map((spec) => spec.channel));
    for (const channel of IMPLEMENTED_CHANNELS)
      expect(declared.has(channel), channel).toBe(true);
  });

  it("implements exactly the channels the batches so far promised", () => {
    expect([...IMPLEMENTED_CHANNELS].sort()).toEqual(
      [
        // W1.0 / W1.1
        "app:locale",
        "transport:endpoints",
        "window:is-focused",
        // W2.2: the seven update commands
        "updates:cancel",
        "updates:check",
        "updates:dismiss",
        "updates:download",
        "updates:install",
        "updates:restart-report",
        "updates:state",
      ].sort(),
    );
  });

  it("covers every domain the migration design §2.2 lists", () => {
    const domains = new Set(
      ALL_CHANNELS.map((spec) => spec.channel.split(":")[0]),
    );
    expect([...domains].sort()).toEqual([
      "app",
      "browser",
      "dialog",
      "shell",
      "shortcuts",
      "transport",
      "updates",
      "window",
    ]);
  });

  it("keeps the seven update commands and their progress event", () => {
    const updates = ALL_CHANNELS.filter((spec) =>
      spec.channel.startsWith("updates:"),
    );
    expect(updates.filter((spec) => spec.direction === "invoke")).toHaveLength(
      7,
    );
    expect(updates.filter((spec) => spec.direction === "event")).toHaveLength(
      1,
    );
    expect(IPC.updatesProgress.direction).toBe("event");
  });

  it("shapes an error as { code, message }", () => {
    expect(ipcError(NOT_IMPLEMENTED, "later")).toEqual({
      code: "not_implemented",
      message: "later",
    });
  });
});
