import { describe, expect, it } from "vitest";
import {
  AGENT_IDLE_SECONDS,
  type Actor,
  HUMAN_IDLE_SECONDS,
  LEASE_GENERATION,
  LEASE_HELD_BY_AGENT,
  LEASE_HELD_BY_HUMAN,
  LEASE_REVOKED,
  LeaseMachine,
  agentActor,
  humanActor,
} from "./lease";

/**
 * The control lease's state machine, line by line against the Rust suite it is
 * ported from (the pre-merge implementation).
 *
 * No page and no clock: `request` takes `now`, so "the human went idle for
 * eleven seconds" is a value rather than a sleep.
 */

const T0 = new Date("2026-09-06T09:00:00Z");

function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1_000);
}

const human = (): Actor => humanActor("device-a", "Laptop");
const otherHuman = (): Actor => humanActor("device-b", "Phone");
const agent = (): Actor => agentActor("node-7", "sess-7", "Claude");

describe("the control lease", () => {
  it("gives a free lease to whoever asks first", () => {
    const machine = new LeaseMachine(4);
    expect(machine.request(agent(), T0)).toEqual({ kind: "granted" });
    expect(machine.currentState()).toBe("agent");
    // The generation continues from the stored counter rather than from zero,
    // so a client that slept through a restart cannot present a live number.
    expect(machine.generation()).toBe(5);
  });

  it("does not change hands when the holder renews", () => {
    const machine = new LeaseMachine(0);
    machine.request(agent(), T0);
    const generation = machine.generation();
    expect(machine.request(agent(), at(1))).toEqual({ kind: "granted" });
    expect(machine.generation()).toBe(generation);
  });

  it("makes an agent wait behind a person who is typing", () => {
    const machine = new LeaseMachine(0);
    machine.request(human(), T0);
    expect(machine.request(agent(), T0)).toEqual({ kind: "queue" });
  });

  it("releases an idle person's lease without being asked", () => {
    const machine = new LeaseMachine(0);
    machine.request(human(), T0);
    expect(machine.request(agent(), at(HUMAN_IDLE_SECONDS + 1))).toEqual({
      kind: "granted",
    });
    expect(machine.currentState()).toBe("agent");
  });

  it("holds an idle agent's lease longer than a person's", () => {
    const machine = new LeaseMachine(0);
    machine.request(agent(), T0);
    const between = HUMAN_IDLE_SECONDS + 1;
    expect(between).toBeLessThan(AGENT_IDLE_SECONDS);
    // Still the agent's — a person's window does not apply to it.
    expect(machine.request(agent(), at(between))).toEqual({ kind: "granted" });
    expect(machine.currentState()).toBe("agent");
  });

  it("lets a person's ordinary input preempt an agent", () => {
    const machine = new LeaseMachine(0);
    machine.request(agent(), T0);
    const generation = machine.generation();
    expect(machine.request(human(), T0)).toEqual({ kind: "granted" });
    expect(machine.currentState()).toBe("human");
    expect(machine.generation()).toBe(generation + 1);
    // The agent's next action is told, rather than landing one more click.
    expect(machine.request(agent(), T0)).toEqual({ kind: "queue" });
  });

  it("revokes the agent's lease outright on a takeover", () => {
    const machine = new LeaseMachine(0);
    machine.request(agent(), T0);
    const revoked = machine.takeover(human(), T0);
    expect(revoked?.kind).toBe("agent");
    expect(revoked?.id).toBe("node-7");
    expect(machine.currentState()).toBe("humanTakeover");
    expect(machine.request(agent(), T0)).toEqual({
      kind: "refused",
      code: LEASE_REVOKED,
    });
  });

  it("does not let a takeover lapse on its own", () => {
    const machine = new LeaseMachine(0);
    machine.takeover(human(), T0);
    expect(machine.request(agent(), at(HUMAN_IDLE_SECONDS * 100))).toEqual({
      kind: "refused",
      code: LEASE_REVOKED,
    });
    expect(machine.snapshot().expiresAt).toBe("");
  });

  it("frees the lease when a takeover is handed back", () => {
    const machine = new LeaseMachine(0);
    machine.takeover(human(), T0);
    machine.release(human());
    expect(machine.currentState()).toBe("free");
    expect(machine.request(agent(), T0)).toEqual({ kind: "granted" });
  });

  it("lets only the holder release it", () => {
    const machine = new LeaseMachine(0);
    machine.request(agent(), T0);
    expect(() => {
      machine.release(human());
    }).toThrow(/LEASE_HELD_BY_AGENT/);
    expect(machine.currentState()).toBe("agent");
  });

  it("refuses another device that clicks over a deliberate takeover", () => {
    const machine = new LeaseMachine(0);
    machine.takeover(human(), T0);
    expect(machine.request(otherHuman(), T0)).toEqual({
      kind: "refused",
      code: LEASE_HELD_BY_HUMAN,
    });
    // Ordinary input between two people is last-touch-wins, though.
    const second = new LeaseMachine(0);
    second.request(human(), T0);
    expect(second.request(otherHuman(), T0)).toEqual({ kind: "granted" });
  });

  it("does not queue agents behind each other", () => {
    const machine = new LeaseMachine(0);
    machine.request(agent(), T0);
    expect(
      machine.request(agentActor("node-9", "sess-9", "Codex"), T0),
    ).toEqual({ kind: "refused", code: LEASE_HELD_BY_AGENT });
  });

  it("refuses a stale generation before anything else", () => {
    const machine = new LeaseMachine(0);
    machine.request(human(), T0);
    const current = machine.generation();
    expect(machine.request(human(), T0, current - 1)).toEqual({
      kind: "refused",
      code: LEASE_GENERATION,
    });
    expect(machine.request(human(), T0, current)).toEqual({ kind: "granted" });
  });

  it("names the holder in the snapshot the badge reads", () => {
    const machine = new LeaseMachine(0);
    machine.request(agent(), T0);
    const snapshot = machine.snapshot();
    expect(snapshot.state).toBe("agent");
    expect(snapshot.holder).toEqual({
      kind: "agent",
      id: "node-7",
      displayName: "Claude",
    });
    expect(snapshot.expiresAt).not.toBe("");
    // The wire shape: the same `camelCase` discriminants every client reads.
    expect(JSON.parse(JSON.stringify(snapshot))).toMatchObject({
      state: "agent",
      holder: { kind: "agent" },
    });
    // And the agent's own CLI session, which the badge never shows.
    expect(machine.holderSession()).toBe("sess-7");
  });
});
