/**
 * Stopping a transfer that is already running (design §2.1 `downloading →
 * available`). Ported from the Rust shell this one replaced.
 *
 * electron-updater hands out no abort handle either: `downloadUpdate()` is one
 * promise that either resolves or does not. So the shell keeps the only handle
 * there is — the ability to stop awaiting it — and pairs each transfer with a
 * token it also races against.
 *
 * Two races decide the shape of this type, and both are resolved in favour of
 * "never act on a transfer that is no longer the current one":
 *
 * 1. **A late finish must not disarm the next transfer.** `finish` only clears
 *    the slot when the token it is handed is still the armed one, so a
 *    transfer that was cancelled and then completed anyway leaves the token of
 *    the download started afterwards alone.
 * 2. **Two transfers must not run at once.** `arm` cancels whatever it
 *    replaces rather than leaving it orphaned with nobody able to stop it.
 *
 * The token stores its permit — a cancel that arrives between arming and the
 * first `notified()` still stops the transfer instead of being lost, which is
 * why the Rust version used `notify_one` rather than `notify_waiters`.
 */

/** One transfer's token. Resolving is one-way, and a stored permit is kept. */
export class CancelToken {
  private fired = false;
  private readonly waiters: (() => void)[] = [];

  /** Resolves once this token is cancelled, whenever that happened. */
  notified(): Promise<void> {
    if (this.fired) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Whether the permit has already been stored. */
  isCancelled(): boolean {
    return this.fired;
  }

  /** Internal: only `Cancellation` decides when a token fires. */
  fire(): void {
    if (this.fired) return;
    this.fired = true;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

/** The transfer in flight, and the one way to stop it. */
export class Cancellation {
  private armedToken: CancelToken | null = null;

  /**
   * Registers a transfer and returns the token it must race against.
   *
   * Anything already armed is cancelled: the state machine only models one
   * transfer, and an orphaned one would keep writing progress for an offer
   * nobody is waiting for.
   */
  arm(): CancelToken {
    const token = new CancelToken();
    const previous = this.armedToken;
    this.armedToken = token;
    previous?.fire();
    return token;
  }

  /**
   * Stops the transfer in flight. `false` when there was none, which is how
   * the handler tells "cancelled" from "there was nothing to cancel".
   */
  cancel(): boolean {
    const token = this.armedToken;
    if (token === null) return false;
    this.armedToken = null;
    token.fire();
    return true;
  }

  /**
   * Retires a token whose transfer ended on its own.
   *
   * A token that is no longer the armed one is ignored — see the race note on
   * the type.
   */
  finish(token: CancelToken): void {
    if (this.armedToken === token) this.armedToken = null;
  }

  /** Whether a transfer is registered right now. */
  isArmed(): boolean {
    return this.armedToken !== null;
  }
}
