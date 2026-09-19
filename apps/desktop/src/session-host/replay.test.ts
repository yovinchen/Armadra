import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPACITY,
  QueryResponder,
  ReplayBuffer,
  escapeEnd,
  safeCut,
} from "./replay";

/**
 * The Rust unit tests of `crates/session-host/src/replay.rs`, ported one for
 * one, plus the cases the port itself makes possible to state.
 *
 * They matter more here than they did there. The Rust version could at least
 * be cross-compiled and read by a borrow checker; this one is JavaScript on a
 * machine with no ConPTY, so these assertions are the entire evidence that
 * the trimming rule survived the move.
 */

const ESC = "\u001b";

describe("replay buffer", () => {
  it("keeps the tail and says when it dropped something", () => {
    const buffer = new ReplayBuffer(1024);
    expect(buffer.empty).toBe(true);
    buffer.push(Buffer.from("hello"));
    expect(buffer.snapshot().toString()).toBe("hello");
    expect(buffer.truncated).toBe(false);

    buffer.push(Buffer.alloc(4096, 0x78));
    expect(buffer.length).toBeLessThanOrEqual(1024);
    expect(buffer.truncated).toBe(true);
    expect([...buffer.snapshot()].every((byte) => byte === 0x78)).toBe(true);

    buffer.clear();
    expect(buffer.empty).toBe(true);
    expect(buffer.truncated).toBe(false);
  });

  it("defaults to the 200 KiB the design asks for", () => {
    const buffer = new ReplayBuffer();
    buffer.push(Buffer.alloc(DEFAULT_CAPACITY * 2, 0x61));
    expect(buffer.length).toBeLessThanOrEqual(DEFAULT_CAPACITY);
    expect(buffer.length).toBeGreaterThan(DEFAULT_CAPACITY - 4096);
  });

  /**
   * The failure this guards against is silent: a cut inside a multi-byte
   * character leaves a replacement character on screen for the rest of the
   * session.
   */
  it("never cuts a character in half", () => {
    const text = "中文和 emoji 🙂 混在一起".repeat(200);
    for (const capacity of [1024, 2048, 4096, 8192]) {
      const buffer = new ReplayBuffer(capacity);
      buffer.push(Buffer.from(text, "utf8"));
      const decoded = buffer.snapshot().toString("utf8");
      expect(
        decoded.includes("�"),
        `capacity ${capacity} produced a broken character`,
      ).toBe(false);
    }
  });

  /**
   * A cut inside an escape sequence is worse than a lost line: xterm renders
   * the fragment as text.
   */
  it("never starts inside an escape sequence", () => {
    const stream: string[] = [];
    for (let index = 0; index < 600; index += 1) {
      stream.push(
        `${ESC}[${index % 40};1H${ESC}[38;5;${index % 256}mrow${ESC}[0m\r\n`,
      );
    }
    const buffer = new ReplayBuffer(4096);
    buffer.push(Buffer.from(stream.join(""), "utf8"));
    const snapshot = buffer.snapshot();
    expect(snapshot.byteLength).toBeGreaterThan(0);
    const first = snapshot[0] as number;
    const graphic = first >= 0x21 && first <= 0x7e;
    const whitespace = [0x09, 0x0a, 0x0d, 0x20, 0x0b, 0x0c].includes(first);
    expect(
      first === 0x1b || graphic || whitespace,
      `replay starts on 0x${first.toString(16)}, which looks like escape debris`,
    ).toBe(true);
  });

  /**
   * An OSC title is the long sequence in practice, and the one most likely to
   * straddle a cut: a shell writes one on every prompt.
   */
  it("skips past an OSC title rather than starting inside it", () => {
    const title = `${ESC}]0;${"a directory name ".repeat(20)}`;
    const bytes = Buffer.from(`${"x".repeat(100)}${title}${"y".repeat(100)}`);
    // A cut aimed at the middle of the title lands after its terminator.
    const cut = safeCut(bytes, 100 + Math.floor(title.length / 2));
    expect(cut).toBe(100 + title.length);
  });

  it("walks forward off a continuation byte", () => {
    const bytes = Buffer.from("aé", "utf8"); // 0x61 0xC3 0xA9
    expect(safeCut(bytes, 2)).toBe(3);
    expect(safeCut(bytes, 1)).toBe(1);
    expect(safeCut(bytes, 99)).toBe(bytes.byteLength);
  });

  /**
   * The fallback the Rust version documents: an unterminated sequence must not
   * make the cut run away to the end of the buffer.
   */
  it("falls back to the character boundary when a sequence never ends", () => {
    const bytes = Buffer.from(`${ESC}[${"1;".repeat(4000)}`, "latin1");
    expect(safeCut(bytes, 2000)).toBe(2000);
  });
});

describe("escapeEnd", () => {
  it("measures each family of sequence the way the Rust version did", () => {
    const at = (text: string): number | undefined =>
      escapeEnd(Buffer.from(text, "latin1"));
    expect(at(`${ESC}[0m`)).toBe(4);
    expect(at(`${ESC}[38;5;12mrest`)).toBe(10);
    expect(at(`${ESC}]0;titlerest`)).toBe(10);
    expect(at(`${ESC}]0;title${ESC}\\rest`)).toBe(11);
    expect(at(`${ESC}(B`)).toBe(3);
    expect(at(`${ESC}(Bx`)).toBe(3);
    // Three bytes are needed before a three-byte sequence can be measured.
    expect(at(`${ESC}(`)).toBe(undefined);
    // Two-byte sequences: anything that is not one of the prefixes above.
    expect(at(`${ESC}7`)).toBe(2);
    // Not a sequence at all.
    expect(at("plain")).toBe(undefined);
    expect(at(ESC)).toBe(undefined);
    // Unterminated.
    expect(at(`${ESC}[38;5;`)).toBe(undefined);
    expect(at(`${ESC}]0;no terminator`)).toBe(undefined);
  });
});

describe("query responder", () => {
  const answer = (responder: QueryResponder, text: string): string =>
    responder.observe(Buffer.from(text, "latin1")).toString("latin1");

  /**
   * This is the deadlock the ConPTY probe warned about: the console asks where
   * the cursor is and will not proceed until something answers. There may be
   * no UI attached, so the host answers.
   */
  it("answers a cursor position query with nobody watching", () => {
    const responder = new QueryResponder();
    expect(answer(responder, "plain output\r\n")).toBe("");
    expect(answer(responder, `${ESC}[6n`)).toBe(`${ESC}[1;1R`);
    expect(answer(responder, `${ESC}[?6n`)).toBe(`${ESC}[?1;1R`);
    expect(answer(responder, `${ESC}[5n`)).toBe(`${ESC}[0n`);
    expect(answer(responder, `${ESC}[c`)).toBe(`${ESC}[?1;0c`);
    expect(answer(responder, `${ESC}[0c`)).toBe(`${ESC}[?1;0c`);
  });

  /**
   * The query can arrive split across reads; a responder that only matched
   * whole chunks would hang exactly when the pipe was busiest.
   */
  it("answers a query split across reads", () => {
    for (const split of [1, 2, 3]) {
      const query = `${ESC}[6n`;
      const responder = new QueryResponder();
      const reply =
        answer(responder, query.slice(0, split)) +
        answer(responder, query.slice(split));
      expect(reply, `split at ${split}`).toBe(`${ESC}[1;1R`);
    }
  });

  /** Answering things it cannot know would be a lie; those get no reply. */
  it("stays quiet about anything it cannot honestly answer", () => {
    const responder = new QueryResponder();
    for (const query of [
      `${ESC}[18t`, // window size in characters
      `${ESC}]11;?`, // background colour
      `${ESC}[>0c`, // secondary device attributes
      `${ESC}[?1049h`, // an ordinary mode setting, not a query
    ]) {
      expect(
        answer(responder, query),
        `answered ${JSON.stringify(query)}`,
      ).toBe("");
    }
  });

  /**
   * A stream of escape bytes must not make the responder grow without bound:
   * it sits on the hot path of every byte a session produces.
   */
  it("does not grow on garbage, and still answers afterwards", () => {
    const responder = new QueryResponder();
    expect(responder.observe(Buffer.alloc(10_000, 0x1b)).byteLength).toBe(0);
    expect(answer(responder, `${ESC}[6n`)).toBe(`${ESC}[1;1R`);
  });
});
