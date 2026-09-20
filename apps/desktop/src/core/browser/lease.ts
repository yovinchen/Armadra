import { Refusal } from "../collab/refusals";
import {
  type Lease,
  type LeaseHolder,
  type LeaseState,
  freeLease,
} from "./model";

/**
 * The control lease: who is allowed to drive one session.
 *
 * Ported from the pre-merge implementation. Reads never take
 * the lease. Anything input-shaped does, and there is exactly one holder at a
 * time. Two rules carry the whole design:
 *
 * * a person who just clicks something takes the lease away from an agent
 *   immediately, and the agent's *next* action waits for them to go idle — at
 *   most five seconds, then it is refused rather than queued forever;
 * * a person who presses "take over" revokes the agent's lease outright, and
 *   every agent action is refused until they hand it back.
 *
 * {@link LeaseMachine} is the whole of that, with no page, no database and no
 * clock of its own — `now` is a parameter — so the table it implements can be
 * tested line by line.
 */

/**
 * A person's lease lapses this long after their last input, so an agent that
 * is waiting gets going again without anybody pressing anything.
 */
export const HUMAN_IDLE_SECONDS = 10;
/**
 * An agent's lease lapses this long after its last action. Longer than a
 * person's because an agent thinks between clicks.
 */
export const AGENT_IDLE_SECONDS = 30;
/**
 * How long an agent action waits for a person to go idle before it is refused.
 * Refusing is the design: a queue that grows without bound turns "the human is
 * typing" into "the agent hung".
 */
export const AGENT_QUEUE_MS = 5_000;

/* ------------------------------- reason codes ----------------------------- */

/** A person is driving right now; the agent waited and gave up. */
export const LEASE_HELD_BY_HUMAN = "LEASE_HELD_BY_HUMAN";
/**
 * A person took over. The agent's lease is gone and is not coming back on its
 * own — somebody has to hand it back.
 */
export const LEASE_REVOKED = "LEASE_REVOKED";
/** Another agent holds it. Agents do not queue behind each other. */
export const LEASE_HELD_BY_AGENT = "LEASE_HELD_BY_AGENT";
/**
 * The caller's `leaseGeneration` is not the current one, so whatever it
 * believed about who was driving is out of date.
 */
export const LEASE_GENERATION = "LEASE_GENERATION";

/** The message a refusal carries, which is what a person actually reads. */
export function leaseRefusal(code: string): Refusal {
  switch (code) {
    case LEASE_HELD_BY_HUMAN:
      return Refusal.conflict(
        "LEASE_HELD_BY_HUMAN: somebody is using this browser; try again",
      );
    case LEASE_REVOKED:
      return Refusal.conflict("LEASE_REVOKED: a person took over this browser");
    case LEASE_HELD_BY_AGENT:
      return Refusal.conflict(
        "LEASE_HELD_BY_AGENT: another agent is using this browser",
      );
    default:
      return Refusal.conflict(
        "LEASE_GENERATION: the browser changed hands since you last looked",
      );
  }
}

/* ---------------------------------- actors -------------------------------- */

/**
 * Who is asking. A person is told apart by the opaque id their client sends;
 * an agent by the canvas node it runs in.
 */
export type Actor =
  | {
      readonly kind: "human";
      readonly deviceId: string;
      readonly displayName: string;
    }
  | {
      readonly kind: "agent";
      readonly nodeId: string;
      readonly sessionId: string;
      readonly displayName: string;
    };

export function humanActor(deviceId: string, displayName: string): Actor {
  return { kind: "human", deviceId, displayName };
}

export function agentActor(
  nodeId: string,
  sessionId: string,
  displayName: string,
): Actor {
  return { kind: "agent", nodeId, sessionId, displayName };
}

export function actorId(actor: Actor): string {
  return actor.kind === "human" ? actor.deviceId : actor.nodeId;
}

function holderOf(actor: Actor): LeaseHolder {
  return {
    kind: actor.kind,
    id: actorId(actor),
    displayName: actor.displayName,
  };
}

function idleSeconds(actor: Actor): number {
  return actor.kind === "human" ? HUMAN_IDLE_SECONDS : AGENT_IDLE_SECONDS;
}

/** What the state machine says about one request. */
export type Grant =
  /** The caller holds the lease and may act. */
  | { readonly kind: "granted" }
  /** A person is mid-input. Wait for them to go idle, up to {@link AGENT_QUEUE_MS}. */
  | { readonly kind: "queue" }
  | { readonly kind: "refused"; readonly code: string };

export const GRANTED: Grant = { kind: "granted" };
export const QUEUE: Grant = { kind: "queue" };

function refused(code: string): Grant {
  return { kind: "refused", code };
}

/* -------------------------------- the machine ------------------------------ */

/**
 * The lease of one session. In memory only: after a core restart nobody holds
 * it, and the generation continues from the stored counter so an old client's
 * number cannot come back around to being current.
 */
export class LeaseMachine {
  private state: LeaseState = "free";
  private holder: LeaseHolder | undefined;
  /**
   * The agent's own CLI session, kept out of {@link LeaseHolder} because it is
   * not something a badge shows.
   */
  private agentSession = "";
  private expiresAt: Date | undefined;
  private leaseGeneration: number;

  /** A free lease continuing from the generation the row remembers. */
  constructor(storedGeneration: number) {
    this.leaseGeneration = storedGeneration;
  }

  generation(): number {
    return this.leaseGeneration;
  }

  currentState(): LeaseState {
    return this.state;
  }

  /**
   * The holder's own CLI session, when an agent holds it.
   *
   * Not part of {@link Lease}: a badge shows who is driving, and an agent's
   * session id is not something a viewer has any use for. It is kept because
   * "which session of that node" is the question asked when a handoff or a
   * restart has to decide whether the holder is still the same run.
   */
  holderSession(): string {
    return this.agentSession;
  }

  snapshot(): Lease {
    const base = {
      state: this.state,
      generation: this.leaseGeneration,
      expiresAt: this.expiresAt === undefined ? "" : rfc3339(this.expiresAt),
    };
    return this.holder === undefined ? base : { ...base, holder: this.holder };
  }

  /** True when this actor is the current holder. */
  private heldBy(actor: Actor): boolean {
    if (this.holder === undefined) return false;
    return this.holder.kind === actor.kind && this.holder.id === actorId(actor);
  }

  /**
   * Releases a lease whose idle window has passed. A takeover has no window:
   * it is held until the person hands it back.
   */
  expire(now: Date): boolean {
    if (this.expiresAt === undefined) return false;
    if (now.getTime() < this.expiresAt.getTime()) return false;
    this.clear();
    return true;
  }

  private clear(): void {
    this.state = "free";
    this.holder = undefined;
    this.agentSession = "";
    this.expiresAt = undefined;
    this.leaseGeneration += 1;
  }

  private hold(
    actor: Actor,
    state: LeaseState,
    now: Date,
    changed: boolean,
  ): void {
    this.state = state;
    this.holder = holderOf(actor);
    this.agentSession = actor.kind === "agent" ? actor.sessionId : "";
    this.expiresAt =
      // A takeover is deliberate and stays until it is handed back.
      state === "humanTakeover"
        ? undefined
        : new Date(now.getTime() + idleSeconds(actor) * 1_000);
    if (changed) this.leaseGeneration += 1;
  }

  /**
   * One input-shaped action asking to proceed.
   *
   * `expected` is the generation the caller last saw; `undefined` means it is
   * not tracking one. Expiry is applied first, so a request that arrives after
   * the previous holder went idle sees a free lease rather than a stale one.
   */
  request(actor: Actor, now: Date, expected?: number): Grant {
    this.expire(now);
    if (expected !== undefined && expected !== this.leaseGeneration) {
      return refused(LEASE_GENERATION);
    }
    if (this.state === "free") {
      this.hold(actor, actor.kind === "human" ? "human" : "agent", now, true);
      return GRANTED;
    }
    // The holder renewing: no change of hands, so no new generation.
    if (this.heldBy(actor)) {
      this.hold(actor, this.state, now, false);
      return GRANTED;
    }
    if (this.state === "agent") {
      // A person's ordinary input preempts an agent outright; the agent's next
      // action is told why.
      if (actor.kind === "human") {
        this.hold(actor, "human", now, true);
        return GRANTED;
      }
      return refused(LEASE_HELD_BY_AGENT);
    }
    if (this.state === "human") {
      // Somebody is typing. Wait for them, briefly.
      if (actor.kind === "agent") return QUEUE;
      // A second person: whoever touched it last is driving.
      this.hold(actor, "human", now, true);
      return GRANTED;
    }
    // The takeover is the point: the agent does not queue behind it, and
    // another device does not get to walk over it by clicking.
    return refused(
      actor.kind === "agent" ? LEASE_REVOKED : LEASE_HELD_BY_HUMAN,
    );
  }

  /**
   * A person pressing "take over". Any agent lease is revoked; the answer says
   * whether one actually was, so the caller can log it as `unknown` rather
   * than guessing.
   */
  takeover(actor: Actor, now: Date): LeaseHolder | undefined {
    const revoked =
      this.state === "agent" && this.holder !== undefined
        ? this.holder
        : undefined;
    this.hold(actor, "humanTakeover", now, true);
    return revoked;
  }

  /**
   * Giving the lease back, or an agent releasing its own. Only the holder may:
   * releasing somebody else's lease is not a thing a client can ask for, and
   * is refused rather than quietly ignored.
   */
  release(actor: Actor): void {
    if (!this.heldBy(actor)) {
      throw leaseRefusal(
        this.state === "agent"
          ? LEASE_HELD_BY_AGENT
          : this.state === "free"
            ? LEASE_GENERATION
            : LEASE_HELD_BY_HUMAN,
      );
    }
    this.clear();
  }
}

/** A machine resuming from the generation a stored row remembers. */
export function resumingLease(storedGeneration: number): LeaseMachine {
  return new LeaseMachine(storedGeneration);
}

/** The snapshot of a lease nobody holds, for a session that has none yet. */
export function freeSnapshot(generation: number): Lease {
  return freeLease(generation);
}

/* -------------------------------- the client ------------------------------ */

/**
 * A client that sends no id is "the person at this machine". They are not told
 * apart from each other, which only matters when two of them drive the same
 * node at once.
 */
export function deviceOrLocal(deviceId: string): string {
  const trimmed = deviceId.trim();
  return trimmed === "" ? "local" : trimmed;
}

/** Free text from a client, kept short enough to sit in a badge. */
export function truncateName(name: string): string {
  const trimmed = name.trim();
  const characters = [...trimmed];
  return characters.length > 40 ? characters.slice(0, 40).join("") : trimmed;
}

/**
 * The timestamp format the rest of the core writes.
 *
 * Kept local rather than imported from the workspaces helper so the lease
 * module has no dependency outside its own domain: it is the one part of this
 * domain that is a pure function of `now`.
 */
export function rfc3339(at: Date): string {
  const base = at.toISOString().slice(0, 19);
  const millis = at.getUTCMilliseconds();
  const fraction = millis === 0 ? "" : `.${String(millis).padStart(3, "0")}`;
  return `${base}${fraction}+00:00`;
}
