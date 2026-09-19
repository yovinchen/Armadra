import { describe, expect, it } from "vitest";
import {
  MAX_RELOADS,
  WINDOW_MS,
  createCrashReloadPolicy,
} from "./crash-reload";

describe("the crash reload policy", () => {
  it("reloads the first crashes and then stops", () => {
    const policy = createCrashReloadPolicy();
    expect(policy.shouldReload("crashed", 0)).toBe(true);
    expect(policy.shouldReload("crashed", 1_000)).toBe(true);
    expect(MAX_RELOADS).toBe(2);
    // The third inside the window is a loop, not an accident.
    expect(policy.shouldReload("crashed", 2_000)).toBe(false);
    expect(policy.shouldReload("crashed", 3_000)).toBe(false);
  });

  it("forgives once the window has passed", () => {
    const policy = createCrashReloadPolicy();
    policy.shouldReload("crashed", 0);
    policy.shouldReload("crashed", 1_000);
    expect(policy.shouldReload("crashed", 2_000)).toBe(false);
    // An hour later, a crash is an accident again.
    expect(policy.shouldReload("crashed", 2_000 + WINDOW_MS + 1)).toBe(true);
  });

  it("does not count a clean exit against the budget", () => {
    const policy = createCrashReloadPolicy();
    for (const now of [0, 1, 2, 3, 4])
      expect(policy.shouldReload("clean-exit", now)).toBe(false);
    // Quitting the app must not leave the next crash one reload poorer.
    expect(policy.shouldReload("crashed", 5)).toBe(true);
    expect(policy.shouldReload("crashed", 6)).toBe(true);
    expect(policy.shouldReload("crashed", 7)).toBe(false);
  });

  it("gives each policy its own history", () => {
    const first = createCrashReloadPolicy();
    const second = createCrashReloadPolicy();
    first.shouldReload("crashed", 0);
    first.shouldReload("crashed", 0);
    expect(first.shouldReload("crashed", 0)).toBe(false);
    expect(second.shouldReload("crashed", 0)).toBe(true);
  });
});
