import {
  type AgentEvent,
  DONE,
  WAITING,
  WORKING,
  isSubagent,
  stateEvent,
} from "./normalize/event";

/**
 * The agent state machine — contract §5.4.
 *
 * Hook events do not arrive in the order they happened. Claude runs its hooks
 * in parallel, a `PostToolUse` can land after the `Stop` that ended the turn,
 * and an idle notification can arrive minutes late. A reducer that simply took
 * the newest event would flip a finished node back to `working` several times
 * a session, which is exactly the flicker the invariants exist to prevent.
 *
 * Five rules, each defending against one real failure:
 *
 * 1. **done holdoff (3s)** — a late `working` that is not a new turn cannot
 *    revive a turn that just ended.
 * 2. **idle rescue** — the "waiting for your input" notification may only turn
 *    `working` into `done`. It never touches `blocked` or `waiting`, because a
 *    node that is asking something *is* idle by that definition.
 * 3. **awaitingInput hold** — while an unanswered question is open, the `done`
 *    that ends its turn is rewritten to `waiting`. Otherwise the node looks
 *    finished while the CLI sits at a prompt.
 * 4. **session reset** — `SessionStart` / `SessionEnd` clear the state rather
 *    than set one; a fresh CLI is idle, not done. Its exceptions live in
 *    {@link SESSION_KEEP_RULES}: not every session event describes a
 *    *different* session from the turn already on the row.
 * 5. **subagent isolation** — subagent events describe a child, never the
 *    parent's state.
 *
 * `restored` is the sixth: a row read back from SQLite after a restart is not
 * live knowledge, so it never gets the benefit of the holdoff and its `done`
 * is not a fresh one.
 */

/**
 * A `working` that lands within this window after a `done` is discarded unless
 * it opens a new turn.
 */
export const DONE_HOLDOFF_SECONDS = 3;
/** A `working` node that has not reported for this long is swept to `done`. */
export const STALE_WORKING_MINUTES = 20;
/**
 * How long a session event may still be talking about the turn next to it.
 *
 * Copilot CLI 1.0.83 measured on 2026-09-06: `sessionStart` lands ~20 ms after
 * the `userPromptSubmitted` that created the session, and in `-p` mode
 * `sessionEnd` lands ~10 ms after `agentStop`. Three seconds is the same slack
 * rule 1 already gives a fresh `done`, and orders of magnitude below the gap
 * between two real sessions in one terminal.
 */
export const SESSION_ECHO_SECONDS = 3;

/** The row as it stands before the event is applied. */
export interface Current {
  readonly state?: string | undefined;
  readonly stateSource?: string | undefined;
  readonly unread: boolean;
  readonly sessionId?: string | undefined;
  readonly pendingId?: string | undefined;
  readonly transcriptPath?: string | undefined;
  readonly sessionPhase?: string | undefined;
  readonly errored?: boolean | undefined;
  readonly interrupted?: boolean | undefined;
  readonly restored: boolean;
}

export function emptyCurrent(): Current {
  return { unread: false, restored: false };
}

/**
 * The part of the state machine that does not survive a restart: when the last
 * turn ended, and whether a question is still open. Keyed by node.
 */
export interface Memory {
  doneAt?: number | undefined;
  /**
   * When the turn currently on the row opened. Only a session event reads it,
   * to tell "the start that created this very turn" from "a start that found a
   * turn left over from a CLI that is already gone".
   */
  turnStartedAt?: number | undefined;
  awaitingInput: boolean;
}

export function newMemory(): Memory {
  return { awaitingInput: false };
}

/**
 * Everything a rule 4 exception is allowed to look at. Passing it as one value
 * keeps every rule below a pure predicate the tests can drive directly.
 */
export interface SessionFacts {
  readonly now: number;
  readonly current: Current;
  readonly memory: Memory;
  readonly event: AgentEvent;
}

/** Why a session event leaves the turn on the row standing. */
export type SessionKeep =
  /**
   * A start the prompt in flight created. Copilot opens its session *from* the
   * first prompt, so `sessionStart` arrives after that turn's `working`;
   * resetting on it blanks the state the prompt just set.
   */
  | "opened-by-this-prompt"
  /**
   * A start naming the session the row is already tracking. Nothing to forget:
   * it is the same session, however it got re-announced.
   */
  | "same-session"
  /**
   * The end that closes the turn that just reported `done`. In Copilot's
   * non-interactive `-p` mode it follows `agentStop` by ~10 ms, and clearing
   * there leaves a finished run with no state at all.
   */
  | "after-the-final-done";

/**
 * Rule 4's exceptions, tried in order. Every session event that matches none
 * of them resets the machine, which is rule 4 unchanged.
 */
export const SESSION_KEEP_RULES: readonly (readonly [
  SessionKeep,
  (facts: SessionFacts) => boolean,
])[] = [
  [
    "opened-by-this-prompt",
    (facts) =>
      facts.event.sessionPhase === "start" &&
      facts.event.sessionOpenedByPrompt === true &&
      facts.current.state === WORKING &&
      within(facts.now, facts.memory.turnStartedAt) &&
      // A start that names a session the row is not running is a real new
      // session, however it was opened, and rule 4 applies to it.
      (facts.current.sessionId === undefined ||
        facts.event.sessionId === facts.current.sessionId),
  ],
  [
    "same-session",
    (facts) =>
      facts.event.sessionPhase === "start" &&
      facts.current.state !== undefined &&
      facts.event.sessionId !== undefined &&
      facts.event.sessionId === facts.current.sessionId,
  ],
  [
    "after-the-final-done",
    (facts) =>
      facts.event.sessionPhase === "end" &&
      facts.current.state === DONE &&
      within(facts.now, facts.memory.doneAt),
  ],
];

/** The first exception that matches, or `undefined` for a plain rule 4 reset. */
export function sessionKeep(facts: SessionFacts): SessionKeep | undefined {
  return SESSION_KEEP_RULES.find(([, matches]) => matches(facts))?.[0];
}

function within(now: number, mark: number | undefined): boolean {
  return mark !== undefined && now - mark < SESSION_ECHO_SECONDS * 1000;
}

/**
 * What to write and publish. `undefined` from {@link reduce} means "nothing
 * changed" — the report is still accepted, it simply says nothing new.
 */
export interface Next {
  state: string | undefined;
  /**
   * Which channel produced this state. It follows the state rather than the
   * row: a report that changes nothing changes no source either, and a report
   * the reducer drops (a late `working` inside the holdoff) leaves the
   * previous channel standing, because the state it described is the one still
   * on screen.
   */
  stateSource: string | undefined;
  unread: boolean;
  sessionId: string | undefined;
  pendingId: string | undefined;
  transcriptPath: string | undefined;
  sessionPhase: string | undefined;
  lastMessage: string | undefined;
  /**
   * How the turn that just reached `done` ended. `undefined` while a turn is
   * open, so the UI can tell "still running" from "finished cleanly".
   */
  errored: boolean | undefined;
  interrupted: boolean | undefined;
}

export function reduce(
  now: number,
  current: Current,
  memory: Memory,
  event: AgentEvent,
): Next | undefined {
  // Rule 5: a subagent card is not the parent's state.
  if (isSubagent(event.kind)) return undefined;

  // Carrying facts forward is the default; only what the event speaks about is
  // replaced.
  const next: Next = {
    state: current.state,
    stateSource: event.stateSource ?? current.stateSource,
    unread: current.unread,
    sessionId: event.sessionId ?? current.sessionId,
    pendingId: current.pendingId,
    transcriptPath: event.transcriptPath ?? current.transcriptPath,
    sessionPhase: current.sessionPhase,
    lastMessage: event.lastMessage,
    errored: current.errored,
    interrupted: current.interrupted,
  };

  if (event.kind === "session") {
    next.sessionPhase = event.sessionPhase;
    // The exceptions first: a session event that is talking about the turn
    // already on the row moves the phase and nothing else.
    if (sessionKeep({ now, current, memory, event }) !== undefined) {
      return next;
    }
    // Rule 4. A new session forgets the old turn entirely: no pending
    // approval, no open question, no just-finished holdoff.
    memory.doneAt = undefined;
    memory.turnStartedAt = undefined;
    memory.awaitingInput = false;
    next.state = undefined;
    next.pendingId = undefined;
    next.errored = undefined;
    next.interrupted = undefined;
    return next;
  }

  // Nothing to say about the state: a report that only carries identity.
  if (event.state === undefined) return undefined;
  let target: string = event.state;

  // Rule 2: the idle notification is a rescue, not a report.
  if (event.idle === true && current.state !== WORKING) return undefined;

  // Rule 1: a stale row was never live, so it gets no holdoff.
  if (
    event.newTurn !== true &&
    target === WORKING &&
    current.state === DONE &&
    !current.restored &&
    memory.doneAt !== undefined &&
    now - memory.doneAt < DONE_HOLDOFF_SECONDS * 1000
  ) {
    return undefined;
  }

  if (event.newTurn === true) {
    // A new turn answers whatever the last one was waiting on.
    memory.awaitingInput = false;
    memory.doneAt = undefined;
    memory.turnStartedAt = now;
    next.pendingId = undefined;
  }
  if (event.awaitingInput === true) memory.awaitingInput = true;

  // Rule 3: an unanswered question outranks the end of its own turn.
  if (target === DONE && memory.awaitingInput) target = WAITING;

  switch (target) {
    case DONE:
      memory.doneAt = now;
      // The badge is what makes a finished node findable on a big canvas; only
      // the client's read receipt clears it.
      // A synthetic close for a dead terminal raises no badge: there is
      // nothing to read that the terminal's own exit does not already show. It
      // does not *clear* an existing one either — output from an earlier turn
      // is still unread, and only the receipt says otherwise.
      if (event.silent !== true) next.unread = true;
      next.pendingId = undefined;
      // A `done` always carries a verdict, even when the event says nothing:
      // silence from `Stop` means the turn ended cleanly.
      next.errored = event.errored ?? false;
      next.interrupted = event.interrupted ?? false;
      break;
    case "blocked":
      next.pendingId = event.pendingId ?? current.pendingId;
      break;
    case WAITING:
      next.pendingId = event.pendingId ?? next.pendingId;
      // A question is part of a turn that has not ended yet — including the
      // `done` that rule 3 just rewrote.
      next.errored = undefined;
      next.interrupted = undefined;
      break;
    default:
      // Working again: whatever was blocking is resolved, and the last turn's
      // verdict no longer describes what the node is doing.
      next.pendingId = undefined;
      next.errored = undefined;
      next.interrupted = undefined;
      break;
  }
  next.state = target;
  return next;
}

/**
 * The synthetic event the 60s sweep applies to a node that stopped reporting.
 * It goes through {@link reduce} like any other event so the invariants (an
 * open question still wins) hold for it too.
 */
export function staleEvent(nodeId: string, agentId: string): AgentEvent {
  const event = stateEvent(nodeId, agentId, DONE);
  event.errored = false;
  event.interrupted = false;
  event.lastMessage = `stale=true no hook report for ${STALE_WORKING_MINUTES} minutes`;
  return event;
}

/**
 * The synthetic event for a node whose terminal died mid-turn.
 *
 * A plain clean end. `interrupted` is deliberately *not* reused for it: that
 * flag means the user stopped the agent (Esc, `Interrupt`), and overloading it
 * with "the terminal went away" would make the PAUSED pill mean two different
 * things. The cause is carried by the `terminated=true` marker instead, which
 * a client can match on if it wants distinct wording.
 */
export function terminalGoneEvent(nodeId: string, agentId: string): AgentEvent {
  const event = stateEvent(nodeId, agentId, DONE);
  event.errored = false;
  event.interrupted = false;
  event.silent = true;
  event.lastMessage =
    "terminated=true the terminal exited before the turn ended";
  return event;
}
