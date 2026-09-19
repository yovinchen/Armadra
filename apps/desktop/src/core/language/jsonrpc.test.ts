/**
 * Framing, classification and id namespacing — a direct port of
 * `apps/runtime/src/language/tests/jsonrpc.rs`.
 */

import { describe, expect, it } from "vitest";

import {
  Decoder,
  HARD_LIMIT,
  encode,
  messageIdText,
  namespaced,
  parseMessage,
  sessionOf,
  type Frame,
} from "./jsonrpc";
import { MAX_MESSAGE_BYTES } from "./limits";

function frames(chunks: readonly Buffer[]): Frame[] {
  const decoder = new Decoder();
  const out: Frame[] = [];
  for (const chunk of chunks) {
    decoder.push(chunk);
    for (;;) {
      const next = decoder.next();
      if (next.kind !== "frame") break;
      out.push(next.frame);
    }
  }
  return out;
}

describe("language/jsonrpc", () => {
  it("a read boundary is not a message boundary", () => {
    const first = encode(`{"jsonrpc":"2.0","id":1,"method":"a"}`);
    const second = encode(`{"jsonrpc":"2.0","method":"b"}`);
    const stream = Buffer.concat([first, second]);
    // Split at every possible point: a decoder that assumes a read is a frame
    // works for exactly one of these.
    for (let split = 0; split < stream.byteLength; split += 1) {
      const decoded = frames([
        Buffer.from(stream.subarray(0, split)),
        Buffer.from(stream.subarray(split)),
      ]);
      expect(decoded, `split at ${split}`).toHaveLength(2);
      expect(parseMessage((decoded[0] as Frame).body)?.method).toBe("a");
    }
  });

  it("the shape of a message decides what it is", () => {
    const request = parseMessage(`{"id":1,"method":"textDocument/hover"}`);
    expect(request?.kind).toBe("request");
    expect(messageIdText(request!)).toBe("1");
    const notification = parseMessage(`{"method":"initialized"}`);
    expect(notification?.kind).toBe("notification");
    expect(notification?.id).toBeUndefined();
    const response = parseMessage(`{"id":"7:abc","result":null}`);
    expect(response?.kind).toBe("response");
    expect(messageIdText(response!)).toBe("7:abc");
    // A null id is absent, not an id of null: JSON-RPC uses it for "we could
    // not read the request", which is not something to route back.
    expect(parseMessage(`{"id":null,"error":{}}`)?.id).toBeUndefined();
    expect(parseMessage("[1,2]")).toBeUndefined();
    expect(parseMessage("not json")).toBeUndefined();
  });

  it("an oversize frame still carries its id", () => {
    // Past the ceiling but under the hard limit: the body comes back so the
    // waiting session can be told its request failed.
    const body = `{"id":"3:session","result":"${"x".repeat(MAX_MESSAGE_BYTES + 16)}"}`;
    const decoded = frames([encode(body)]);
    expect(decoded).toHaveLength(1);
    expect((decoded[0] as Frame).oversize).toBe(true);
    expect(messageIdText(parseMessage((decoded[0] as Frame).body)!)).toBe(
      "3:session",
    );
  });

  it("a frame past the hard limit is skipped and the stream recovers", () => {
    const huge = encode(Buffer.alloc(HARD_LIMIT + 1, "x"));
    const good = encode(`{"method":"after"}`);
    const decoder = new Decoder();
    decoder.push(Buffer.concat([huge, good]));
    const first = decoder.next();
    expect(first).toEqual({ kind: "error", error: "tooLarge" });
    const next = decoder.next();
    expect(next.kind).toBe("frame");
    expect(parseMessage((next as { frame: Frame }).frame.body)?.method).toBe(
      "after",
    );
  });

  it("a namespaced id names exactly one session", () => {
    expect(namespaced(7, "session-a")).toBe("7:session-a");
    expect(sessionOf("7:session-a")).toBe("session-a");
    // Two sessions both counting from 1 do not collide.
    expect(namespaced(1, "session-a")).not.toBe(namespaced(1, "session-b"));
    // A client id that merely looks like one of ours is not one of ours.
    expect(sessionOf("plain")).toBeUndefined();
    expect(sessionOf("abc:session")).toBeUndefined();
    expect(sessionOf("7:")).toBeUndefined();
  });

  it("a header that never ends is refused rather than buffered", () => {
    const decoder = new Decoder();
    decoder.push(Buffer.alloc(9 * 1024, "A"));
    expect(decoder.next()).toEqual({ kind: "error", error: "badHeader" });
  });
});
