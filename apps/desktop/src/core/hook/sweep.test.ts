import { afterEach, describe, expect, it } from "vitest";
import {
  type HookFixture,
  hookFixture,
  insertSession,
  minutesAgo,
} from "./fixture";
import { sweepOnce } from "./sweep";

/** The silence sweep and the dead-terminal close-out. */

let open: HookFixture[] = [];

function fixture(): HookFixture {
  const made = hookFixture();
  open.push(made);
  return made;
}

afterEach(() => {
  for (const one of open) one.close();
  open = [];
});

function ageTheReport(one: HookFixture, minutes: number): void {
  one.core.database
    .prepare("UPDATE agent_status SET last_event_at = ? WHERE node_id = ?")
    .run(minutesAgo(minutes), one.nodeId);
}

type AnyStatus = Record<string, unknown>;

function statuses(one: HookFixture): AnyStatus[] {
  return one.published
    .filter(
      (event): event is { type: "agent.status"; status: AnyStatus } =>
        event.type === "agent.status",
    )
    .map((event) => event.status);
}

describe("the stale sweeps", () => {
  it("closes a node that stopped reporting", async () => {
    const one = fixture();
    await one.report({ hook_event_name: "UserPromptSubmit" });
    expect(one.status()?.state).toBe("working");

    // Nothing to do while the report is fresh.
    expect(sweepOnce(one.context)).toBe(0);

    ageTheReport(one, 21);
    one.published.length = 0;
    expect(sweepOnce(one.context)).toBe(1);
    const status = one.status();
    expect(status?.state).toBe("done");
    expect(status?.unread).toBe(true);
    expect(statuses(one).at(-1)?.lastMessage).toContain("stale=true");

    // A closed node is not swept twice.
    expect(sweepOnce(one.context)).toBe(0);
  });

  /**
   * A terminal killed mid-turn leaves a node that will never report again. The
   * CLI gets no chance to fire `Stop` (SIGKILL runs no hooks), so without this
   * the node claims RUNNING until the 20-minute silence sweep notices.
   */
  it("closes out a node whose terminal died", async () => {
    const one = fixture();
    insertSession(one, { id: "sess-1", status: "running" });

    await one.report({ hook_event_name: "UserPromptSubmit" });
    expect(one.status()?.state).toBe("working");
    // While the terminal lives, the sweep leaves it alone.
    expect(sweepOnce(one.context)).toBe(0);

    // The user kills it. A `Stop` may still be in flight, so the grace window
    // holds the sweep off rather than racing the real report.
    one.core.database
      .prepare(
        "UPDATE terminal_sessions SET status = 'terminated', ended_at = ? WHERE id = 'sess-1'",
      )
      .run(new Date().toISOString());
    expect(
      sweepOnce(one.context),
      "a just-ended terminal is given time to report its own Stop",
    ).toBe(0);

    one.core.database
      .prepare("UPDATE terminal_sessions SET ended_at = ? WHERE id = 'sess-1'")
      .run(minutesAgo(1));

    one.published.length = 0;
    expect(sweepOnce(one.context)).toBe(1);
    const status = one.status();
    expect(status?.state).toBe("done");
    // A plain clean end. `interrupted` stays false: it means the *user*
    // stopped the agent, and overloading it here would make PAUSED mean two
    // things.
    expect(status?.interrupted).toBe(false);
    expect(status?.errored).toBe(false);
    // No badge — the terminal's own exit already says what happened.
    expect(status?.unread).toBe(false);
    // No hook presented a token for a synthetic close, so the row is honestly
    // unverified.
    expect(status?.verified).toBe(false);

    const published = statuses(one).at(-1);
    expect(published?.interrupted).toBe(false);
    expect(published?.unread).toBe(false);
    // The cause travels in the marker, which a client can match on.
    expect(String(published?.lastMessage).startsWith("terminated=true")).toBe(
      true,
    );
    // Closed once, not on every tick.
    expect(sweepOnce(one.context)).toBe(0);
  });

  /**
   * The close-out raises no badge, but it must not take one down either:
   * output from an earlier finished turn is still unread, and only the read
   * receipt says the user looked at it.
   */
  it("leaves an earlier unread turn alone when closing a dead terminal", async () => {
    const one = fixture();
    insertSession(one, {
      id: "sess-1",
      status: "exited",
      endedAt: minutesAgo(5),
    });

    // A turn finished and nobody read it, then a second turn started and the
    // terminal died under it.
    await one.report({ hook_event_name: "UserPromptSubmit" });
    await one.report({ hook_event_name: "Stop" });
    expect(one.status()?.unread).toBe(true);
    await one.report({ hook_event_name: "UserPromptSubmit" });

    expect(sweepOnce(one.context)).toBe(1);
    const status = one.status();
    expect(status?.state).toBe("done");
    expect(
      status?.unread,
      "the first turn's output is still unread; the close-out must not hide it",
    ).toBe(true);
  });

  /** The two guards that keep the query from closing nodes it should not. */
  it("leaves other nodes alone in the dead-terminal sweep", async () => {
    const one = fixture();

    // 1. A node with no session at all: the CLI may be running in a terminal
    //    the user opened themselves, having exported ARMADRA_NODE_ID.
    await one.report({ hook_event_name: "UserPromptSubmit" });
    expect(
      sweepOnce(one.context),
      "a node without a session is not ours to close",
    ).toBe(0);
    expect(one.status()?.state).toBe("working");

    // 2. A recycled node: the old session ended long ago, but a newer one runs.
    insertSession(one, {
      id: "sess-old",
      status: "exited",
      endedAt: minutesAgo(5),
    });
    insertSession(one, { id: "sess-new", status: "running" });
    expect(
      sweepOnce(one.context),
      "one live session keeps the node alive however many dead ones it has",
    ).toBe(0);
    expect(one.status()?.state).toBe("working");

    // 3. An already-finished node is not closed twice.
    await one.report({ hook_event_name: "Stop" });
    one.core.database
      .prepare(
        "UPDATE terminal_sessions SET status = 'exited', ended_at = ? WHERE id = 'sess-new'",
      )
      .run(minutesAgo(5));
    expect(sweepOnce(one.context)).toBe(0);
    const status = one.status();
    expect(status?.interrupted).toBe(false);
    expect(
      status?.unread,
      "the real Stop stands with its badge; no silent close overwrote it",
    ).toBe(true);
  });

  /**
   * Neither `agent_status` nor `terminal_sessions` has a foreign key to
   * `nodes`, so both rows survive a node the user deleted from the canvas.
   * Sweeping one would publish an `agent.status` for something no client can
   * show.
   */
  it("speaks for a deleted node in neither sweep", async () => {
    const one = fixture();
    insertSession(one, {
      id: "sess-1",
      status: "exited",
      endedAt: minutesAgo(5),
    });
    await one.report({ hook_event_name: "UserPromptSubmit" });

    one.core.database.prepare("DELETE FROM nodes WHERE id = ?").run(one.nodeId);
    // Old enough for the silence sweep too, so both queries are exercised.
    ageTheReport(one, 30);

    one.published.length = 0;
    expect(sweepOnce(one.context)).toBe(0);
    expect(
      one.published,
      "no frame for a node that is not on the canvas",
    ).toHaveLength(0);
    // The orphan row is left as it was rather than rewritten.
    expect(one.status()?.state).toBe("working");
  });
});
