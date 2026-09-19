/**
 * Attachment leases and the dormancy budget a detached session falls back to.
 *
 * Two questions, one table:
 *
 *   * **How many sockets are watching this session right now?** Not a flag:
 *     several devices may watch one terminal, and the answer decides whether
 *     the session is idle at all.
 *   * **Since when have there been none?** The dormancy deadline is measured
 *     from that moment, and only from it.
 *
 * ## Why an explicit release rather than a `Drop`
 *
 * The Rust side counts with an `AttachLease` whose `Drop` releases it, because
 * the socket handler has several early returns and a panic path and none of
 * them may leave a session counted as watched for ever. TypeScript has no
 * `Drop`, so the guarantee has to come from the one place that always runs:
 * the socket's `close` handler, which is also where the backend detach
 * happens. {@link AttachmentBook.release} is idempotent for exactly that
 * reason — being called twice is normal, and being called zero times is the
 * bug this shape makes visible.
 *
 * ## The clock a test can move
 *
 * `now` is injected. A dormancy test that had to sleep through a two-minute
 * default would either be skipped or be flaky, and the policy is worth
 * asserting exactly: a session with a socket is never due, a session that just
 * lost its last socket is not due yet, and one that attached again has its
 * idle clock reset to nothing rather than merely extended.
 */

interface Entry {
  /** Live sockets. */
  sockets: number;
  /** When `sockets` last fell to zero; `undefined` while something watches. */
  idleSince: number | undefined;
  dormant: boolean;
}

export class AttachmentBook {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Registers a session before anything attaches to it.
   *
   * Doing this at create time rather than on the first attach is what makes a
   * terminal that is created and never opened — a scripted spawn, a node
   * restored off-screen — eligible for dormancy at all.
   */
  register(sessionId: string): void {
    if (this.entries.has(sessionId)) return;
    this.entries.set(sessionId, {
      sockets: 0,
      idleSince: this.now(),
      dormant: false,
    });
  }

  /** One more socket is watching. Clears the idle clock outright. */
  acquire(sessionId: string): void {
    const entry = this.entry(sessionId);
    entry.sockets += 1;
    entry.idleSince = undefined;
  }

  /** One fewer socket. Idempotent: a double release cannot go negative. */
  release(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.sockets === 0) return;
    entry.sockets -= 1;
    if (entry.sockets === 0) entry.idleSince = this.now();
  }

  /**
   * Clears the dormant flag, answering whether it had been set — so the caller
   * only pays for a backend round trip when there is something to undo.
   */
  takeDormant(sessionId: string): boolean {
    const entry = this.entry(sessionId);
    const was = entry.dormant;
    entry.dormant = false;
    return was;
  }

  /**
   * Whether this session has been put to sleep. The process is running either
   * way; this only says how its output is being delivered.
   */
  isDormant(sessionId: string): boolean {
    return this.entries.get(sessionId)?.dormant ?? false;
  }

  /** How many sockets are watching this session right now. */
  sockets(sessionId: string): number {
    return this.entries.get(sessionId)?.sockets ?? 0;
  }

  /** The sessions that have been unwatched for longer than `afterMs`. */
  due(afterMs: number): string[] {
    const now = this.now();
    const due: string[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.dormant || entry.sockets > 0) continue;
      if (entry.idleSince === undefined) continue;
      if (now - entry.idleSince >= afterMs) due.push(id);
    }
    return due;
  }

  /**
   * Marks one session dormant, but only while it is still unwatched: the
   * backend call that precedes this is asynchronous, and a socket that arrived
   * during it must win.
   */
  markDormant(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.sockets > 0) return;
    entry.dormant = true;
  }

  forget(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /** Moves a session's idle clock back, so a test need not sleep through it. */
  backdate(sessionId: string, byMs: number): void {
    const entry = this.entries.get(sessionId);
    if (entry?.idleSince === undefined) return;
    entry.idleSince -= byMs;
  }

  private entry(sessionId: string): Entry {
    let entry = this.entries.get(sessionId);
    if (entry === undefined) {
      entry = { sockets: 0, idleSince: this.now(), dormant: false };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }
}
