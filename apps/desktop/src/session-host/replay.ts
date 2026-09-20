/**
 * What a re-attaching client is shown, and what answers ConPTY while nobody
 * is attached at all.
 *
 * Two jobs, both consequences of the host outliving every UI:
 *
 * 1. **Replay.** A session may run for hours with no subscriber. When one
 *    arrives it needs the recent past, so the host keeps a bounded tail of
 *    raw output. Not a headless VT *screen* — that library is still unpicked
 *    — and honestly labelled as a byte tail rather than dressed up as a
 *    redraw. It is the same contract the direct backend already has.
 *
 * 2. **Answering the terminal.** ConPTY asks the terminal where the cursor is
 *    and waits for the reply before it will emit anything. Here there may be
 *    no UI at all — that is the entire point of the process — so the host has
 *    to answer, or the session deadlocks at creation and again at every close.
 *
 * A line-by-line port of the pre-merge implementation, kept
 * line-by-line on purpose: {@link safeCut} is the kind of function whose bugs
 * are invisible until a user's screen has a replacement character in it
 * forever, and "the Rust one did it this way" is a far stronger argument than
 * a fresh derivation. Its unit tests are ported with it.
 */

/**
 * How much output one session keeps for the next attach. Two hundred KiB is
 * several screens of a TUI redraw and a few thousand lines of plain log
 * output, at a cost the host pays per session for its whole life.
 */
export const DEFAULT_CAPACITY = 200 * 1024;

/** The smallest capacity that is still a capacity. */
const MINIMUM_CAPACITY = 1024;

/**
 * A bounded tail of a session's output.
 *
 * Trimming happens at a boundary that is safe to *start reading from*, never
 * at an arbitrary byte: cutting a UTF-8 sequence in half puts a replacement
 * character on screen forever, and cutting an escape sequence in half feeds
 * xterm a fragment it will interpret as text.
 */
export class ReplayBuffer {
  private bytes: Buffer = Buffer.alloc(0);
  private readonly capacity: number;
  /**
   * Whether anything has ever been dropped. A client that knows its replay is
   * partial can say so instead of implying it is the whole history.
   */
  private dropped = false;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = Math.max(MINIMUM_CAPACITY, Math.trunc(capacity));
  }

  push(chunk: Buffer): void {
    this.bytes =
      this.bytes.byteLength === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.bytes, chunk]);
    if (this.bytes.byteLength <= this.capacity) return;
    const target = this.bytes.byteLength - this.capacity;
    const cut = safeCut(this.bytes, target);
    this.bytes = Buffer.from(this.bytes.subarray(cut));
    this.dropped = true;
  }

  snapshot(): Buffer {
    return this.bytes;
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  get empty(): boolean {
    return this.bytes.byteLength === 0;
  }

  get truncated(): boolean {
    return this.dropped;
  }

  /** A session that ended and was recycled starts its replay over. */
  clear(): void {
    this.bytes = Buffer.alloc(0);
    this.dropped = false;
  }
}

/**
 * The first index at or after `from` that a client may safely start reading.
 *
 * Safe means: not inside a UTF-8 sequence, and not inside an escape sequence.
 * The search is bounded — a stream of pathological escapes must not make this
 * walk the whole buffer — and falls back to `from` rounded up to a character
 * boundary, which is the lesser of two evils.
 */
export function safeCut(bytes: Buffer, from: number): number {
  if (from >= bytes.byteLength) return bytes.byteLength;
  let index = Math.max(0, from);
  // A continuation byte means we are mid-character; walk to the start of the
  // next one.
  while (
    index < bytes.byteLength &&
    ((bytes[index] as number) & 0b1100_0000) === 0b1000_0000
  ) {
    index += 1;
  }
  const characterBoundary = index;
  // If the cut lands inside an escape sequence, skip to just past it. The
  // window is generous enough for an OSC title and small enough that a stream
  // of ESC bytes cannot turn this into a scan of the whole buffer.
  const WINDOW = 4096;
  const limit = Math.min(bytes.byteLength, index + WINDOW);
  // Look backwards a little: an ESC just before the cut means the bytes at the
  // cut are that sequence's tail.
  const back = Math.max(0, index - WINDOW);
  let escapeStart: number | undefined;
  for (let candidate = index - 1; candidate >= back; candidate -= 1) {
    const byte = bytes[candidate] as number;
    if (byte === 0x1b) {
      escapeStart = candidate;
      break;
    }
    // A printable run between the cut and the last ESC means the cut is not
    // inside a sequence.
    if (byte === 0x0a || byte === 0x0d) break;
  }
  if (escapeStart !== undefined) {
    const end = escapeEnd(
      bytes.subarray(escapeStart, Math.max(limit, escapeStart)),
    );
    if (end !== undefined && escapeStart + end > index) {
      index = escapeStart + end;
    }
  }
  return Math.max(characterBoundary, Math.min(index, bytes.byteLength));
}

/**
 * Length of the escape sequence starting at `bytes[0]`, or `undefined` when
 * it is not terminated inside the slice.
 */
export function escapeEnd(bytes: Buffer): number | undefined {
  if (bytes[0] !== 0x1b) return undefined;
  const second = bytes[1];
  if (second === undefined) return undefined;
  switch (second) {
    // CSI: parameters, then a final byte in @..~.
    case 0x5b /* [ */: {
      for (let index = 2; index < bytes.byteLength; index += 1) {
        const byte = bytes[index] as number;
        if (byte >= 0x40 && byte <= 0x7e) return index + 1;
      }
      return undefined;
    }
    // OSC / DCS / APC / PM: terminated by BEL or ST.
    case 0x5d /* ] */:
    case 0x50 /* P */:
    case 0x5f /* _ */:
    case 0x5e /* ^ */: {
      let index = 2;
      while (index < bytes.byteLength) {
        if (bytes[index] === 0x07) return index + 1;
        if (bytes[index] === 0x1b && bytes[index + 1] === 0x5c)
          return index + 2;
        index += 1;
      }
      return undefined;
    }
    // Two-byte sequences: charset selection and friends.
    case 0x28 /* ( */:
    case 0x29 /* ) */:
    case 0x2a /* * */:
    case 0x2b /* + */:
    case 0x23 /* # */:
      return bytes.byteLength > 2 ? 3 : undefined;
    default:
      return 2;
  }
}

/* ------------------------------ device queries ----------------------------- */

/**
 * The cursor position the host reports when it has to answer for the
 * terminal.
 *
 * The host does not emulate a screen, so it cannot know the real cursor
 * position. It answers with the home position, which is what ConPTY's
 * `INHERIT_CURSOR` handshake needs to get past the question — it is starting
 * a fresh console, and a fresh console's cursor is at 1;1.
 */
export const HOME: readonly [number, number] = [1, 1];

/**
 * Scans terminal output for queries that expect a reply on the input side,
 * and produces those replies.
 *
 * Only the queries that can *block* are answered. A terminal that answers
 * everything would be lying about capabilities it does not have; a terminal
 * that answers nothing deadlocks a ConPTY created with `INHERIT_CURSOR`, and
 * deadlocks again when the console is closed.
 */
export class QueryResponder {
  /** Bytes held because they may be the start of a sequence split across reads. */
  private pending: number[] = [];

  /**
   * Feeds output bytes, returning what must be written back to the PTY.
   *
   * Returns an empty buffer for the overwhelming majority of output, which is
   * the point: this is on the hot path of every byte the session produces.
   */
  observe(chunk: Buffer): Buffer {
    const reply: number[] = [];
    for (const byte of chunk) {
      if (this.pending.length === 0) {
        if (byte === 0x1b) this.pending.push(byte);
        continue;
      }
      this.pending.push(byte);
      // Not a CSI after all.
      if (this.pending.length === 2 && byte !== 0x5b) {
        this.pending = byte === 0x1b ? [0x1b] : [];
        continue;
      }
      if (this.pending.length >= 3 && byte >= 0x40 && byte <= 0x7e) {
        const answer = answerFor(this.pending);
        if (answer !== undefined) reply.push(...answer);
        this.pending = [];
        continue;
      }
      // A "sequence" this long is not one; drop it rather than grow.
      if (this.pending.length > 64) this.pending = [];
    }
    return Buffer.from(reply);
  }
}

/** The reply to one complete CSI sequence, if it is a query this host answers. */
function answerFor(sequence: readonly number[]): Buffer | undefined {
  if (sequence.length < 3) return undefined;
  const body = Buffer.from(sequence.slice(2, sequence.length - 1)).toString(
    "latin1",
  );
  const final = sequence[sequence.length - 1] as number;
  if (final === 0x6e /* n */) {
    // DSR. `5` asks whether the terminal is OK, `6` asks where the cursor is;
    // `?6` is the DEC variant ConPTY uses.
    if (body === "5") return Buffer.from("\u001b[0n", "latin1");
    if (body === "6") {
      return Buffer.from(`\u001b[${HOME[0]};${HOME[1]}R`, "latin1");
    }
    if (body === "?6") {
      return Buffer.from(`\u001b[?${HOME[0]};${HOME[1]}R`, "latin1");
    }
    return undefined;
  }
  // Primary device attributes: "a VT100 with no options", which is the least
  // this can claim and still be a terminal.
  if (final === 0x63 /* c */ && (body === "" || body === "0")) {
    return Buffer.from("\u001b[?1;0c", "latin1");
  }
  return undefined;
}
