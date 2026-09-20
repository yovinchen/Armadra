import { describe, expect, it } from "vitest";
import { SessionError, SessionTable } from "./sessions";

/**
 * The Rust unit tests of the pre-merge implementation, ported one for
 * one. The generation fence and the per-connection pause claim are the two
 * rules that decide whether a recycled agent writes into the wrong console
 * and whether a crashed frontend freezes a CLI, so they are the two rules
 * that are pinned rather than re-derived.
 */

const SIZE = { cols: 80, rows: 24 } as const;

function table(): SessionTable {
  const built = new SessionTable();
  built.create("node-a", 1, "ws", "C:\\src", SIZE);
  return built;
}

function refusal(action: () => unknown): SessionError {
  try {
    action();
  } catch (error) {
    if (error instanceof SessionError) return error;
    throw error;
  }
  throw new Error("expected a refusal, got none");
}

describe("session table", () => {
  it("starts a new session running with nobody watching", () => {
    const entry = table().get("node-a");
    expect(entry?.state.kind).toBe("running");
    expect(entry?.subscriberCount).toBe(0);
    expect(entry?.paused).toBe(false);
  });

  /**
   * The point of the whole process: no subscribers is the normal state, not a
   * reason to stop anything.
   */
  it("does not confuse no subscribers with no session", () => {
    const built = table();
    built.attach("node-a", 1, 7, SIZE);
    expect(built.detach("node-a", 7)).toBe(true);
    expect(built.get("node-a")?.subscriberCount).toBe(0);
    expect(built.get("node-a")?.state.kind).toBe("running");
    expect(built.allOver).toBe(false);
  });

  it("refuses a create over a running session rather than taking it over", () => {
    const built = table();
    const error = refusal(() =>
      built.create("node-a", 2, "ws", "C:\\src", SIZE),
    );
    expect(error.code).toBe("conflict");
    expect(built.get("node-a")?.generation).toBe(1);
  });

  it("needs a newer generation for a recycle than the session it replaces", () => {
    const built = table();
    built.markExited("node-a", 1, 0);
    expect(
      refusal(() => built.create("node-a", 1, "ws", "C:\\src", SIZE)).code,
    ).toBe("stale");
    built.create("node-a", 2, "ws", "C:\\src", SIZE);
    expect(built.get("node-a")?.generation).toBe(2);
    expect(built.get("node-a")?.state.kind).toBe("running");
  });

  it("does not accept zero as a generation", () => {
    const built = new SessionTable();
    expect(refusal(() => built.create("x", 0, "ws", "/", SIZE)).code).toBe(
      "badRequest",
    );
  });

  /** The fence: a caller holding an old generation is told so, not served. */
  it("refuses a stale generation and reports an unknown key as not found", () => {
    const built = table();
    expect(built.current("node-a", 1).generation).toBe(1);
    expect(refusal(() => built.current("node-a", 2)).code).toBe("stale");
    expect(refusal(() => built.current("node-b", 1)).code).toBe("notFound");
  });

  it("cannot be attached to after the session ended", () => {
    const built = table();
    expect(built.markExited("node-a", 1, 3)).toBe(true);
    expect(
      built.markExited("node-a", 1, 0),
      "the second report of the same exit changes nothing",
    ).toBe(false);
    expect(refusal(() => built.attach("node-a", 1, 1, SIZE)).code).toBe(
      "notFound",
    );
    const summary = built.summaries()[0];
    expect(summary?.exited).toBe(true);
    expect(summary?.exitCode).toBe(3);
    expect(built.allOver).toBe(true);
  });

  /**
   * Back pressure is owned by a connection, and repeating the claim must not
   * make it harder to release.
   */
  it("makes pausing idempotent per connection", () => {
    const built = table();
    built.attach("node-a", 1, 1, SIZE);
    built.attach("node-a", 1, 2, SIZE);

    expect(built.setFlow("node-a", 1, true), "first pause changes state").toBe(
      true,
    );
    expect(built.setFlow("node-a", 1, true), "repeat changes nothing").toBe(
      false,
    );
    expect(built.get("node-a")?.paused).toBe(true);

    expect(built.setFlow("node-a", 2, true), "already paused").toBe(false);
    expect(
      built.setFlow("node-a", 1, false),
      "connection 2 still holds it",
    ).toBe(false);
    expect(built.get("node-a")?.paused).toBe(true);
    expect(built.setFlow("node-a", 2, false)).toBe(true);
    expect(built.get("node-a")?.paused).toBe(false);
  });

  /** The one that keeps a crashed frontend from freezing a CLI forever. */
  it("releases the pause a disconnecting connection was holding", () => {
    const built = table();
    built.attach("node-a", 1, 5, SIZE);
    built.setFlow("node-a", 5, true);
    expect(built.get("node-a")?.paused).toBe(true);

    expect(built.disconnect(5)).toEqual(["node-a"]);
    expect(built.get("node-a")?.paused).toBe(false);
    expect(built.get("node-a")?.subscriberCount).toBe(0);
    expect(built.disconnect(5)).toEqual([]);
  });

  it("gives the most recent attach the size", () => {
    const built = table();
    built.attach("node-a", 1, 1, { cols: 200, rows: 60 });
    built.attach("node-a", 1, 2, { cols: 60, rows: 20 });
    expect(built.get("node-a")?.size).toEqual({ cols: 60, rows: 20 });
    expect(built.get("node-a")?.subscriberCount).toBe(2);
  });

  it("numbers output frames gaplessly from one", () => {
    const entry = table().get("node-a");
    expect([1, 2, 3, 4].map(() => entry?.takeSequence())).toEqual([1, 2, 3, 4]);
  });

  it("refuses new sessions while draining without touching the old ones", () => {
    const built = table();
    built.drain();
    expect(built.draining).toBe(true);
    expect(refusal(() => built.create("node-b", 1, "ws", "/", SIZE)).code).toBe(
      "draining",
    );
    expect(built.get("node-a")?.state.kind).toBe("running");
    expect(built.drained, "a running session is still a reason to stay").toBe(
      false,
    );
    built.markExited("node-a", 1, 0);
    expect(built.drained).toBe(true);
  });

  it("lists stably, so a reconciling core sees no shuffling", () => {
    const built = new SessionTable();
    for (const key of ["node-c", "node-a", "node-b"]) {
      built.create(key, 1, "ws", "/", SIZE);
    }
    const keys = built.summaries().map((summary) => summary.sessionKey);
    expect(keys).toEqual(["node-a", "node-b", "node-c"]);
    expect(built.summaries().map((summary) => summary.sessionKey)).toEqual(
      keys,
    );
  });

  it("clamps a size that is not a console", () => {
    const built = new SessionTable();
    const entry = built.create("x", 1, "ws", "/", { cols: 0, rows: 99_999 });
    expect(entry.size).toEqual({ cols: 2, rows: 1000 });
  });
});
