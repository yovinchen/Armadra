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
 *     CLI asked for; `?…u`, the keyboard-protocol flags reply; `?…$y`, a mode
 *     report) is not the user typing, and must not count as pending.
 *     Everything else that looks like an escape does.
 *   * An OSC / DCS / APC / PM string (`ESC ]`, `ESC P`, `ESC _`, `ESC ^`,
 *     through BEL or `ESC \`) is always a reply: a keyboard cannot produce
 *     one. Codex asks for the foreground and background colours and the
 *     keyboard flags at startup, and counting those answers as a half-typed
 *     line kept its first delivery queued until it expired.
 *   * `\r` or `\n` outside a paste submits: the line is gone and the machine
 *     is clean again.
 */
export class InputSafety {
  /** A half-typed line is sitting in the terminal. */
  pending = false;
  private inPaste = false;
  private escape: number[] = [];
  /** Inside an OSC / DCS / APC / PM string; the bytes are discarded. */
  private inString = false;
  private stringLength = 0;
  private stringEscape = false;

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
      if (this.inString) {
        if (byte === 0x07 || (this.stringEscape && byte === 0x5c)) {
          this.inString = false;
          this.stringEscape = false;
          continue;
        }
        this.stringEscape = byte === 0x1b;
        this.stringLength += 1;
        // A string that never terminates is not a reply we are waiting out:
        // after this much it is treated as typing, like an unterminated CSI.
        if (this.stringLength > MAX_REPLY_STRING) {
          this.inString = false;
          this.stringEscape = false;
          this.pending = true;
          edited = true;
        }
        continue;
      }
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
        if (this.escape.length === 2 && STRING_INTRODUCERS.includes(byte)) {
          this.inString = true;
          this.stringLength = 0;
          this.stringEscape = false;
          this.escape = [];
          continue;
        }
        if (
          this.escape.length >= 3 &&
          this.escape[1] === 0x5b /* [ */ &&
          byte >= 0x40 &&
          byte <= 0x7e
        ) {
          const body = this.escape.slice(2, this.escape.length - 1);
          if (!isTerminalReply(body, byte)) {
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

/** `]` OSC, `P` DCS, `_` APC, `^` PM: string sequences only a terminal sends. */
const STRING_INTRODUCERS: readonly number[] = [0x5d, 0x50, 0x5f, 0x5e];

/** Longest reply string waited out before it counts as typing. */
const MAX_REPLY_STRING = 4096;

/**
 * Whether a CSI sequence (parameter bytes, final byte) is a terminal's answer
 * to a query rather than a key.
 *
 * `u` and `y` need the `?` prefix: without it `CSI 97 u` is a key press under
 * the keyboard protocol, and only the flags reply (`CSI ? 1 u`) and the mode
 * report (`CSI ? 2026 ; 2 $ y`) are answers.
 */
function isTerminalReply(body: readonly number[], final: number): boolean {
  const numeric = (value: number) =>
    (value >= 0x30 && value <= 0x39) ||
    value === 0x3b ||
    value === 0x3f ||
    value === 0x3e;
  switch (final) {
    case 0x63: // c — device attributes
    case 0x52: // R — cursor position
    case 0x6e: // n — device status
      return body.every(numeric);
    case 0x75: // u — keyboard protocol flags
      return body[0] === 0x3f && body.every(numeric);
    case 0x79: // y — mode report, `$` is its intermediate byte
      return (
        body[0] === 0x3f &&
        body[body.length - 1] === 0x24 &&
        body.slice(0, -1).every(numeric)
      );
    default:
      return false;
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

/* ------------------------------- drive gate -------------------------------- */

/**
 * 谁开的这个会话，以及一次写入是不是在写别人的终端。
 *
 * `docs/design/server-accounts-and-sharing.md` §4.4 / S5：向**自己**开的终端写
 * 入不需要额外授权，向**别人**开的终端写入需要 `terminal:drive`。分出这一档的
 * 理由不是礼貌，是终端写入会替 Agent 回答权限提示（契约 §15.6 的安全门就在这
 * 个文件的上半截）——那是一次代答，必须是显式授予。
 *
 * 今天每一个会话的创建者都是本机 owner，每一个写入者也是，所以这道门恒通过。
 * 它现在就在这里，是因为「哪些写入路径要判定」这件事等到有第二个 principal
 * 时再找一遍，找漏一条就是一个人替另一个人点了「允许」。
 */
export interface TerminalWriter {
  /** 空串 = 本机 owner（今天所有的写入者）。 */
  readonly principalId: string;
}

export class DriveBook {
  private readonly sessions = new Map<
    string,
    { readonly workspaceId: string; readonly creator: string }
  >();

  /** 记下创建者。`creator` 为空串表示本机 owner。 */
  remember(sessionId: string, workspaceId: string, creator = ""): void {
    this.sessions.set(sessionId, { workspaceId, creator });
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  creator(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.creator;
  }

  /**
   * 这次写入允不允许。
   *
   * 写入者与创建者相同（含两者都是 owner 的今天）直接通过；不同才去问判定入口
   * 要 `terminal:drive@workspace`。会话没被记过也通过：那是这个进程没见过其创
   * 建的会话（重启后恢复的那些），拒绝它等于把人自己的终端锁上。
   */
  permits(
    sessionId: string,
    writer: TerminalWriter | undefined,
    allow: (workspaceId: string) => boolean,
  ): boolean {
    const known = this.sessions.get(sessionId);
    if (known === undefined) return true;
    const writerId = writer?.principalId ?? "";
    if (writerId === known.creator) return true;
    return allow(known.workspaceId);
  }
}
