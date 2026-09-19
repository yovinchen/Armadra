/**
 * Cancelling a transfer that is already running (design §2.1, §4.1 "下载中 →
 * 取消"). Ported from the Rust shell's cancel suite, all 10 test
 * functions.
 *
 * The interesting cases are all races. Neither the Rust shell's updater nor
 * electron-updater gives an abort handle, so the shell stops *awaiting* the
 * transfer instead — which means a cancel and a completion can both be true at
 * nearly the same instant, and the rules for who wins have to be stated rather
 * than discovered.
 */
import { expect, it } from "vitest";

import { Cancellation } from "./cancel";
import { Machine, type Event, type Offer } from "./machine";

function offer(): Offer {
  return {
    version: "0.2.0",
    target: "darwin-aarch64",
    manifestUrl: "https://example.invalid/latest.json",
    packageUrl: "https://example.invalid/Armadra.app.tar.gz",
    sha256: "a".repeat(64),
    sizeBytes: 4_096,
    signed: true,
    notesUrl: "https://example.invalid/notes",
  };
}

function downloading(): Machine {
  const machine = Machine.idle();
  const events: Event[] = [
    { type: "checkStarted" },
    { type: "checkedAvailable", offer: offer() },
    { type: "downloadStarted" },
  ];
  for (const event of events) machine.apply(event);
  return machine;
}

it("nothing is cancelled before a transfer is armed", () => {
  const cancellation = new Cancellation();
  expect(cancellation.isArmed()).toBe(false);
  // "There was nothing to cancel" is a different answer from "cancelled", and
  // the handler needs to be able to tell them apart.
  expect(cancellation.cancel()).toBe(false);
});

it("an armed transfer is woken by a cancel", async () => {
  const cancellation = new Cancellation();
  const token = cancellation.arm();
  expect(cancellation.isArmed()).toBe(true);
  expect(cancellation.cancel()).toBe(true);
  // The permit is stored, so a cancel that lands before the transfer's first
  // await still stops it. This await would hang if it were not.
  await token.notified();
  expect(cancellation.isArmed()).toBe(false);
});

it("arming a second transfer cancels the first", async () => {
  const cancellation = new Cancellation();
  const first = cancellation.arm();
  const second = cancellation.arm();
  // The first token is woken so its transfer stops; the state machine only
  // models one, and an orphan would keep reporting progress for an offer
  // nobody is waiting on.
  await first.notified();
  expect(cancellation.isArmed()).toBe(true);
  expect(cancellation.cancel()).toBe(true);
  await second.notified();
});

it("a late finish does not disarm the next transfer", () => {
  const cancellation = new Cancellation();
  const stale = cancellation.arm();
  expect(cancellation.cancel()).toBe(true);
  const current = cancellation.arm();
  // The cancelled transfer completes anyway and retires its own token. The one
  // armed afterwards must survive, or nothing could stop it.
  cancellation.finish(stale);
  expect(cancellation.isArmed()).toBe(true);
  cancellation.finish(current);
  expect(cancellation.isArmed()).toBe(false);
});

it("finishing a token twice is harmless", () => {
  const cancellation = new Cancellation();
  const token = cancellation.arm();
  cancellation.finish(token);
  cancellation.finish(token);
  expect(cancellation.isArmed()).toBe(false);
  expect(cancellation.cancel()).toBe(false);
});

it("a cancelled transfer keeps the offer and drops the bytes", () => {
  const machine = downloading();
  expect(machine.apply({ type: "checkCancelled" })).toBe(true);
  // Back to the offer, not to "never checked": the release is still there, and
  // only the partial file was thrown away.
  expect(machine.state()).toEqual({ state: "available", offer: offer() });
  // And it can be started again from exactly that state.
  expect(machine.apply({ type: "downloadStarted" })).toBe(true);
  expect(machine.state().state).toBe("downloading");
});

it("a transfer that finished while being cancelled stages nothing", () => {
  const machine = downloading();
  machine.apply({ type: "checkCancelled" });
  // The download handler applies `downloadFinished` after the race is lost;
  // the machine refuses it, and the handler reads that refusal as "do not keep
  // these bytes".
  expect(machine.apply({ type: "downloadFinished" })).toBe(false);
  expect(machine.state()).toEqual({ state: "available", offer: offer() });
});

it("cancelling a check returns to idle and ignores its late answer", () => {
  const machine = Machine.idle();
  machine.apply({ type: "checkStarted" });
  machine.apply({ type: "checkCancelled" });
  expect(machine.state()).toEqual({ state: "idle" });
  // The check's answer arrives after the cancel. It is not an answer to
  // anything anybody is waiting for, and "up to date" least of all.
  expect(machine.apply({ type: "checkedUpToDate", atMs: 1 })).toBe(false);
  expect(machine.state()).toEqual({ state: "idle" });
});

it("a cancel arriving after the bytes landed changes nothing", () => {
  const machine = downloading();
  machine.apply({ type: "downloadFinished" });
  const staged = structuredClone(machine.state());
  // A person pressing cancel as the transfer completes must not throw away a
  // verified package; the cancel handler only acts while `downloading`.
  expect(machine.apply({ type: "checkCancelled" })).toBe(false);
  expect(machine.state()).toEqual(staged);
});

it("cancel tokens are distinct across transfers", () => {
  const cancellation = new Cancellation();
  const first = cancellation.arm();
  const second = cancellation.arm();
  expect(first).not.toBe(second);
  // And the one that was replaced knows it, which the transfer it belongs to
  // reads before it does anything with its bytes.
  expect(first.isCancelled()).toBe(true);
  expect(second.isCancelled()).toBe(false);
});
