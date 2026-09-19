import { afterEach, describe, expect, it, vi } from "vitest";
import { LIFECYCLE_EVENTS, traceLifecycle } from "./trace";

/**
 * The trace is off unless asked for, and its event names are the Tauri shell's
 * word for word — during the migration a trace from either shell has to be
 * comparable against the other.
 */
describe("the lifecycle trace", () => {
  const original = process.env.ARMADRA_DESKTOP_LIFECYCLE_TRACE;

  afterEach(() => {
    if (original === undefined)
      delete process.env.ARMADRA_DESKTOP_LIFECYCLE_TRACE;
    else process.env.ARMADRA_DESKTOP_LIFECYCLE_TRACE = original;
    vi.restoreAllMocks();
  });

  it("writes nothing unless the variable is exactly 1", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    for (const value of [undefined, "", "0", "true", "yes"]) {
      if (value === undefined)
        delete process.env.ARMADRA_DESKTOP_LIFECYCLE_TRACE;
      else process.env.ARMADRA_DESKTOP_LIFECYCLE_TRACE = value;
      traceLifecycle("setup");
    }
    expect(write).not.toHaveBeenCalled();
  });

  it("writes one line naming the process and the event", () => {
    process.env.ARMADRA_DESKTOP_LIFECYCLE_TRACE = "1";
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    traceLifecycle("exit requested; stopping services");
    expect(write).toHaveBeenCalledWith(
      `Desktop lifecycle ${process.pid}: exit requested; stopping services\n`,
    );
  });

  it("keeps the Tauri shell's event vocabulary", () => {
    // `src-tauri/src/main.rs` traces exactly these, in this wording.
    expect(LIFECYCLE_EVENTS).toEqual([
      "setup",
      "ready",
      "enter event loop",
      "foreground close requested",
      "reopen",
      "exit requested; stopping services",
      "exit",
      "event loop returned",
    ]);
  });
});
