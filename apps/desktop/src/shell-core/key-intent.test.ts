import { describe, expect, it } from "vitest";

import { KEY_INTENT_REPLY_TIMEOUT_MS, KeyIntentArbiter } from "./key-intent";

/**
 * The rule every case here exists for: **⌘W must never become a key that does
 * nothing.** Every path through the arbiter either lets the page act or makes
 * the shell act; none of them ends in silence.
 */

describe("a claimed chord waiting for the page", () => {
  it("lets the page take it, and then the shell does nothing", () => {
    const arbiter = new KeyIntentArbiter();
    const token = arbiter.open("close-window");
    expect(arbiter.settle(token, true)).toEqual({
      verdict: "page",
      intent: "close-window",
    });
    expect(arbiter.waiting()).toBe(0);
  });

  it("falls to the shell when the page had nothing to close", () => {
    const arbiter = new KeyIntentArbiter();
    const token = arbiter.open("close-window");
    expect(arbiter.settle(token, false)).toEqual({
      verdict: "shell",
      intent: "close-window",
    });
  });

  it("falls to the shell when the page never answers", () => {
    // The timeout is the caller's timer calling `settle(token, false)`; a page
    // that crashed, or an older build that never subscribed, must still close
    // the window.
    const arbiter = new KeyIntentArbiter();
    const token = arbiter.open("close-window");
    expect(arbiter.settle(token, false).verdict).toBe("shell");
  });

  it("treats anything that is not `true` as not handled", () => {
    // The value crossed an IPC boundary; it is not to be trusted to be a
    // boolean, and a page answering junk must not leave the chord unanswered.
    for (const value of ["true", 1, {}, null, undefined]) {
      const arbiter = new KeyIntentArbiter();
      const token = arbiter.open("close-window");
      expect(arbiter.settle(token, value).verdict, JSON.stringify(value)).toBe(
        "shell",
      );
    }
  });
});

describe("the token", () => {
  it("answers exactly once — a late reply cannot act on a settled chord", () => {
    // The race this prevents: the timer fires and hides the window, then the
    // page's answer arrives and would hide it a second time.
    const arbiter = new KeyIntentArbiter();
    const token = arbiter.open("close-window");
    expect(arbiter.settle(token, false).verdict).toBe("shell");
    expect(arbiter.settle(token, true)).toEqual({
      verdict: "stale",
      intent: null,
    });
  });

  it("is never one a token from another chord could match", () => {
    const arbiter = new KeyIntentArbiter();
    expect(arbiter.open("close-window")).not.toBe(arbiter.open("close-window"));
    expect(arbiter.waiting()).toBe(2);
  });

  it("refuses anything the page invented", () => {
    const arbiter = new KeyIntentArbiter();
    arbiter.open("close-window");
    for (const value of ["intent-99", "", 7, null, undefined])
      expect(arbiter.settle(value, true).verdict, JSON.stringify(value)).toBe(
        "stale",
      );
    // …and left the real one still waiting.
    expect(arbiter.waiting()).toBe(1);
  });
});

describe("the wait", () => {
  it("is short enough that a silent page is a slow close, not a broken key", () => {
    expect(KEY_INTENT_REPLY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(KEY_INTENT_REPLY_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
  });
});
