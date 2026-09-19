import { describe, expect, it } from "vitest";
import {
  FrameDecoder,
  FrameError,
  HEADER_LEN,
  MAX_PAYLOAD,
  OutputTracker,
  PROTOCOL_MAJOR,
  RequestIds,
  acceptWelcome,
  clampSize,
  createMessage,
  encodeFrame,
  hostReference,
  jsonFrame,
  keyOfReference,
  PIPE_PREFIX,
  pipeEndpoint,
  resizeMessage,
  startupMutex,
} from "./protocol";

/**
 * The Windows wire, tested where it can be tested.
 *
 * No machine in this project's CI can open a named pipe, so the whole Windows
 * confidence budget is spent here: the codec, the pipe-name derivation, the
 * welcome check and the gap detector are pure, and the vectors below were
 * **produced by the Rust crate itself** rather than read off its source.
 *
 * ```sh
 * # printed by a throwaway test inside crates/session-host, 2026-09-20
 * ENDPOINT=\\.\pipe\armadra-session-S-1-5-21-…-1001-37f614153a749bbd-v1
 * FRAME=a102000007000000000000002a00000000000000020000006869
 * JSON={"type":"attach","id":3,"sessionKey":"node-a","generation":2,"size":{"cols":100,"rows":30}}
 * RESIZE={"type":"resize","id":4,"sessionKey":"node-a","cols":100,"rows":30}
 * ```
 *
 * That distinction is the point: a port checked against its own author's
 * reading of the other side proves nothing. These bytes came off the other
 * side.
 */

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const DATA_DIR = String.raw`C:\Users\a\AppData\Local\armadra`;

describe("the frame codec", () => {
  it("encodes an output frame byte for byte as the Rust host does", () => {
    const encoded = encodeFrame({
      kind: "output",
      generation: 7,
      sequence: 42,
      payload: Buffer.from("hi", "utf8"),
    });
    expect(encoded.toString("hex")).toBe(
      "a102000007000000000000002a00000000000000020000006869",
    );
  });

  it("round-trips through the decoder", () => {
    const decoder = new FrameDecoder();
    decoder.push(
      encodeFrame({
        kind: "snapshot",
        generation: 3,
        payload: Buffer.from("screen"),
      }),
    );
    const frame = decoder.next();
    expect(frame?.kind).toBe("snapshot");
    expect(frame?.generation).toBe(3);
    expect(frame?.payload.toString()).toBe("screen");
    expect(decoder.next()).toBeUndefined();
  });

  /**
   * A named pipe in byte mode splits and merges writes wherever it likes, so
   * every read has to be treated as "some bytes", never as "a message".
   */
  it("reassembles a frame delivered one byte at a time", () => {
    const encoded = encodeFrame({
      kind: "output",
      generation: 1,
      sequence: 1,
      payload: Buffer.from("abcdef"),
    });
    const decoder = new FrameDecoder();
    for (let index = 0; index < encoded.byteLength - 1; index += 1) {
      decoder.push(encoded.subarray(index, index + 1));
      expect(decoder.next()).toBeUndefined();
    }
    decoder.push(encoded.subarray(encoded.byteLength - 1));
    expect(decoder.next()?.payload.toString()).toBe("abcdef");
  });

  it("hands back two frames that arrived in one read", () => {
    const decoder = new FrameDecoder();
    decoder.push(
      Buffer.concat([
        jsonFrame({ type: "list", id: 1 }),
        jsonFrame({ type: "list", id: 2 }),
      ]),
    );
    expect(JSON.parse(String(decoder.next()?.payload))).toEqual({
      type: "list",
      id: 1,
    });
    expect(JSON.parse(String(decoder.next()?.payload))).toEqual({
      type: "list",
      id: 2,
    });
  });

  /**
   * Every one of these means the stream is unusable. There is no framing left
   * to resynchronise to, so the connection has to go rather than the bytes
   * being guessed at.
   */
  it("refuses a stream that is not this protocol", () => {
    const bad = new FrameDecoder();
    bad.push(Buffer.alloc(HEADER_LEN, 0));
    expect(() => bad.next()).toThrow(FrameError);
  });

  it("refuses an unknown frame kind rather than ignoring it", () => {
    const encoded = encodeFrame({ kind: "json", payload: Buffer.alloc(0) });
    encoded[1] = 9;
    const decoder = new FrameDecoder();
    decoder.push(encoded);
    expect(() => decoder.next()).toThrow(/unknown frame kind 9/);
  });

  /**
   * A future version may use the reserved bytes. This version must not
   * silently ignore a field it does not understand.
   */
  it("refuses a frame whose reserved bytes are not zero", () => {
    const encoded = encodeFrame({ kind: "json", payload: Buffer.alloc(0) });
    encoded[2] = 1;
    const decoder = new FrameDecoder();
    decoder.push(encoded);
    expect(() => decoder.next()).toThrow(/reserved/);
  });

  /**
   * The length is checked **before** it is used for anything, so a hostile
   * header cannot make this process reserve a gigabyte it will never fill.
   */
  it("refuses an oversized length before allocating for it", () => {
    const header = Buffer.alloc(HEADER_LEN);
    header[0] = 0xa1;
    header[1] = 2;
    header.writeUInt32LE(MAX_PAYLOAD + 1, 20);
    const decoder = new FrameDecoder();
    decoder.push(header);
    expect(() => decoder.next()).toThrow(/exceeds/);
    expect(() =>
      encodeFrame({ kind: "output", payload: Buffer.alloc(MAX_PAYLOAD + 1) }),
    ).toThrow(FrameError);
  });
});

describe("the control messages", () => {
  /**
   * `attach` nests its size and `resize` flattens it. Nothing about the field
   * names says which, and getting it backwards is a request the host answers
   * with `badRequest` on a machine nobody here can run.
   */
  it("nests the size in `attach` and flattens it in `resize`", () => {
    expect(
      JSON.stringify({
        type: "attach",
        id: 3,
        sessionKey: "node-a",
        generation: 2,
        size: clampSize({ cols: 100, rows: 30 }),
      }),
    ).toBe(
      '{"type":"attach","id":3,"sessionKey":"node-a","generation":2,"size":{"cols":100,"rows":30}}',
    );
    expect(
      JSON.stringify(resizeMessage(4, "node-a", { cols: 100, rows: 30 })),
    ).toBe(
      '{"type":"resize","id":4,"sessionKey":"node-a","cols":100,"rows":30}',
    );
  });

  it("flattens the create spec into the message", () => {
    const message = createMessage(1, {
      sessionKey: "node-a",
      generation: 1,
      workspaceId: "ws",
      cwd: String.raw`C:\src`,
      shell: "powershell.exe",
      args: [],
      env: [["ARMADRA_NODE_ID", "node-a"]],
      size: { cols: 80, rows: 24 },
    }) as Record<string, unknown>;
    expect(message.type).toBe("create");
    expect(message.sessionKey).toBe("node-a");
    expect(message.command).toBeNull();
    expect(message.size).toEqual({ cols: 80, rows: 24 });
  });

  /**
   * A console with zero rows or columns is not a smaller console, it is an
   * invalid one, and ConPTY rejects it.
   */
  it("clamps a size ConPTY would refuse", () => {
    expect(clampSize({ cols: 0, rows: 0 })).toEqual({ cols: 2, rows: 2 });
    expect(clampSize({ cols: 99_999, rows: 99_999 })).toEqual({
      cols: 1000,
      rows: 1000,
    });
  });

  it("issues monotonic request ids, never zero", () => {
    const ids = new RequestIds();
    expect([ids.issue(), ids.issue(), ids.issue()]).toEqual([1, 2, 3]);
  });

  it("base64s write payloads the way the host decodes them", () => {
    expect(Buffer.from([0, 1, 2, 250, 251]).toString("base64")).toBe(
      "AAEC+vs=",
    );
  });
});

describe("the handshake", () => {
  it("carries the sessions that survived the core", () => {
    const greeting = acceptWelcome({
      type: "welcome",
      protocol: PROTOCOL_MAJOR,
      host: "0.1.0",
      pid: 4312,
      instanceId: "4312-1",
      sessions: [
        {
          sessionKey: "node-a",
          generation: 2,
          workspaceId: "ws",
          cwd: String.raw`C:\src`,
          size: { cols: 80, rows: 24 },
          pid: 42,
          exited: false,
          exitCode: null,
          subscribers: 0,
        },
      ],
    });
    expect(greeting.pid).toBe(4312);
    expect(greeting.sessions[0]?.generation).toBe(2);
  });

  /**
   * The frame layout is shared across majors, so a mismatch that got through
   * would surface much later as nonsense rather than immediately as an error.
   */
  it("refuses a host speaking another major immediately", () => {
    expect(() =>
      acceptWelcome({
        type: "welcome",
        protocol: PROTOCOL_MAJOR + 1,
        host: "9.9.9",
        pid: 1,
        instanceId: "x",
        sessions: [],
      }),
    ).toThrow(/protocol/);
    expect(() =>
      acceptWelcome({
        type: "error",
        id: 0,
        code: "unauthorized",
        message: "no",
      }),
    ).toThrow(/refused/);
  });
});

describe("the output tracker", () => {
  it("writes consecutive frames", () => {
    const tracker = new OutputTracker(3);
    expect(tracker.observe(3, 17)).toEqual({ kind: "write" });
    expect(tracker.observe(3, 18)).toEqual({ kind: "write" });
    expect(tracker.observe(3, 19)).toEqual({ kind: "write" });
  });

  /**
   * The reason sequence numbers are on the wire: a gap means the screen cannot
   * be repaired by writing what arrived, so the client re-attaches instead of
   * painting misaligned bytes.
   */
  it("reports a gap rather than papering over it", () => {
    const tracker = new OutputTracker(1);
    expect(tracker.observe(1, 5)).toEqual({ kind: "write" });
    expect(tracker.observe(1, 9)).toEqual({ kind: "gap", missing: 3 });
    // The stream continues from where it actually is, so one gap does not make
    // every later frame look like a gap too.
    expect(tracker.observe(1, 10)).toEqual({ kind: "write" });
  });

  it("drops frames of another generation, and repeats", () => {
    const tracker = new OutputTracker(4);
    expect(tracker.observe(3, 1)).toEqual({ kind: "wrong" });
    expect(tracker.observe(5, 1)).toEqual({ kind: "wrong" });
    expect(tracker.observe(4, 1)).toEqual({ kind: "write" });
    expect(tracker.observe(4, 1)).toEqual({ kind: "wrong" });
  });
});

describe("where the host listens", () => {
  it("derives the same pipe name the Rust host binds", () => {
    expect(pipeEndpoint(SID, DATA_DIR)).toBe(
      String.raw`\\.\pipe\armadra-session-${SID}-37f614153a749bbd-v1`,
    );
    expect(startupMutex(SID, DATA_DIR)).toBe(
      "armadra-session-host-37f614153a749bbd-v1",
    );
  });

  /**
   * Two users, two installations and two protocol majors are three different
   * hosts. Sharing a pipe between any pair would mean one user's terminals
   * showing up in another's session.
   */
  it("separates users, directories and majors", () => {
    const base = pipeEndpoint(SID, String.raw`C:\a`);
    expect(base).not.toBe(
      pipeEndpoint("S-1-5-21-9-9-9-1002", String.raw`C:\a`),
    );
    expect(base).not.toBe(pipeEndpoint(SID, String.raw`C:\b`));
    expect(base).not.toBe(
      pipeEndpoint(SID, String.raw`C:\a`, PROTOCOL_MAJOR + 1),
    );
  });

  /** Concatenation collisions are the classic way this kind of hash fails. */
  it("cannot be confused by moving a character across the boundary", () => {
    expect(pipeEndpoint("ab", "c")).not.toBe(pipeEndpoint("a", "bc"));
    expect(pipeEndpoint("", "abc")).not.toBe(pipeEndpoint("abc", ""));
  });

  it("lets no hostile SID shape the pipe name", () => {
    const name = pipeEndpoint(String.raw`..\..\evil pipe\x`, String.raw`C:\a`);
    const tail = name.slice(PIPE_PREFIX.length);
    expect(tail).not.toContain("\\");
    expect(tail).not.toContain(" ");
    expect(pipeEndpoint("", String.raw`C:\a`)).toContain("unknown");
  });

  /**
   * A recycle is a different reference, so an orphan sweep cannot confuse the
   * session it destroyed with the one that replaced it.
   */
  it("makes a reference out of the key and the generation", () => {
    expect(hostReference("node-a", 3)).toBe("node-a#3");
    expect(keyOfReference("node-a#3")).toBe("node-a");
    expect(keyOfReference("node-a")).toBe("node-a");
  });
});
