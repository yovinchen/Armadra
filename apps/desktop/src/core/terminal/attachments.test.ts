import { describe, expect, it } from "vitest";
import { AttachmentBook } from "./attachments";

/**
 * The dormancy budget, on a clock the test owns.
 *
 * Every assertion here is about a *deadline*, and a suite that reached them by
 * sleeping would take minutes and still be flaky. The clock is injected for
 * that reason and for no other.
 */

function book(): { book: AttachmentBook; advance: (ms: number) => void } {
  let now = 1_000_000;
  return {
    book: new AttachmentBook(() => now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("the attachment ledger", () => {
  /**
   * A terminal that is created and never opened — a scripted spawn, a node
   * restored off-screen — must be eligible for dormancy. Registering at create
   * time rather than on the first attach is what makes that true.
   */
  it("starts a session's idle clock at creation, not at the first attach", () => {
    const { book: entries, advance } = book();
    entries.register("s1");
    advance(60_000);
    expect(entries.due(30_000)).toEqual(["s1"]);
  });

  it("is never due while a socket is watching", () => {
    const { book: entries, advance } = book();
    entries.register("s1");
    entries.acquire("s1");
    advance(10 * 60_000);
    expect(entries.due(1_000)).toEqual([]);
  });

  /**
   * The behaviour the acceptance criterion names: attaching once resets the
   * idle clock to nothing, so the deadline is measured from the *detach*, not
   * from the attach and not from creation.
   */
  it("restarts the clock from the detach, not from the attach", () => {
    const { book: entries, advance } = book();
    entries.register("s1");
    advance(60_000);
    entries.acquire("s1");
    advance(60_000);
    entries.release("s1");
    advance(20_000);
    expect(entries.due(30_000)).toEqual([]);
    advance(11_000);
    expect(entries.due(30_000)).toEqual(["s1"]);
  });

  it("counts several sockets and only idles when the last one goes", () => {
    const { book: entries, advance } = book();
    entries.register("s1");
    entries.acquire("s1");
    entries.acquire("s1");
    entries.release("s1");
    expect(entries.sockets("s1")).toBe(1);
    advance(60_000);
    expect(entries.due(1_000)).toEqual([]);
    entries.release("s1");
    advance(2_000);
    expect(entries.due(1_000)).toEqual(["s1"]);
  });

  /**
   * The socket handler has several ways out and the close path may run twice.
   * A release that could go negative would leave a session counted as watched
   * for ever after the next attach.
   */
  it("survives a double release without going negative", () => {
    const { book: entries } = book();
    entries.register("s1");
    entries.acquire("s1");
    entries.release("s1");
    entries.release("s1");
    expect(entries.sockets("s1")).toBe(0);
  });

  it("reports a dormant session once, so waking costs one backend call", () => {
    const { book: entries, advance } = book();
    entries.register("s1");
    advance(60_000);
    expect(entries.due(30_000)).toEqual(["s1"]);
    entries.markDormant("s1");
    expect(entries.isDormant("s1")).toBe(true);
    // Already asleep: the sweep does not keep asking.
    expect(entries.due(30_000)).toEqual([]);
    expect(entries.takeDormant("s1")).toBe(true);
    expect(entries.takeDormant("s1")).toBe(false);
  });

  /**
   * `markDormant` runs after an `await` on the backend. A socket that arrived
   * during that await has to win, or the page's first frames would be
   * delivered at half-second cadence.
   */
  it("refuses to fall asleep under a socket that arrived meanwhile", () => {
    const { book: entries } = book();
    entries.register("s1");
    entries.acquire("s1");
    entries.markDormant("s1");
    expect(entries.isDormant("s1")).toBe(false);
  });
});
