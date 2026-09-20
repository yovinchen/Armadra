/**
 * Reconnect policy for one execution host.
 *
 * Ported from the pre-merge implementation, arithmetic
 * included — the off-by-one that file's comment describes is the reason the
 * table is indexed by *failures so far* rather than by the failure count.
 *
 * An unreachable host must cost one attempt per request window rather than an
 * `ssh` storm: consecutive failures back off, and after the attempt budget the
 * host is parked for a cooldown during which connecting is refused outright. A
 * user-initiated probe clears the park, because "still parked" is a useless
 * answer to somebody who just pressed a button.
 */

/** Consecutive connect failures before the host is parked. */
export const MAX_CONNECT_ATTEMPTS = 3;

/** Backoff between those attempts, and the park after the last one. */
export const RECONNECT_BACKOFF_MS = [250, 1_000, 4_000] as const;

export const COOLDOWN_MS = 30_000;

export class Supervisor<Connection extends { close(): void }> {
  connection: Connection | undefined;
  /** Consecutive failed connects. */
  failures = 0;
  /** When connecting is allowed again after the attempt budget ran out. */
  private parkedUntil: number | undefined;
  /**
   * The Worker's own release when it differs from this build's, kept so the
   * node badge survives between requests.
   */
  versionBadge: string | undefined;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Whether connecting is currently refused, and clears an expired park. */
  parked(): boolean {
    if (this.parkedUntil === undefined) return false;
    if (this.now() < this.parkedUntil) return true;
    this.parkedUntil = undefined;
    this.failures = 0;
    return false;
  }

  /**
   * How long to wait before the next attempt.
   *
   * Indexed by failures so far, so the first retry waits the table's first
   * entry. Indexing by the failure count itself would skip the 250 ms entry
   * and make the cheapest case — one dropped session, immediately
   * reconnectable — wait a full second.
   */
  backoffMs(): number | undefined {
    if (this.failures === 0) return undefined;
    const index = Math.min(this.failures - 1, MAX_CONNECT_ATTEMPTS - 1);
    return RECONNECT_BACKOFF_MS[index];
  }

  succeeded(connection: Connection, versionBadge: string | undefined): void {
    this.connection = connection;
    this.failures = 0;
    this.versionBadge = versionBadge;
  }

  failed(): void {
    this.failures += 1;
    if (this.failures >= MAX_CONNECT_ATTEMPTS) {
      this.parkedUntil = this.now() + COOLDOWN_MS;
    }
  }

  /** A user asked directly. Forget the park and the failure count. */
  resume(): void {
    this.parkedUntil = undefined;
    this.failures = 0;
    this.connection?.close();
    this.connection = undefined;
  }
}
