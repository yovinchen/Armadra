import { describe, expect, it } from "vitest";
import {
  InputLedger,
  InputSafety,
  MAX_TRACKED_WRITERS,
  writableState,
} from "./input";

/**
 * The input-sequence ledger and the half-typed-line detector.
 *
 * Both are pure, and both answer questions a terminal cannot answer from its
 * output: what a reconnecting client already delivered, and whether there is
 * an unsubmitted line in the pane right now.
 */

const bytes = (text: string): Buffer => Buffer.from(text, "utf8");

describe("the input ledger", () => {
  it("answers 0 for a writer it has never seen", () => {
    const ledger = new InputLedger();
    expect(ledger.acknowledged("s1", "w1")).toBe(0);
  });

  /**
   * The mark is what a reconnecting client resends *above*. Letting a repeated
   * or out-of-order frame lower it is the one way this mechanism could make a
   * keystroke be applied twice.
   */
  it("only ever moves a mark forward", () => {
    const ledger = new InputLedger();
    ledger.applied("s1", "w1", 7);
    ledger.applied("s1", "w1", 3);
    expect(ledger.acknowledged("s1", "w1")).toBe(7);
  });

  it("keeps writers apart, so one client's resend is its own", () => {
    const ledger = new InputLedger();
    ledger.applied("s1", "w1", 5);
    ledger.applied("s1", "w2", 2);
    expect(ledger.acknowledged("s1", "w1")).toBe(5);
    expect(ledger.acknowledged("s1", "w2")).toBe(2);
  });

  it("ignores an anonymous writer and a zero input id", () => {
    const ledger = new InputLedger();
    ledger.applied("s1", "", 5);
    ledger.applied("s1", "w1", 0);
    expect(ledger.acknowledged("s1", "")).toBe(0);
    expect(ledger.acknowledged("s1", "w1")).toBe(0);
  });

  /**
   * Past the cap the session forgets every writer rather than growing without
   * bound. The cost is one unnecessary resend of input a client already knows
   * was never acknowledged.
   */
  it("forgets them all rather than growing without bound", () => {
    const ledger = new InputLedger();
    for (let index = 0; index <= MAX_TRACKED_WRITERS; index += 1) {
      ledger.applied("s1", `w${index}`, index + 1);
    }
    expect(ledger.acknowledged("s1", "w0")).toBe(0);
    expect(ledger.acknowledged("s1", `w${MAX_TRACKED_WRITERS}`)).toBe(
      MAX_TRACKED_WRITERS + 1,
    );
  });

  /**
   * The marks describe a pty. A recycle replaces it, so keeping them would let
   * the new session claim input it never received.
   */
  it("dies with the session it describes", () => {
    const ledger = new InputLedger();
    ledger.applied("s1", "w1", 9);
    ledger.forget("s1");
    expect(ledger.acknowledged("s1", "w1")).toBe(0);
  });
});

describe("the half-typed-line detector", () => {
  it("is clean before anything is typed", () => {
    expect(new InputSafety().pending).toBe(false);
  });

  it("goes pending on a keystroke and clean again on Enter", () => {
    const safety = new InputSafety();
    expect(safety.consume(bytes("ls -la"))).toEqual({
      edited: true,
      fence: true,
    });
    expect(safety.pending).toBe(true);
    expect(safety.consume(bytes("\r"))).toEqual({ edited: true, fence: true });
    expect(safety.pending).toBe(false);
  });

  /**
   * Inside a bracketed paste a newline is data. Treating it as a submission
   * would make a pasted three-line prompt look like three finished turns.
   */
  it("treats newlines inside a bracketed paste as data", () => {
    const safety = new InputSafety();
    safety.consume(bytes("[200~one\ntwo[201~"));
    expect(safety.pending).toBe(true);
    safety.consume(bytes("\r"));
    expect(safety.pending).toBe(false);
  });

  /**
   * A CLI asks the terminal for its device attributes and cursor position and
   * the answer comes back *as input*. Counting those as typing would make
   * every agent pane look permanently half-typed, and every scheduled prompt
   * would be refused.
   */
  it("does not count a terminal's own reply as typing", () => {
    const safety = new InputSafety();
    // Device attributes, cursor position, device status.
    safety.consume(bytes("[?1;2c[24;80R[0n"));
    expect(safety.pending).toBe(false);
  });

  /**
   * Codex asks for the colours and the keyboard flags when it starts. Counting
   * the answers as a half-typed line kept its first task queued until expiry.
   */
  it("does not count colour, keyboard-flag or mode replies as typing", () => {
    const safety = new InputSafety();
    safety.consume(
      bytes(
        "\x1b]10;rgb:d4d4/d4d4/d4d4\x1b\\\x1b]11;rgb:1e1e/1e1e/1e1e\x07" +
          "\x1b[?0u\x1b[?2026;2$y\x1bP1$r0m\x1b\\",
      ),
    );
    expect(safety.pending).toBe(false);
    // Split across writes, the way a WebSocket frame boundary can fall.
    safety.consume(bytes("\x1b]11;rgb:1e1e/"));
    safety.consume(bytes("1e1e/1e1e\x1b"));
    safety.consume(bytes("\\"));
    expect(safety.pending).toBe(false);
    // Typing after a reply still counts.
    safety.consume(bytes("a"));
    expect(safety.pending).toBe(true);
  });

  /**
   * Claude 打开了焦点上报（?1004）与鼠标跟踪（?1003 + ?1006）。tmux 后端里这
   * 些模式停在 tmux 那一层；direct 与会话宿主后端里页面的 xterm 真的会发——
   * 点一下节点就是一个 `CSI I`，鼠标划过就是一串 `CSI < … M`。当成人打了半行，
   * 首投放行与节能休眠都卡在「输入行上有东西」上（2026-09-26 direct 后端端到
   * 端实测：Claude 的第一条任务一直排着，休眠也不发生）。
   */
  it("does not count focus or mouse reports as typing", () => {
    const safety = new InputSafety();
    safety.consume(bytes("\x1b[I\x1b[O"));
    expect(safety.pending).toBe(false);
    safety.consume(bytes("\x1b[<35;12;7M\x1b[<0;12;7M\x1b[<0;12;7m"));
    expect(safety.pending).toBe(false);
    // urxvt 形式，与老式 X10：`CSI M` 后面跟三个原始字节。
    safety.consume(bytes("\x1b[32;12;7M"));
    safety.consume(bytes("\x1b[M #!"));
    expect(safety.pending).toBe(false);
    // 之后真打字照样算。
    safety.consume(bytes("a"));
    expect(safety.pending).toBe(true);
  });

  it("still counts a keyboard-protocol key press as typing", () => {
    const safety = new InputSafety();
    safety.consume(bytes("\x1b[97u"));
    expect(safety.pending).toBe(true);
  });

  it("gives up on a reply string that never terminates", () => {
    const safety = new InputSafety();
    safety.consume(bytes(`\x1b]11;${"x".repeat(5000)}`));
    expect(safety.pending).toBe(true);
  });

  it("counts a real escape sequence the user sent as typing", () => {
    const safety = new InputSafety();
    // Arrow up: a history recall, which really does put a line in the buffer.
    safety.consume(bytes("[A"));
    expect(safety.pending).toBe(true);
  });

  /**
   * An `ESC` that never becomes a sequence must not hold the machine open for
   * ever — a terminal stuck "mid-escape" would answer every later question
   * wrongly.
   */
  it("gives up on an escape that never terminates", () => {
    const safety = new InputSafety();
    safety.consume(bytes("Z"));
    expect(safety.pending).toBe(true);
    safety.consume(bytes("\r"));
    expect(safety.pending).toBe(false);
  });

  it("splits a sequence across two writes without losing it", () => {
    const safety = new InputSafety();
    safety.consume(bytes("[2"));
    safety.consume(bytes("00~x[201~"));
    expect(safety.pending).toBe(true);
  });
});

describe("the write gate", () => {
  /**
   * A paste into a pane showing a permission prompt answers the prompt: the
   * first character becomes the answer to "allow this?". It is the one input
   * mistake Ctrl+C cannot undo.
   */
  it("refuses a node that is waiting on a person", () => {
    expect(writableState("blocked")).toBe(false);
    expect(writableState("waiting")).toBe(false);
  });

  it("allows everything else, including a node with no status at all", () => {
    expect(writableState("working")).toBe(true);
    expect(writableState("done")).toBe(true);
    expect(writableState(null)).toBe(true);
    expect(writableState(undefined)).toBe(true);
  });
});
