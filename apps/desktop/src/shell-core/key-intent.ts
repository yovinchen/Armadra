/**
 * Who acts on a claimed chord: the page, or the shell.
 *
 * `keydown-intercept.ts` decides WHAT a chord means; this decides who
 * performs it. ⌘W is the case that forced the question. The shell's half of
 * "close" is the window, and the page's half is the selected canvas node —
 * and the page is the only side that knows whether there is one. The shell
 * used to send the intent and close the window in the same breath, so the
 * page's half could never run: every ⌘W hid the whole window, node or no
 * node.
 *
 * So the shell ASKS. It hands the page an intent and a token, and:
 *
 *   * the page answers `handled: true` when it closed a node, and the shell
 *     does nothing more;
 *   * the page answers `handled: false` when there was nothing to close, and
 *     the shell performs its own half;
 *   * the page does not answer at all — it is busy, it crashed, it is an
 *     older build that never subscribed — and after
 *     `KEY_INTENT_REPLY_TIMEOUT_MS` the shell performs its own half anyway.
 *
 * That third branch is the rule the whole design turns on: **⌘W must never
 * become a key that does nothing.** A missing answer is a slow window close,
 * not a broken one.
 *
 * The token exists so a late answer cannot act on a chord that was already
 * settled. Every token is answered exactly once, by whichever of the page and
 * the timer gets there first.
 */

import type { KeyIntent } from "./keydown-intercept";

/**
 * How long the shell waits for the page.
 *
 * Long enough for an IPC round trip through a busy renderer, short enough
 * that a page which will never answer does not leave ⌘W feeling broken.
 */
export const KEY_INTENT_REPLY_TIMEOUT_MS = 400;

export type KeyIntentVerdict =
  /** The page did not take it; the shell performs its own half. */
  | "shell"
  /** The page handled it; the shell does nothing. */
  | "page"
  /** Already settled, or never issued. Nothing happens. */
  | "stale";

export interface KeyIntentOutcome {
  readonly verdict: KeyIntentVerdict;
  /** What was claimed, or `null` for a token nobody issued. */
  readonly intent: KeyIntent | null;
}

/**
 * PURE (no timers, no Electron): the ledger of chords waiting for an answer.
 *
 * The caller owns the clock — it calls `settle(token, false)` when its timer
 * fires — which is what lets the timeout rule be tested without waiting.
 */
export class KeyIntentArbiter {
  private readonly pending = new Map<string, KeyIntent>();
  private issued = 0;

  /** Claims a chord and returns the token the answer must carry. */
  open(intent: KeyIntent): string {
    this.issued += 1;
    const token = `intent-${this.issued}`;
    this.pending.set(token, intent);
    return token;
  }

  /**
   * Answers one token, once. `handled` is whatever arrived over IPC, so it is
   * compared against `true` rather than trusted to be a boolean.
   */
  settle(token: unknown, handled: unknown): KeyIntentOutcome {
    if (typeof token !== "string") return { verdict: "stale", intent: null };
    const intent = this.pending.get(token);
    if (intent === undefined) return { verdict: "stale", intent: null };
    this.pending.delete(token);
    return { verdict: handled === true ? "page" : "shell", intent };
  }

  /** How many chords are still waiting. A settled shell leaks none. */
  waiting(): number {
    return this.pending.size;
  }
}
