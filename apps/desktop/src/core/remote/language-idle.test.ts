import { describe, expect, it } from "vitest";
import { LanguageIdle } from "./language-idle";

function harness(sessions: Map<string, number>) {
  let now = 0;
  const closed: string[] = [];
  const live = new Set(sessions.keys());
  const idle = new LanguageIdle({
    live: () => [...live],
    sessions: async (hostId) => {
      const count = sessions.get(hostId);
      if (count === undefined) throw new Error("gone");
      return count;
    },
    close: (hostId) => {
      closed.push(hostId);
      live.delete(hostId);
    },
    idleMs: 10_000,
    now: () => now,
  });
  return {
    idle,
    closed,
    live,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("the language link idle close", () => {
  it("closes a link only after it has had no session for the whole window", async () => {
    const sessions = new Map([
      ["far", 0],
      ["busy", 2],
    ]);
    const { idle, closed, advance } = harness(sessions);
    await idle.check();
    expect(closed).toEqual([]);
    advance(9_000);
    await idle.check();
    expect(closed).toEqual([]);
    advance(1_000);
    await idle.check();
    // 有会话的那台一直不关。
    expect(closed).toEqual(["far"]);
  });

  it("counts a language request as activity, and a session as resetting the clock", async () => {
    const sessions = new Map([["far", 0]]);
    const { idle, closed, advance } = harness(sessions);
    await idle.check();
    advance(8_000);
    idle.touch("far");
    advance(8_000);
    await idle.check();
    expect(closed).toEqual([]);
    sessions.set("far", 1);
    advance(5_000);
    await idle.check();
    sessions.set("far", 0);
    await idle.check();
    advance(9_000);
    await idle.check();
    expect(closed).toEqual([]);
    advance(1_000);
    await idle.check();
    expect(closed).toEqual(["far"]);
  });

  it("leaves a link alone when it cannot ask", async () => {
    const sessions = new Map<string, number>();
    const { idle, closed, live, advance } = harness(sessions);
    live.add("mute");
    await idle.check();
    advance(60_000);
    await idle.check();
    expect(closed).toEqual([]);
  });
});
