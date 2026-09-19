import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, validWriter } from "./socket";

/**
 * The wire, as `apps/web/src/terminal/transport.ts` reads it.
 *
 * That file is the acceptance standard and may not change, so these tests are
 * written against what it parses rather than against what this side sends: the
 * frames are text, they are JSON objects, and every field it switches on is
 * present under the name it expects.
 */

describe("server frames", () => {
  it("encodes a text frame the page can JSON.parse", () => {
    const frame = encodeFrame({
      type: "hello",
      sessionId: "s1",
      generation: 2,
      backend: "tmux",
      rows: 24,
      cols: 80,
      alive: true,
      acknowledgedInput: 7,
    });
    expect(Buffer.isBuffer(frame)).toBe(true);
    const parsed = JSON.parse(frame.toString("utf8"));
    expect(parsed).toEqual({
      type: "hello",
      sessionId: "s1",
      generation: 2,
      backend: "tmux",
      rows: 24,
      cols: 80,
      alive: true,
      acknowledgedInput: 7,
    });
  });

  it("keeps escape sequences intact through the JSON envelope", () => {
    const data = "\u001b[1;32mok\u001b[0m\n";
    const parsed = JSON.parse(
      encodeFrame({ type: "output", data }).toString("utf8"),
    );
    expect(parsed.data).toBe(data);
  });

  it("carries a null exit code rather than omitting it", () => {
    const parsed = JSON.parse(
      encodeFrame({ type: "status", status: "exited", exitCode: null }).toString(
        "utf8",
      ),
    );
    expect(parsed).toEqual({ type: "status", status: "exited", exitCode: null });
  });

  it("names the current generation in a stale frame", () => {
    const parsed = JSON.parse(
      encodeFrame({ type: "stale", generation: 3 }).toString("utf8"),
    );
    expect(parsed).toEqual({ type: "stale", generation: 3 });
  });
});

describe("client frames", () => {
  it("accepts the three the page sends", () => {
    expect(decodeFrame('{"type":"input","data":"ls\\r","inputId":4}')).toEqual({
      type: "input",
      data: "ls\r",
      inputId: 4,
    });
    expect(decodeFrame('{"type":"resize","cols":100,"rows":40}')).toEqual({
      type: "resize",
      cols: 100,
      rows: 40,
    });
    expect(decodeFrame('{"type":"terminate","mode":"session"}')).toEqual({
      type: "terminate",
      mode: "session",
    });
  });

  it("treats a terminate with no mode as the parameterless one", () => {
    expect(decodeFrame('{"type":"terminate"}')).toEqual({ type: "terminate" });
    // An unknown mode is dropped rather than passed through: the three levels
    // are contractual and a fourth would reach the backend as a typo.
    expect(decodeFrame('{"type":"terminate","mode":"nuke"}')).toEqual({
      type: "terminate",
    });
  });

  /**
   * A malformed frame is a bug in a client, and the one thing a terminal
   * socket must not do is close over one: the pane is showing a running
   * process, and dropping the connection would look like the process died.
   */
  it("drops anything it cannot understand instead of answering", () => {
    expect(decodeFrame("not json")).toBeUndefined();
    expect(decodeFrame("null")).toBeUndefined();
    expect(decodeFrame("[]")).toBeUndefined();
    expect(decodeFrame('{"type":"input"}')).toBeUndefined();
    expect(decodeFrame('{"type":"input","data":42}')).toBeUndefined();
    expect(decodeFrame('{"type":"resize","cols":"80","rows":24}')).toBeUndefined();
    expect(decodeFrame('{"type":"whatever"}')).toBeUndefined();
  });

  it("ignores an input id that is not a finite number", () => {
    expect(decodeFrame('{"type":"input","data":"a","inputId":"3"}')).toEqual({
      type: "input",
      data: "a",
    });
  });
});

describe("the writer label", () => {
  it("accepts an absent one as the empty label", () => {
    expect(validWriter(null)).toBe("");
    expect(validWriter("")).toBe("");
  });

  it("accepts ASCII graphic ids up to 64 characters", () => {
    expect(validWriter("node-7")).toBe("node-7");
    expect(validWriter("a".repeat(64))).toBe("a".repeat(64));
  });

  it("refuses anything longer, blank or non-graphic", () => {
    expect(validWriter("a".repeat(65))).toBeUndefined();
    expect(validWriter("has space")).toBeUndefined();
    expect(validWriter("newline\n")).toBeUndefined();
    expect(validWriter("中文")).toBeUndefined();
  });
});
