import { describe, expect, it } from "vitest";

import { VERB_NAMES } from "../../core/browser/verb-spec";
import { DRIVE_VERBS, parseDriveRequest, tokenMatches } from "./drive";
import {
  MessageReader,
  acceptKey,
  decodeFrame,
  encodeFrame,
  encodeText,
} from "./websocket";

describe("the verb list", () => {
  it("is the one list, and matches the hook's and the Runtime's", () => {
    expect([...DRIVE_VERBS]).toEqual([...VERB_NAMES]);
    for (const verb of [
      "navigate",
      "read",
      "click",
      "hover",
      "drag",
      "fill",
      "pdf",
      "resize",
      "lease",
    ])
      expect(DRIVE_VERBS, verb).toContain(verb);
    // Nothing that names a CDP method or an evaluation is a verb.
    for (const stranger of ["evaluate", "Runtime.evaluate", "eval", "exec"])
      expect(DRIVE_VERBS, stranger).not.toContain(stranger);
  });
});

describe("parseDriveRequest", () => {
  const good = {
    id: "r1",
    nodeId: "browser-1",
    verb: "read",
    args: { mode: "map" },
  };

  it("takes a well-formed request", () => {
    const parsed = parseDriveRequest(good);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.request.args).toEqual({ mode: "map" });
  });

  it("defaults absent args to an empty object", () => {
    const parsed = parseDriveRequest({ id: "r1", nodeId: "n", verb: "back" });
    expect(parsed.ok && parsed.request.args).toEqual({});
  });

  it("refuses a CDP method name dressed up as a verb", () => {
    const parsed = parseDriveRequest({ ...good, verb: "Runtime.evaluate" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("browser_unknown_verb");
  });

  it("refuses malformed envelopes", () => {
    for (const bad of [
      null,
      "x",
      [],
      { ...good, id: "" },
      { ...good, nodeId: 7 },
      { ...good, args: [] },
    ]) {
      expect(parseDriveRequest(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the token", () => {
  it("accepts only the exact token", () => {
    expect(tokenMatches("abc123", "abc123")).toBe(true);
    expect(tokenMatches("abc123", "abc124")).toBe(false);
  });

  it("refuses a wrong length without throwing", () => {
    expect(tokenMatches("abc123", "abc")).toBe(false);
    expect(tokenMatches("abc123", "abc1234")).toBe(false);
  });

  it("refuses an empty expectation, so an unset token grants nothing", () => {
    expect(tokenMatches("", "")).toBe(false);
    expect(tokenMatches("", "anything")).toBe(false);
  });

  it("refuses a non-string", () => {
    expect(tokenMatches("abc", undefined)).toBe(false);
    expect(tokenMatches("abc", { toString: () => "abc" })).toBe(false);
  });
});

/* ------------------------------- the framing ------------------------------- */

/** A client frame, masked, as the RFC requires of a client. */
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(
    payload.map((byte, index) => byte ^ mask[index & 3]!),
  );
  const head =
    payload.length < 126
      ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length])
      : Buffer.concat([
          Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126]),
          (() => {
            const length = Buffer.alloc(2);
            length.writeUInt16BE(payload.length);
            return length;
          })(),
        ]);
  return Buffer.concat([head, mask, masked]);
}

describe("websocket framing", () => {
  it("computes the handshake accept key from the RFC's own example", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe(
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  });

  it("reads a masked client text frame", () => {
    const frame = clientFrame(0x1, Buffer.from("hello"));
    const decoded = decodeFrame(frame);
    expect(decoded?.payload.toString()).toBe("hello");
    expect(decoded?.length).toBe(frame.length);
  });

  it("refuses an unmasked client frame", () => {
    expect(() => decodeFrame(encodeText("hi"))).toThrow(/masked/);
  });

  it("waits for more bytes rather than guessing", () => {
    const frame = clientFrame(0x1, Buffer.from("hello"));
    expect(decodeFrame(frame.subarray(0, 4))).toBeNull();
  });

  it("reassembles a fragmented message", () => {
    const reader = new MessageReader();
    expect(reader.push(clientFrame(0x1, Buffer.from("he"), false))).toEqual([]);
    const done = reader.push(clientFrame(0x0, Buffer.from("llo"), true));
    expect(done).toHaveLength(1);
    expect(done[0]!.data.toString()).toBe("hello");
  });

  it("handles two messages arriving in one chunk", () => {
    const reader = new MessageReader();
    const out = reader.push(
      Buffer.concat([
        clientFrame(0x1, Buffer.from("a")),
        clientFrame(0x1, Buffer.from("b")),
      ]),
    );
    expect(out.map((each) => each.data.toString())).toEqual(["a", "b"]);
  });

  it("refuses a binary frame, which this protocol does not have", () => {
    const reader = new MessageReader();
    expect(() => reader.push(clientFrame(0x2, Buffer.from([1, 2])))).toThrow(
      /binary/,
    );
  });

  it("round-trips a server frame through its own header sizes", () => {
    for (const size of [1, 125, 126, 300, 70_000]) {
      const encoded = encodeFrame(0x1, Buffer.alloc(size, 7));
      // The header grows, the payload does not change.
      const headerSize = size < 126 ? 2 : size < 65_536 ? 4 : 10;
      expect(encoded.length).toBe(headerSize + size);
      expect(encoded.readUInt8(0)).toBe(0x81);
    }
  });
});
