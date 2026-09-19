import { describe, expect, it } from "vitest";
import { LifecycleState } from "./lifecycle-state";

/** The Rust shell's own lifecycle-state assertions. */
describe("desktop lifecycle", () => {
  it("never requests a service shutdown when the foreground closes", () => {
    const state = new LifecycleState();
    state.hide();
    expect(state.shouldShow()).toBe(false);
    expect(state.isQuitting()).toBe(false);
    expect(state.canExit()).toBe(false);
    expect(state.reveal()).toBe(true);
    expect(state.shouldShow()).toBe(true);
  });

  it("makes quit single-flight and only lets completion permit exit", () => {
    const state = new LifecycleState();
    expect(state.beginQuit()).toBe(true);
    expect(state.beginQuit()).toBe(false);
    expect(state.reveal()).toBe(false);
    expect(state.canExit()).toBe(false);
    state.quitFailed();
    expect(state.beginQuit()).toBe(true);
    state.quitCompleted();
    expect(state.canExit()).toBe(true);
    expect(state.shouldShow()).toBe(false);
  });

  it("walks running → stopping → stopped and back on failure", () => {
    const state = new LifecycleState();
    expect(state.current()).toBe("running");
    state.beginQuit();
    expect(state.current()).toBe("stopping");
    state.quitFailed();
    expect(state.current()).toBe("running");
    // A window hidden before the failed quit is shown again by reveal(), which
    // only now answers true.
    state.hide();
    expect(state.reveal()).toBe(true);
    state.beginQuit();
    state.quitCompleted();
    expect(state.current()).toBe("stopped");
    // A completed quit is terminal: nothing restarts it.
    expect(state.beginQuit()).toBe(false);
    expect(state.reveal()).toBe(false);
  });
});
