import { describe, expect, it } from "vitest";
import {
  type AgentEvent,
  BLOCKED,
  DONE,
  WAITING,
  WORKING,
  newEvent,
  serializeEvent,
  stateEvent,
} from "./normalize";
import {
  type Current,
  type Memory,
  type SessionKeep,
  emptyCurrent,
  newMemory,
  reduce,
  sessionKeep,
  staleEvent,
  terminalGoneEvent,
} from "./reduce";

/**
 * The state machine in `hook/reduce`, driven directly.
 *
 * These are unit tests rather than route tests: the reducer's invariants are
 * about *ordering and timing*, and expressing "this event landed 20 ms after
 * that one" is only honest with the clock in hand.
 */

const EPOCH = 1_800_000_000_000;

function at(seconds: number): number {
  return EPOCH + seconds * 1000;
}

/**
 * The same clock in milliseconds. Copilot's session events sit 10-20 ms from
 * the state event they belong to, and a second-resolution helper cannot say
 * that at all.
 */
function atMs(millis: number): number {
  return EPOCH + millis;
}

/** A Copilot `sessionStart`, optionally the kind its first prompt creates. */
function sessionStart(sessionId: string, openedByPrompt: boolean): AgentEvent {
  const event = newEvent("n", "copilot", "session");
  event.sessionPhase = "start";
  event.sessionId = sessionId;
  event.sessionOpenedByPrompt = openedByPrompt;
  return event;
}

function sessionEnd(sessionId: string): AgentEvent {
  const event = newEvent("n", "copilot", "session");
  event.sessionPhase = "end";
  event.sessionId = sessionId;
  return event;
}

function working(node: string): AgentEvent {
  return stateEvent(node, "claude", WORKING);
}

function current(state: string): Current {
  return { ...emptyCurrent(), state };
}

function memoryWith(partial: Partial<Memory>): Memory {
  return { ...newMemory(), ...partial };
}

describe("the agent state machine", () => {
  it("walks a plain turn from working to done and marks it unread", () => {
    const memory = newMemory();
    const event = working("n");
    event.newTurn = true;
    const first = reduce(at(0), emptyCurrent(), memory, event);
    expect(first?.state).toBe(WORKING);
    expect(first?.unread).toBe(false);

    const done = stateEvent("n", "claude", DONE);
    const next = reduce(at(1), current(WORKING), memory, done);
    expect(next?.state).toBe(DONE);
    // A finished node is unread until a client says otherwise.
    expect(next?.unread).toBe(true);
    expect(memory.doneAt).toBeDefined();
  });

  it("does not let a late working revive a just-finished turn", () => {
    const memory = memoryWith({ doneAt: at(0) });
    const finished: Current = {
      ...emptyCurrent(),
      state: DONE,
      unread: true,
    };
    // Inside the holdoff: dropped.
    expect(reduce(at(2), finished, memory, working("n"))).toBeUndefined();
    // A new turn is always allowed through, however soon it arrives.
    const fresh = working("n");
    fresh.newTurn = true;
    expect(reduce(at(2), finished, memory, fresh)?.state).toBe(WORKING);
    // Past the holdoff a plain working is real work again.
    const later = memoryWith({ doneAt: at(0) });
    expect(reduce(at(4), finished, later, working("n"))?.state).toBe(WORKING);
  });

  it("gives a restored done no holdoff", () => {
    // After a restart the row is old news: the first live report wins.
    const memory = memoryWith({ doneAt: at(0) });
    const restored: Current = {
      ...emptyCurrent(),
      state: DONE,
      restored: true,
    };
    expect(reduce(at(1), restored, memory, working("n"))?.state).toBe(WORKING);
  });

  it("fires the idle rescue only from working", () => {
    const idle = stateEvent("n", "claude", DONE);
    idle.idle = true;

    expect(reduce(at(0), current(WORKING), newMemory(), idle)?.state).toBe(
      DONE,
    );
    for (const state of [BLOCKED, WAITING, DONE]) {
      expect(
        reduce(at(0), current(state), newMemory(), idle),
        `idle must not touch ${state}`,
      ).toBeUndefined();
    }
    // A node that never reported has nothing to rescue either.
    expect(reduce(at(0), emptyCurrent(), newMemory(), idle)).toBeUndefined();
  });

  it("rewrites the done that ends a turn with an open question", () => {
    const memory = newMemory();
    const question = stateEvent("n", "claude", WAITING);
    question.awaitingInput = true;
    question.askKind = "AskUserQuestion";
    expect(reduce(at(0), current(WORKING), memory, question)?.state).toBe(
      WAITING,
    );
    expect(memory.awaitingInput).toBe(true);

    const done = stateEvent("n", "claude", DONE);
    const held = reduce(at(1), current(WAITING), memory, done);
    // The CLI is still sitting at a prompt.
    expect(held?.state).toBe(WAITING);
    expect(held?.unread).toBe(false);

    // The answer arrives as the next turn, which releases the hold.
    const answered = working("n");
    answered.newTurn = true;
    expect(reduce(at(2), current(WAITING), memory, answered)?.state).toBe(
      WORKING,
    );
    expect(memory.awaitingInput).toBe(false);

    const finished = reduce(at(3), current(WORKING), memory, done);
    expect(finished?.state).toBe(DONE);
    expect(finished?.unread).toBe(true);
  });

  it("stores the pending id when blocking and clears it on working", () => {
    const memory = newMemory();
    const blocked = stateEvent("n", "claude", BLOCKED);
    blocked.pendingId = "p-1";
    const next = reduce(at(0), current(WORKING), memory, blocked);
    expect(next?.state).toBe(BLOCKED);
    expect(next?.pendingId).toBe("p-1");

    const blockedNow: Current = {
      ...emptyCurrent(),
      state: BLOCKED,
      pendingId: "p-1",
    };
    const resumed = reduce(at(1), blockedNow, memory, working("n"));
    expect(resumed?.state).toBe(WORKING);
    // The approval was resolved.
    expect(resumed?.pendingId).toBeUndefined();
  });

  it("resets the machine on a session event", () => {
    const memory = memoryWith({ doneAt: at(0), awaitingInput: true });
    const session = newEvent("n", "claude", "session");
    session.sessionPhase = "start";
    session.sessionId = "s-2";
    session.transcriptPath = "/tmp/t.jsonl";
    const blockedNow: Current = {
      ...emptyCurrent(),
      state: BLOCKED,
      pendingId: "p-1",
      unread: true,
    };
    const next = reduce(at(1), blockedNow, memory, session);
    // A fresh session is idle, not done.
    expect(next?.state).toBeUndefined();
    expect(next?.pendingId).toBeUndefined();
    expect(next?.sessionId).toBe("s-2");
    expect(next?.transcriptPath).toBe("/tmp/t.jsonl");
    expect(next?.sessionPhase).toBe("start");
    // The reset does not read the badge for the user.
    expect(next?.unread).toBe(true);
    expect(memory.awaitingInput).toBe(false);
    expect(memory.doneAt).toBeUndefined();
  });

  it("never lets a subagent event touch the main state", () => {
    for (const kind of ["subagent-start", "subagent-end"] as const) {
      const memory = newMemory();
      const event = newEvent("n", "claude", kind);
      event.toolUseId = "tu-1";
      expect(reduce(at(0), current(WORKING), memory, event)).toBeUndefined();
      expect(memory.doneAt).toBeUndefined();
    }
  });

  /**
   * The source travels with the state it describes, which is what makes the
   * pair readable: a node drawn as `done` and a node drawn as `done
   * (observed)` are two different claims, and the second must not silently
   * become the first because a later report forgot to say.
   */
  it("carries the state source with the state it describes", () => {
    const memory = newMemory();
    const event = working("n");
    event.newTurn = true;
    event.stateSource = "hook";
    expect(reduce(at(0), emptyCurrent(), memory, event)?.stateSource).toBe(
      "hook",
    );

    // A synthetic close — the sweep, a dead terminal — names no channel, so
    // the row keeps the one that last reported. Blanking it here would make
    // every swept node look like one that never had an adapter.
    const reported: Current = {
      ...emptyCurrent(),
      state: WORKING,
      stateSource: "hook",
    };
    const swept = reduce(at(1), reported, memory, staleEvent("n", "claude"));
    expect(swept?.state).toBe(DONE);
    expect(swept?.stateSource).toBe("hook");

    // A CLI that changed channel says so, and the newer answer wins.
    const settled = stateEvent("n", "claude", DONE);
    settled.stateSource = "extension";
    expect(reduce(at(2), reported, memory, settled)?.stateSource).toBe(
      "extension",
    );

    // A session reset is still a report from the channel that sent it.
    const session = newEvent("n", "claude", "session");
    session.sessionPhase = "start";
    session.stateSource = "hook";
    const reset = reduce(at(3), reported, memory, session);
    expect(reset?.state).toBeUndefined();
    expect(reset?.stateSource).toBe("hook");
  });

  it("carries forward the facts an event is silent about", () => {
    const established: Current = {
      ...emptyCurrent(),
      state: WORKING,
      sessionId: "s-1",
      transcriptPath: "/tmp/a.jsonl",
    };
    const next = reduce(
      at(0),
      established,
      newMemory(),
      stateEvent("n", "claude", DONE),
    );
    expect(next?.sessionId).toBe("s-1");
    expect(next?.transcriptPath).toBe("/tmp/a.jsonl");
  });

  /**
   * Deliberate, and easy to "fix" by accident: a new turn does NOT clear the
   * unread badge. The badge means "this node produced something you have not
   * looked at", and starting another turn is not looking at it.
   */
  it("does not clear the unread badge on a new turn", () => {
    const memory = newMemory();
    const unseen: Current = { ...emptyCurrent(), state: DONE, unread: true };

    const fresh = working("n");
    fresh.newTurn = true;
    const next = reduce(at(10), unseen, memory, fresh);
    expect(next?.state).toBe(WORKING);
    expect(next?.unread).toBe(true);

    // Still unread through a whole second turn, and a second `done` keeps it
    // raised rather than double-counting it.
    const running: Current = {
      ...emptyCurrent(),
      state: WORKING,
      unread: true,
    };
    expect(
      reduce(at(11), running, memory, stateEvent("n", "claude", DONE))?.unread,
    ).toBe(true);

    // A node the user already read stays read until something finishes.
    const seen: Current = { ...emptyCurrent(), state: WORKING, unread: false };
    expect(reduce(at(12), seen, memory, working("n"))?.unread).toBe(false);
  });

  it("always gives a done a verdict and clears it on the next turn", () => {
    const memory = newMemory();

    // A plain Stop says the turn ended cleanly — not that we do not know.
    const clean = reduce(
      at(0),
      current(WORKING),
      memory,
      stateEvent("n", "claude", DONE),
    );
    expect(clean?.errored).toBe(false);
    expect(clean?.interrupted).toBe(false);

    // StopFailure and an Esc-interrupted turn are distinguishable.
    const failed = stateEvent("n", "claude", DONE);
    failed.errored = true;
    const failedNext = reduce(at(1), current(WORKING), memory, failed);
    expect(failedNext?.errored).toBe(true);
    expect(failedNext?.interrupted).toBe(false);

    const stopped = stateEvent("n", "claude", DONE);
    stopped.interrupted = true;
    const stoppedNext = reduce(at(2), current(WORKING), memory, stopped);
    expect(stoppedNext?.errored).toBe(false);
    expect(stoppedNext?.interrupted).toBe(true);

    // The verdict belongs to the turn that produced it: opening a new one
    // clears it, so the pill never shows TURN FAILED over live work.
    const failedNow: Current = {
      ...emptyCurrent(),
      state: DONE,
      errored: true,
      interrupted: true,
    };
    const fresh = working("n");
    fresh.newTurn = true;
    const resumed = reduce(at(6), failedNow, memory, fresh);
    expect(resumed?.state).toBe(WORKING);
    expect(resumed?.errored).toBeUndefined();
    expect(resumed?.interrupted).toBeUndefined();

    // So does a plain working, and a session reset.
    expect(
      reduce(at(7), failedNow, memory, working("n"))?.errored,
    ).toBeUndefined();
    const session = newEvent("n", "claude", "session");
    session.sessionPhase = "start";
    const reset = reduce(at(8), failedNow, memory, session);
    expect(reset?.errored).toBeUndefined();
    expect(reset?.interrupted).toBeUndefined();
  });

  it("keeps a verdict a report says nothing about", () => {
    // A late PostToolUse inside the holdoff is dropped entirely, so the
    // finished turn keeps its verdict; a blocked report carries it forward
    // rather than inventing a clean end.
    const failedNow: Current = {
      ...emptyCurrent(),
      state: DONE,
      errored: true,
      interrupted: false,
    };
    const memory = memoryWith({ doneAt: at(0) });
    expect(reduce(at(1), failedNow, memory, working("n"))).toBeUndefined();

    const blocked = stateEvent("n", "claude", BLOCKED);
    blocked.pendingId = "p-1";
    expect(reduce(at(5), failedNow, memory, blocked)?.errored).toBe(true);
  });

  it("gives an open question no verdict yet", () => {
    // Rule 3 rewrites the turn-ending `done` to `waiting`; that is not an
    // outcome, so the pill must not claim the turn finished cleanly.
    const memory = memoryWith({ awaitingInput: true });
    const next = reduce(
      at(0),
      current(WORKING),
      memory,
      stateEvent("n", "claude", DONE),
    );
    expect(next?.state).toBe(WAITING);
    expect(next?.errored).toBeUndefined();
    expect(next?.interrupted).toBeUndefined();
  });

  it("closes a dead terminal cleanly and raises no badge for it", () => {
    const event = terminalGoneEvent("n", "claude");
    expect(event.state).toBe(DONE);
    expect(event.errored).toBe(false);
    // `interrupted` means the user stopped the agent, not that the PTY died.
    expect(event.interrupted).toBe(false);
    expect(event.silent).toBe(true);
    expect(event.lastMessage?.startsWith("terminated=true")).toBe(true);
    // The control flag is ours alone: it must never appear on the wire, and
    // no hook client can set it.
    expect(serializeEvent(event).silent).toBeUndefined();

    const next = reduce(at(0), current(WORKING), newMemory(), event);
    expect(next?.state).toBe(DONE);
    // A dead terminal leaves nothing new to read.
    expect(next?.unread).toBe(false);

    // But it does not clear a badge an earlier turn raised.
    const unseen: Current = { ...emptyCurrent(), state: WORKING, unread: true };
    expect(reduce(at(1), unseen, newMemory(), event)?.unread).toBe(true);

    // The 20-minute silence sweep is the opposite case: the agent may well
    // have produced output before it went quiet, so that one does badge.
    expect(
      reduce(at(2), current(WORKING), newMemory(), staleEvent("n", "claude"))
        ?.unread,
    ).toBe(true);
  });

  it("closes a stuck turn on the sweep but still yields to a question", () => {
    const event = staleEvent("n", "claude");
    expect(event.state).toBe(DONE);
    expect(event.errored).toBe(false);
    expect(event.interrupted).toBe(false);
    expect(event.lastMessage).toContain("stale=true");

    const next = reduce(at(0), current(WORKING), newMemory(), event);
    expect(next?.state).toBe(DONE);
    expect(next?.unread).toBe(true);
    expect(next?.lastMessage).toContain("stale=true");
    // A swept turn did not fail and was not interrupted; it just stopped
    // talking, and `lastMessage` is where that is said.
    expect(next?.errored).toBe(false);
    expect(next?.interrupted).toBe(false);

    const waiting = memoryWith({ awaitingInput: true });
    expect(reduce(at(0), current(WORKING), waiting, event)?.state).toBe(
      WAITING,
    );
  });

  /**
   * Copilot CLI 1.0.83 creates the session *from* the first prompt, so its
   * `sessionStart` lands ~20 ms **after** that turn's `userPromptSubmitted`
   * and echoes the prompt back as `initialPrompt`. Rule 4 read that as a new
   * session and blanked the `working` the prompt had just written, which is
   * why a Copilot node showed no state at all through its first turn.
   */
  it("keeps the turn a session started by the prompt in flight belongs to", () => {
    const memory = newMemory();

    const prompt = stateEvent("n", "copilot", WORKING);
    prompt.newTurn = true;
    prompt.sessionId = "s-1";
    const opened = reduce(atMs(0), emptyCurrent(), memory, prompt);
    expect(opened?.state).toBe(WORKING);

    const started: Current = {
      ...emptyCurrent(),
      state: opened?.state,
      sessionId: opened?.sessionId,
    };
    const next = reduce(atMs(20), started, memory, sessionStart("s-1", true));
    // The start that opened this very turn must not reset it.
    expect(next?.state).toBe(WORKING);
    expect(next?.sessionPhase).toBe("start");
    expect(next?.sessionId).toBe("s-1");
    // The turn is still open, so its clock still runs.
    expect(memory.turnStartedAt).toBeDefined();
  });

  /**
   * The non-interactive `-p` shape: `sessionEnd` follows `agentStop` by ~10
   * ms. Resetting on it left a finished run with no state at all — neither the
   * `done` pill nor the unread badge survived.
   */
  it("keeps the done when the end follows the final stop", () => {
    const memory = newMemory();

    const prompt = stateEvent("n", "copilot", WORKING);
    prompt.newTurn = true;
    prompt.sessionId = "s-1";
    reduce(atMs(0), emptyCurrent(), memory, prompt);

    const workingNow: Current = {
      ...emptyCurrent(),
      state: WORKING,
      sessionId: "s-1",
    };
    const stop = stateEvent("n", "copilot", DONE);
    stop.sessionId = "s-1";
    const done = reduce(atMs(4000), workingNow, memory, stop);
    expect(done?.state).toBe(DONE);
    expect(done?.unread).toBe(true);

    const finished: Current = {
      ...emptyCurrent(),
      state: done?.state,
      unread: done?.unread ?? false,
      sessionId: done?.sessionId,
      errored: done?.errored,
      interrupted: done?.interrupted,
    };
    const next = reduce(atMs(4010), finished, memory, sessionEnd("s-1"));
    // The end of the session is not the unwinding of the turn it just ran.
    expect(next?.state).toBe(DONE);
    expect(next?.sessionPhase).toBe("end");
    expect(next?.errored).toBe(false);
    // And the finished turn is still unread.
    expect(next?.unread).toBe(true);
  });

  /**
   * Rule 4's exceptions as a table. The `undefined` rows are the majority on
   * purpose — an exception that fired more often than these would be the old
   * bug wearing the opposite sign.
   */
  it("matches only what each session exception names", () => {
    const live: Current = {
      ...emptyCurrent(),
      state: WORKING,
      sessionId: "s-1",
    };
    const nameless: Current = { ...emptyCurrent(), state: WORKING };
    const finished: Current = {
      ...emptyCurrent(),
      state: DONE,
      sessionId: "s-1",
    };
    const idle = emptyCurrent();
    const fresh = memoryWith({ turnStartedAt: atMs(0) });
    const justDone = memoryWith({ doneAt: atMs(0) });
    const staleTurn = memoryWith({ turnStartedAt: atMs(-60_000) });

    const cases: {
      name: string;
      now: number;
      current: Current;
      memory: Memory;
      event: AgentEvent;
      keep: SessionKeep | undefined;
    }[] = [
      {
        name: "the start the prompt in flight created",
        now: atMs(20),
        current: live,
        memory: fresh,
        event: sessionStart("s-1", true),
        keep: "opened-by-this-prompt",
      },
      {
        name: "that same start before the row has learned any session id",
        now: atMs(20),
        current: nameless,
        memory: fresh,
        event: sessionStart("s-1", true),
        keep: "opened-by-this-prompt",
      },
      {
        name: "a start naming the session the row already tracks",
        now: atMs(20),
        current: live,
        memory: fresh,
        event: sessionStart("s-1", false),
        keep: "same-session",
      },
      {
        name: "the end that follows the turn's own stop",
        now: atMs(10),
        current: finished,
        memory: justDone,
        event: sessionEnd("s-1"),
        keep: "after-the-final-done",
      },
      {
        name: "a genuinely new session, even one its own prompt opened",
        now: atMs(20),
        current: live,
        memory: fresh,
        event: sessionStart("s-2", true),
        keep: undefined,
      },
      {
        name: "a start that found a turn left over from a CLI already gone",
        now: atMs(20),
        current: live,
        memory: staleTurn,
        event: sessionStart("s-2", true),
        keep: undefined,
      },
      {
        name: "an end long after the turn it is closing",
        now: atMs(10_000),
        current: finished,
        memory: justDone,
        event: sessionEnd("s-1"),
        keep: undefined,
      },
      {
        name: "an end while the turn is still running",
        now: atMs(10),
        current: live,
        memory: justDone,
        event: sessionEnd("s-1"),
        keep: undefined,
      },
      {
        name: "a start on an idle row, which is rule 4 with nothing to keep",
        now: atMs(20),
        current: idle,
        memory: fresh,
        event: sessionStart("s-1", true),
        keep: undefined,
      },
    ];

    for (const entry of cases) {
      expect(
        sessionKeep({
          now: entry.now,
          current: entry.current,
          memory: entry.memory,
          event: entry.event,
        }),
        entry.name,
      ).toBe(entry.keep);
    }
  });

  /**
   * The other providers announce their session before any work, so none of the
   * exceptions can fire for them: a start that names a session the row does not
   * know still resets.
   */
  it("still resets on a start that names an unknown session", () => {
    const memory = memoryWith({
      doneAt: at(0),
      turnStartedAt: at(0),
      awaitingInput: true,
    });
    const live: Current = {
      ...emptyCurrent(),
      state: WORKING,
      sessionId: "s-1",
    };
    const session = newEvent("n", "claude", "session");
    session.sessionPhase = "start";
    session.sessionId = "s-2";
    const next = reduce(at(1), live, memory, session);
    expect(next?.state).toBeUndefined();
    expect(memory.turnStartedAt).toBeUndefined();

    // And a start that names nothing at all is not "the same session" as a row
    // that names nothing either.
    const anonymous = newEvent("n", "claude", "session");
    anonymous.sessionPhase = "start";
    const second = memoryWith({ turnStartedAt: at(0) });
    expect(
      reduce(at(1), current(WORKING), second, anonymous)?.state,
    ).toBeUndefined();
  });
});
