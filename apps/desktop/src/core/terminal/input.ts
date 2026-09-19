/**
 * Everything a caller may push into a session, and the two ledgers that decide
 * what happens to it: the input-sequence marks a reconnecting client resends
 * from, and the safety gate that says whether a write is allowed at all.
 *
 * Neither is a security boundary. The socket is already authorised before a
 * byte reaches here; what these do is keep a terminal from lying to the person
 * in front of it — about what it received, and about what it is doing.
 */

/**
 * How many independent writers one session remembers.
 *
 * A terminal has one keyboard; the extra room is for a reconnect that overlaps
 * its predecessor. Past it the session forgets them all, which costs a client
 * at most one unnecessary resend of input it already knows was never
 * acknowledged.
 */
export const MAX_TRACKED_WRITERS = 8;

/**
 * `session id -> writer id -> highest input id actually written`.
 *
 * A client that loses its socket cannot tell whether the keystrokes it had
 * sent reached the pty. This is the answer: on the next attach it asks what
 * its own writer already reached, and resends only what is above that mark.
 *
 * Nothing here authorises anything — a writer id is a client's own label for
 * its input stream, checked against nothing, and the worst a forged one can do
 * is make that client resend its own keystrokes.
 */
export class InputLedger {
  private readonly marks = new Map<string, Map<string, number>>();

  /**
   * Records that `inputId` from `writerId` reached the pty.
   *
   * Only ever moves forward: an out-of-order or repeated frame cannot lower
   * the mark a reconnecting client resends from, which is the one way this
   * could cause a keystroke to be applied twice.
   */
  applied(sessionId: string, writerId: string, inputId: number): void {
    if (writerId === "" || !(inputId > 0)) return;
    let writers = this.marks.get(sessionId);
    if (writers === undefined) {
      writers = new Map();
      this.marks.set(sessionId, writers);
    }
    if (writers.size >= MAX_TRACKED_WRITERS && !writers.has(writerId)) {
      writers.clear();
    }
    writers.set(writerId, Math.max(writers.get(writerId) ?? 0, inputId));
  }

  /**
   * The highest input this session applied for `writerId`; `0` when it has
   * never seen that writer, which is the safe answer — the client then resends
   * whatever it still holds unacknowledged.
   */
  acknowledged(sessionId: string, writerId: string): number {
    if (writerId === "") return 0;
    return this.marks.get(sessionId)?.get(writerId) ?? 0;
  }

  /**
   * Forgets a session's marks.
   *
   * Called when the session is forgotten, and on a recycle. The marks describe
   * a pty that no longer exists; keeping them would let a later session with
   * the same id claim input it never wrote.
   */
  forget(sessionId: string): void {
    this.marks.delete(sessionId);
  }
}

/* ------------------------------- safety gate ------------------------------- */

/**
 * What the bytes a caller wrote did to the session's line, as a state machine
 * over the input stream itself.
 *
 * It exists for one question: **is there a half-typed line sitting in this
 * terminal right now?** A scheduled prompt that pastes into a pane whose user
 * has typed half a command would concatenate the two and run the result, and
 * "has the user typed something since the last Enter" is not answerable from
 * output — a CLI may echo nothing at all.
 *
 * The parsing is only as deep as that question needs:
 *
 *   * A bracketed-paste opener puts the machine in paste mode, where newlines
 *     are data rather than submissions.
 *   * A CSI sequence that is a terminal **response** (`c`, `R`, `n` with a
 *     numeric/`;?>` body — a device attributes or cursor-position reply the
 *     CLI asked for) is not the user typing, and must not count as pending.
 *     Everything else that looks like an escape does.
 *   * `\r` or `\n` outside a paste submits: the line is gone and the machine
 *     is clean again.
 */
export class InputSafety {
  /** A half-typed line is sitting in the terminal. */
  pending = false;
  private inPaste = false;
  private escape: number[] = [];

  /**
   * Feeds bytes through. Returns whether anything changed (`edited`, which
   * advances the session's input revision) and whether this write crossed a
   * line boundary (`fence`, which is the moment a scheduled turn becomes
   * attributable or stops being so).
   */
  consume(data: Buffer): { edited: boolean; fence: boolean } {
    const wasPending = this.pending;
    let edited = false;
    let submitted = false;
    for (const byte of data) {
      if (this.escape.length > 0) {
        this.escape.push(byte);
        if (this.matches(PASTE_START_BYTES)) {
          this.inPaste = true;
          this.pending = true;
          edited = true;
          this.escape = [];
          continue;
        }
        if (this.matches(PASTE_END_BYTES)) {
          this.inPaste = false;
          this.escape = [];
          continue;
        }
        if (
          isPrefix(this.escape, PASTE_START_BYTES) ||
          isPrefix(this.escape, PASTE_END_BYTES)
        ) {
          continue;
        }
        if (
          this.escape.length >= 3 &&
          this.escape[1] === 0x5b /* [ */ &&
          byte >= 0x40 &&
          byte <= 0x7e
        ) {
          const body = this.escape.slice(2, this.escape.length - 1);
          const response =
            (byte === 0x63 || byte === 0x52 || byte === 0x6e) &&
            body.every(
              (value) =>
                (value >= 0x30 && value <= 0x39) ||
                value === 0x3b ||
                value === 0x3f ||
                value === 0x3e,
            );
          if (!response) {
            this.pending = true;
            edited = true;
          }
          this.escape = [];
          continue;
        }
        // A sequence that never terminates, or an `ESC x` that is not a CSI:
        // treated as typing rather than held open for ever.
        if (
          this.escape.length > 64 ||
          (this.escape.length === 2 && byte !== 0x5b)
        ) {
          this.pending = true;
          edited = true;
          this.escape = [];
        }
        continue;
      }
      if (byte === 0x1b) {
        this.escape.push(byte);
        continue;
      }
      if (!this.inPaste && (byte === 0x0d || byte === 0x0a)) {
        this.pending = false;
        submitted = true;
        edited = true;
        continue;
      }
      this.pending = true;
      edited = true;
    }
    return { edited, fence: submitted || (!wasPending && this.pending) };
  }

  private matches(wanted: readonly number[]): boolean {
    return (
      this.escape.length === wanted.length &&
      this.escape.every((byte, index) => byte === wanted[index])
    );
  }
}

const PASTE_START_BYTES = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e];
const PASTE_END_BYTES = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e];

function isPrefix(value: readonly number[], of: readonly number[]): boolean {
  return (
    value.length <= of.length &&
    value.every((byte, index) => byte === of[index])
  );
}

/* -------------------------------- write gate ------------------------------- */

/**
 * The states in which a node must not be written to (contract §15.6, 安全).
 *
 * `blocked` and `waiting` mean the CLI is showing a permission prompt or an
 * approval question. A paste delivered into one of those answers the prompt —
 * the first character of the pasted text becomes the answer to "allow this?" —
 * which is the one input mistake that cannot be undone by pressing Ctrl+C. So
 * an automated write into such a node is refused, and the person is left to
 * answer their own prompt.
 *
 * Typing is **not** gated: a user looking at their own prompt is entitled to
 * answer it. Only the scheduled and programmatic paths go through here.
 */
export const BLOCKED_STATES: readonly string[] = ["blocked", "waiting"];

export function writableState(state: string | null | undefined): boolean {
  return (
    state === null || state === undefined || !BLOCKED_STATES.includes(state)
  );
}
