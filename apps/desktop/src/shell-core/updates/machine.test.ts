/**
 * The transition table of docs/design/updates-and-service-install.md §2.1,
 * ported from `src-tauri/src/updates/tests/updates_machine.rs` (12 test
 * functions) with one addition: the table is also written out cell by cell —
 * every one of the thirteen states against every one of the fifteen events,
 * 195 entries — so a transition cannot quietly change without a test changing
 * with it.
 *
 * Two properties are asserted over the *whole* table rather than case by case,
 * because they are the ones a future edit is most likely to break: nothing
 * reaches "up to date" except a check that said so, and a state never moves on
 * an event it does not accept.
 */
import { describe, expect, it } from "vitest";

import {
  Machine,
  REASONS,
  type Event,
  type Offer,
  type UpdateState,
} from "./machine";

function offer(): Offer {
  return {
    version: "0.2.0",
    target: "darwin-aarch64",
    manifestUrl: "https://releases.invalid/download/v0.2.0/latest.json",
    packageUrl:
      "https://releases.invalid/download/v0.2.0/Armadra_0.2.0_darwin-aarch64.app.tar.gz",
    sha256: "a".repeat(64),
    sizeBytes: 4096,
    signed: true,
    notesUrl: "https://releases.invalid/v0.2.0",
  };
}

function walk(...events: Event[]): Machine {
  const machine = Machine.idle();
  for (const event of events) machine.apply(event);
  return machine;
}

const CHECKED_AVAILABLE: Event = { type: "checkedAvailable", offer: offer() };

/** One machine in each state, so a property can be checked against all of them. */
function everyState(): { name: string; machine: Machine }[] {
  return [
    {
      name: "notConfigured",
      machine: Machine.notConfigured({ pubkey: true, endpoints: true }),
    },
    { name: "localBuild", machine: Machine.localBuild() },
    { name: "unsupported", machine: Machine.unsupported("notDesktop") },
    { name: "idle", machine: Machine.idle() },
    { name: "checking", machine: walk({ type: "checkStarted" }) },
    {
      name: "upToDate",
      machine: walk(
        { type: "checkStarted" },
        { type: "checkedUpToDate", atMs: 10 },
      ),
    },
    {
      name: "unavailable",
      machine: walk(
        { type: "checkStarted" },
        {
          type: "checkRefused",
          reason: "sourceUnreachable",
          retryAfterMs: 900_000,
          atMs: 10,
        },
      ),
    },
    {
      name: "available",
      machine: walk({ type: "checkStarted" }, CHECKED_AVAILABLE),
    },
    {
      name: "downloading",
      machine: walk({ type: "checkStarted" }, CHECKED_AVAILABLE, {
        type: "downloadStarted",
      }),
    },
    {
      name: "downloaded/ready",
      machine: walk(
        { type: "checkStarted" },
        CHECKED_AVAILABLE,
        { type: "downloadStarted" },
        { type: "downloadFinished" },
      ),
    },
    {
      name: "downloaded/preparing",
      machine: walk(
        { type: "checkStarted" },
        CHECKED_AVAILABLE,
        { type: "downloadStarted" },
        { type: "downloadFinished" },
        { type: "restartRequested" },
      ),
    },
    {
      name: "downloaded/installing",
      machine: walk(
        { type: "checkStarted" },
        CHECKED_AVAILABLE,
        { type: "downloadStarted" },
        { type: "downloadFinished" },
        { type: "restartRequested" },
        { type: "backgroundStopped" },
      ),
    },
    {
      name: "failed",
      machine: walk(
        { type: "checkStarted" },
        CHECKED_AVAILABLE,
        { type: "downloadStarted" },
        { type: "downloadFailed", reason: "digestMismatch" },
      ),
    },
  ];
}

const EVERY_EVENT: { name: string; event: Event }[] = [
  { name: "checkStarted", event: { type: "checkStarted" } },
  { name: "checkCancelled", event: { type: "checkCancelled" } },
  { name: "checkedUpToDate", event: { type: "checkedUpToDate", atMs: 1 } },
  { name: "checkedAvailable", event: CHECKED_AVAILABLE },
  {
    name: "checkRefused",
    event: {
      type: "checkRefused",
      reason: "sourceMalformed",
      retryAfterMs: 0,
      atMs: 1,
    },
  },
  { name: "offerDismissed", event: { type: "offerDismissed" } },
  { name: "downloadStarted", event: { type: "downloadStarted" } },
  {
    name: "downloadProgressed",
    event: { type: "downloadProgressed", receivedBytes: 10, totalBytes: 20 },
  },
  { name: "downloadFinished", event: { type: "downloadFinished" } },
  {
    name: "downloadFailed",
    event: { type: "downloadFailed", reason: "downloadInterrupted" },
  },
  { name: "restartRequested", event: { type: "restartRequested" } },
  { name: "backgroundStopped", event: { type: "backgroundStopped" } },
  {
    name: "restartAbandoned",
    event: { type: "restartAbandoned", reason: "hostStopFailed" },
  },
  {
    name: "installFailed",
    event: { type: "installFailed", reason: "installFailed" },
  },
  { name: "retry", event: { type: "retry" } },
];

/**
 * The whole table. `undefined` is "this state does not accept this event and
 * therefore does not move" — the rule of §2.1 written as a value rather than
 * as a comment, which is what makes the sweep below exhaustive.
 */
const TABLE: Record<string, Partial<Record<string, UpdateState>>> = {
  // The three states that describe the build accept nothing at all.
  notConfigured: {},
  localBuild: {},
  unsupported: {},

  idle: { checkStarted: { state: "checking" } },

  checking: {
    checkCancelled: { state: "idle" },
    checkedUpToDate: { state: "upToDate", checkedAtMs: 1 },
    checkedAvailable: { state: "available", offer: offer() },
    checkRefused: {
      state: "unavailable",
      reason: "sourceMalformed",
      retryAfterMs: 0,
      checkedAtMs: 1,
    },
  },

  upToDate: { checkStarted: { state: "checking" } },
  unavailable: { checkStarted: { state: "checking" } },

  available: {
    checkStarted: { state: "checking" },
    offerDismissed: { state: "idle" },
    downloadStarted: {
      state: "downloading",
      offer: offer(),
      receivedBytes: 0,
      totalBytes: 4096,
    },
  },

  downloading: {
    checkCancelled: { state: "available", offer: offer() },
    downloadProgressed: {
      state: "downloading",
      offer: offer(),
      receivedBytes: 10,
      totalBytes: 20,
    },
    downloadFinished: {
      state: "downloaded",
      offer: offer(),
      phase: "ready",
      problem: null,
    },
    downloadFailed: {
      state: "failed",
      reason: "downloadInterrupted",
      offer: offer(),
    },
  },

  "downloaded/ready": {
    restartRequested: {
      state: "downloaded",
      offer: offer(),
      phase: "preparing",
      problem: null,
    },
  },

  "downloaded/preparing": {
    backgroundStopped: {
      state: "downloaded",
      offer: offer(),
      phase: "installing",
      problem: null,
    },
    restartAbandoned: {
      state: "downloaded",
      offer: offer(),
      phase: "ready",
      problem: "hostStopFailed",
    },
  },

  "downloaded/installing": {
    installFailed: { state: "failed", reason: "installFailed", offer: offer() },
  },

  failed: {
    checkStarted: { state: "checking" },
    retry: { state: "available", offer: offer() },
  },
};

describe("the transition table (§2.1)", () => {
  const states = everyState();

  it("covers every state and every event", () => {
    expect(states.map((each) => each.name).sort()).toEqual(
      Object.keys(TABLE).sort(),
    );
    expect(states).toHaveLength(13);
    expect(EVERY_EVENT).toHaveLength(15);
  });

  // 13 × 15 = 195 entries, each asserted against the table above.
  for (const { name, machine } of states) {
    for (const { name: eventName, event } of EVERY_EVENT) {
      it(`${name} + ${eventName}`, () => {
        const subject = machine.clone();
        const before = structuredClone(subject.state());
        const expected = TABLE[name]?.[eventName];
        const moved = subject.apply(event);
        if (expected === undefined) {
          // Rule 2: an event a state does not accept changes nothing. There is
          // no fallthrough that lands somewhere plausible.
          expect(moved).toBe(false);
          expect(subject.state()).toEqual(before);
        } else {
          expect(subject.state()).toEqual(expected);
        }
      });
    }
  }
});

/**
 * The contract's first rule. Not looking, failing to look, and looking and
 * finding nothing are three answers, and only the third one is "up to date".
 */
it("only a check that answered can produce up to date", () => {
  for (const { machine } of everyState()) {
    for (const { event } of EVERY_EVENT) {
      const subject = machine.clone();
      const before = structuredClone(subject.state());
      subject.apply(event);
      if (subject.state().state === "upToDate" && before.state !== "upToDate") {
        expect(
          before.state === "checking" && event.type === "checkedUpToDate",
          `${before.state} + ${event.type} claimed the build was up to date`,
        ).toBe(true);
      }
    }
  }
});

/** The three states that describe the build rather than a check never move. */
it("a build that cannot update stays where it is", () => {
  for (const machine of [
    Machine.notConfigured({ pubkey: true, endpoints: false }),
    Machine.localBuild(),
    Machine.unsupported("remoteHost"),
    Machine.unsupported("managedPackage"),
  ]) {
    expect(machine.isTerminal()).toBe(true);
    expect(machine.mayCheck()).toBe(false);
    for (const { event } of EVERY_EVENT) {
      const subject = machine.clone();
      const before = structuredClone(subject.state());
      expect(
        subject.apply(event),
        `${before.state} moved on ${event.type}`,
      ).toBe(false);
      expect(subject.state()).toEqual(before);
    }
  }
});

it("a check walks to each of its three answers", () => {
  const machine = Machine.idle();
  expect(machine.apply({ type: "checkStarted" })).toBe(true);
  expect(machine.state().state).toBe("checking");
  // A second start while one is in flight changes nothing.
  expect(machine.apply({ type: "checkStarted" })).toBe(false);

  machine.apply({ type: "checkedUpToDate", atMs: 42 });
  expect(machine.state()).toEqual({ state: "upToDate", checkedAtMs: 42 });

  machine.apply({ type: "checkStarted" });
  machine.apply({
    type: "checkRefused",
    reason: "sourceUnreachable",
    // A negative hint is a broken hint, not a request to retry in the past.
    retryAfterMs: -5,
    atMs: 43,
  });
  expect(machine.state()).toEqual({
    state: "unavailable",
    reason: "sourceUnreachable",
    retryAfterMs: 0,
    checkedAtMs: 43,
  });

  machine.apply({ type: "checkStarted" });
  machine.apply(CHECKED_AVAILABLE);
  expect(machine.offer()).toEqual(offer());
});

it("a cancelled check returns to never having checked", () => {
  const machine = walk({ type: "checkStarted" }, { type: "checkCancelled" });
  expect(machine.state()).toEqual({ state: "idle" });
});

/**
 * A download in flight is not interrupted by the periodic check: the offer in
 * hand is the one the person acted on.
 */
it("a transfer or a pending restart is not interrupted by a check", () => {
  const machine = walk({ type: "checkStarted" }, CHECKED_AVAILABLE, {
    type: "downloadStarted",
  });
  expect(machine.mayCheck()).toBe(false);
  expect(machine.apply({ type: "checkStarted" })).toBe(false);
  machine.apply({ type: "downloadFinished" });
  expect(machine.mayCheck()).toBe(false);
  expect(machine.apply({ type: "checkStarted" })).toBe(false);
});

it("progress reports a total even when the server gives none", () => {
  const machine = walk(
    { type: "checkStarted" },
    CHECKED_AVAILABLE,
    { type: "downloadStarted" },
    { type: "downloadProgressed", receivedBytes: 512, totalBytes: 0 },
  );
  expect(machine.state()).toEqual({
    state: "downloading",
    offer: offer(),
    receivedBytes: 512,
    // The offer's own size, never zero: a zero total renders as a full bar the
    // moment one byte arrives.
    totalBytes: 4096,
  });
});

/**
 * A cancelled or failed transfer discards the bytes and keeps the offer. There
 * is no resume, so a partial file is not something to continue from.
 */
it("a failed transfer keeps the offer and nothing else", () => {
  for (const reason of ["digestMismatch", "signatureMismatch"] as const) {
    const machine = walk(
      { type: "checkStarted" },
      CHECKED_AVAILABLE,
      { type: "downloadStarted" },
      { type: "downloadFailed", reason },
    );
    expect(machine.state()).toEqual({
      state: "failed",
      reason,
      offer: offer(),
    });
    // "Try again" goes back to the offer, and a second download may start
    // straight from the failure.
    machine.apply({ type: "retry" });
    expect(machine.state()).toEqual({ state: "available", offer: offer() });
  }

  const cancelled = walk(
    { type: "checkStarted" },
    CHECKED_AVAILABLE,
    { type: "downloadStarted" },
    { type: "checkCancelled" },
  );
  expect(cancelled.state()).toEqual({ state: "available", offer: offer() });
});

/**
 * Skipping a version drops the offer without claiming anything about whether a
 * newer one exists.
 */
it("skipping a version does not become up to date", () => {
  const machine = walk({ type: "checkStarted" }, CHECKED_AVAILABLE, {
    type: "offerDismissed",
  });
  expect(machine.state()).toEqual({ state: "idle" });
});

/**
 * Design §2.3: stopping the background failing means the install never starts,
 * and the update goes back to waiting rather than to a failure with no bytes.
 */
it("a restart that could not stop the background returns to waiting", () => {
  const machine = walk(
    { type: "checkStarted" },
    CHECKED_AVAILABLE,
    { type: "downloadStarted" },
    { type: "downloadFinished" },
    { type: "restartRequested" },
  );
  expect(machine.state()).toMatchObject({
    state: "downloaded",
    phase: "preparing",
  });
  machine.apply({ type: "restartAbandoned", reason: "hostStopFailed" });
  expect(machine.state()).toEqual({
    state: "downloaded",
    offer: offer(),
    phase: "ready",
    problem: "hostStopFailed",
  });
  // A person cancelling at the confirmation leaves no problem behind.
  machine.apply({ type: "restartRequested" });
  machine.apply({ type: "restartAbandoned", reason: null });
  expect(machine.state()).toEqual({
    state: "downloaded",
    offer: offer(),
    phase: "ready",
    problem: null,
  });
});

/**
 * An installer that failed leaves the old version running, and the offer is
 * kept so the failure can point at "try again" or the release page.
 */
it("a failed install keeps the offer and reports the reason", () => {
  const machine = walk(
    { type: "checkStarted" },
    CHECKED_AVAILABLE,
    { type: "downloadStarted" },
    { type: "downloadFinished" },
    { type: "restartRequested" },
    { type: "backgroundStopped" },
  );
  expect(machine.state()).toMatchObject({
    state: "downloaded",
    phase: "installing",
  });
  // Installing is past the point of no return for stopping: a stop failure
  // reported now is a race, and it must not undo the install.
  expect(
    machine.apply({ type: "restartAbandoned", reason: "hostStopFailed" }),
  ).toBe(false);
  machine.apply({ type: "installFailed", reason: "installFailed" });
  expect(machine.state()).toEqual({
    state: "failed",
    reason: "installFailed",
    offer: offer(),
  });
});

/**
 * The eleven reported states of design §4.1, spelled the way the front end
 * reads them. A rename here is a silently broken settings page, so the tags
 * are asserted rather than inferred.
 */
it("every reported state serializes to its documented tag", () => {
  const seen = [
    ...new Set(everyState().map(({ machine }) => machine.state().state)),
  ].sort();
  expect(seen).toEqual([
    "available",
    "checking",
    "downloaded",
    "downloading",
    "failed",
    "idle",
    "localBuild",
    "notConfigured",
    "unavailable",
    "unsupported",
    "upToDate",
  ]);
});

/**
 * A reason reaches the front end as a stable token and nothing else: no URL,
 * no response body, no transport message (design §2.1).
 */
it("reasons are stable tokens and carry no transport detail", () => {
  expect([...REASONS]).toEqual([
    "sourceUnreachable",
    "sourceMalformed",
    "compatibilityRefused",
    "noArtifactForTarget",
    "signatureMismatch",
    "digestMismatch",
    "downloadInterrupted",
    "diskFull",
    "hostStopFailed",
    "installFailed",
    "updaterUnavailable",
  ]);
  for (const reason of REASONS) {
    expect(reason).not.toContain("://");
    expect(JSON.stringify(reason)).toBe(`"${reason}"`);
  }
});
