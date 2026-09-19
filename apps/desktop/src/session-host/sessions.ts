import {
  type HostErrorCode,
  type HostSize,
  type SessionSummary,
  clampSize,
} from "../core/terminal/session-host/protocol";

/**
 * The session table: which sessions exist, who is watching them, and which
 * generation is current.
 *
 * Everything here is bookkeeping about processes, not the processes
 * themselves — which is why it is platform independent and unit tested on a
 * machine that has no ConPTY. {@link ../session-host/pty} owns the pseudo
 * consoles and asks this table what it is allowed to do.
 *
 * Two invariants earn the whole module:
 *
 *   * **Generations fence.** A key has exactly one current generation. A
 *     request carrying an older one is `stale`, never "close enough" — a
 *     write meant for the CLI you recycled away from must not reach the one
 *     that replaced it.
 *   * **Back pressure belongs to a connection.** A subscriber that cannot
 *     keep up pauses the reader, and that pause is released when its
 *     connection goes away, whatever else happens. A frontend that crashes
 *     while paused must not leave the CLI frozen forever.
 *
 * A port of `crates/session-host/src/session.rs`, including its tests.
 */

/** Identifies one connection. Assigned by the host, monotonic, never reused. */
export type ConnectionId = number;

export type SessionState =
  | { readonly kind: "running" }
  | { readonly kind: "exited"; readonly code: number | undefined };

export function isOver(state: SessionState): boolean {
  return state.kind !== "running";
}

export class SessionError extends Error {
  constructor(
    readonly code: HostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

/** One session's bookkeeping. */
export class SessionEntry {
  state: SessionState = { kind: "running" };
  pid: number | undefined;
  /** Next output frame number. Starts at 1 so zero can mean "no frame yet". */
  private nextFrame = 1;
  private readonly subscriberSet = new Set<ConnectionId>();
  /**
   * Connections that have asked the reader to stop. A set rather than a
   * counter, so a repeated pause is idempotent and a disconnect clears the
   * caller's claim exactly once.
   */
  private readonly pauseOwners = new Set<ConnectionId>();

  constructor(
    readonly sessionKey: string,
    readonly generation: number,
    readonly workspaceId: string,
    readonly cwd: string,
    public size: HostSize,
  ) {}

  subscribers(): ConnectionId[] {
    return [...this.subscriberSet];
  }

  get subscriberCount(): number {
    return this.subscriberSet.size;
  }

  /**
   * Whether the reader should stop pulling. ConPTY's own buffer then
   * back-pressures the CLI, which is what tmux does too.
   */
  get paused(): boolean {
    return this.pauseOwners.size > 0;
  }

  /** The next output frame number, consumed. */
  takeSequence(): number {
    const sequence = this.nextFrame;
    this.nextFrame += 1;
    return sequence;
  }

  subscribe(connection: ConnectionId): void {
    this.subscriberSet.add(connection);
  }

  unsubscribe(connection: ConnectionId): boolean {
    this.pauseOwners.delete(connection);
    return this.subscriberSet.delete(connection);
  }

  claimPause(connection: ConnectionId, paused: boolean): boolean {
    const before = this.paused;
    if (paused) this.pauseOwners.add(connection);
    else this.pauseOwners.delete(connection);
    return before !== this.paused;
  }

  releaseAll(connection: ConnectionId): boolean {
    this.subscriberSet.delete(connection);
    const wasPaused = this.paused;
    this.pauseOwners.delete(connection);
    return wasPaused && !this.paused;
  }

  clearPauses(): void {
    this.pauseOwners.clear();
  }

  summary(): SessionSummary {
    return {
      sessionKey: this.sessionKey,
      generation: this.generation,
      workspaceId: this.workspaceId,
      cwd: this.cwd,
      size: this.size,
      pid: this.pid ?? null,
      exited: isOver(this.state),
      exitCode: this.state.kind === "exited" ? (this.state.code ?? null) : null,
      subscribers: this.subscriberSet.size,
    };
  }
}

/** Every session this host owns. */
export class SessionTable {
  private readonly sessions = new Map<string, SessionEntry>();
  private drainingNow = false;

  get draining(): boolean {
    return this.drainingNow;
  }

  /**
   * Refuses new sessions from now on. Existing ones are untouched: an upgrade
   * must not take a CLI away from the user mid-sentence.
   */
  drain(): void {
    this.drainingNow = true;
  }

  /** True once draining and nothing is left to wait for. */
  get drained(): boolean {
    return this.drainingNow && this.allOver;
  }

  get(key: string): SessionEntry | undefined {
    return this.sessions.get(key);
  }

  /**
   * Ordered by key so `list` is stable across calls; a core reconciling
   * against it should not see rows shuffle. (`BTreeMap` gave the Rust host
   * this for free; a `Map` is insertion-ordered, so the sort is explicit.)
   */
  entries(): SessionEntry[] {
    return [...this.sessions.keys()]
      .sort()
      .map((key) => this.sessions.get(key) as SessionEntry);
  }

  get size(): number {
    return this.sessions.size;
  }

  summaries(): SessionSummary[] {
    return this.entries().map((entry) => entry.summary());
  }

  /**
   * Whether every session has ended. The idle-exit timer starts here, not at
   * "nobody is attached": a session with no subscriber is the normal state of
   * this process, and is exactly what it exists to keep alive.
   */
  get allOver(): boolean {
    return this.entries().every((entry) => isOver(entry.state));
  }

  /**
   * Registers a new session.
   *
   * A create against a key that already has a *running* session is a
   * conflict, not a takeover: the caller is out of date, and silently
   * replacing the session would strand a CLI the user is still using. A
   * create at or below an existing generation is stale for the same reason.
   */
  create(
    sessionKey: string,
    generation: number,
    workspaceId: string,
    cwd: string,
    size: HostSize,
  ): SessionEntry {
    if (this.drainingNow) {
      throw new SessionError(
        "draining",
        "the session host is draining for an upgrade",
      );
    }
    if (!Number.isInteger(generation) || generation < 1) {
      throw new SessionError("badRequest", "generation must be at least 1");
    }
    const existing = this.sessions.get(sessionKey);
    if (existing !== undefined) {
      if (!isOver(existing.state)) {
        throw new SessionError(
          "conflict",
          `${sessionKey} already has a running session at generation ${existing.generation}`,
        );
      }
      if (generation <= existing.generation) {
        throw new SessionError(
          "stale",
          `generation ${generation} is not newer than ${existing.generation}`,
        );
      }
    }
    const entry = new SessionEntry(
      sessionKey,
      generation,
      workspaceId,
      cwd,
      clampSize(size),
    );
    this.sessions.set(sessionKey, entry);
    return entry;
  }

  /** The session a request may act on, or why it may not. */
  current(key: string, generation: number): SessionEntry {
    const entry = this.sessions.get(key);
    if (entry === undefined) {
      throw new SessionError("notFound", `no session for ${key}`);
    }
    if (entry.generation !== generation) {
      throw new SessionError(
        "stale",
        `generation ${generation} is stale; the session is at ${entry.generation}`,
      );
    }
    if (isOver(entry.state)) {
      throw new SessionError("notFound", `${key} has ended`);
    }
    return entry;
  }

  /**
   * Subscribes a connection and returns the entry, so the caller can send the
   * replay in the same turn that registered the subscriber — there must be no
   * window in which output is produced but nobody is listed.
   */
  attach(
    key: string,
    generation: number,
    connection: ConnectionId,
    size: HostSize,
  ): SessionEntry {
    const entry = this.current(key, generation);
    entry.subscribe(connection);
    // The most recent attach owns the size, which is `window-size latest` by
    // another name: a phone glancing at a session must not shrink the TUI on
    // the desktop that is driving it, but the device that just arrived is the
    // one the user is looking at.
    entry.size = clampSize(size);
    return entry;
  }

  /** Unsubscribes without ending anything. Always releases the pause claim. */
  detach(key: string, connection: ConnectionId): boolean {
    return this.sessions.get(key)?.unsubscribe(connection) ?? false;
  }

  /**
   * A connection is gone. Removes it from every session, and reports the
   * sessions whose reader may now resume.
   */
  disconnect(connection: ConnectionId): string[] {
    const resumed: string[] = [];
    for (const entry of this.entries()) {
      if (entry.releaseAll(connection)) resumed.push(entry.sessionKey);
    }
    return resumed;
  }

  /**
   * Sets or clears one connection's pause claim. Returns whether the
   * session's overall paused state changed.
   */
  setFlow(key: string, connection: ConnectionId, paused: boolean): boolean {
    return this.sessions.get(key)?.claimPause(connection, paused) ?? false;
  }

  /**
   * Records that a session's process ended. Idempotent: the exit watcher and
   * the reader's EOF both report it, and only the first counts.
   */
  markExited(
    key: string,
    generation: number,
    code: number | undefined,
  ): boolean {
    const entry = this.sessions.get(key);
    if (entry === undefined) return false;
    if (entry.generation !== generation || isOver(entry.state)) return false;
    entry.state = { kind: "exited", code };
    entry.clearPauses();
    return true;
  }

  /**
   * Forgets a session entirely. The caller is responsible for having ended its
   * process first; this only removes the bookkeeping.
   */
  remove(key: string): SessionEntry | undefined {
    const entry = this.sessions.get(key);
    this.sessions.delete(key);
    return entry;
  }
}
