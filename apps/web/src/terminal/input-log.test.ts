import { beforeEach, describe, expect, it, vi } from "vitest";

import { INPUT_TTL_MS, TerminalInputLog } from "./input-log";
import { createTerminalTransport, type SocketLike } from "./transport";

/** 只记录发出的帧、事件由测试手动触发的假 WebSocket。 */
class FakeSocket implements SocketLike {
  readyState = 1;
  readonly sent: string[] = [];
  private listeners = new Map<string, ((event: never) => void)[]>();
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit("close", {});
  }
  addEventListener(type: string, listener: (event: never) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? [])
      listener(event as never);
  }
  frame(message: unknown) {
    this.emit("message", { data: JSON.stringify(message) });
  }
  inputs() {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((message) => message.type === "input");
  }
}

function hello(acknowledgedInput?: number) {
  return {
    type: "hello",
    sessionId: "s1",
    generation: 3,
    backend: "direct",
    rows: 24,
    cols: 80,
    alive: true,
    ...(acknowledgedInput === undefined ? {} : { acknowledgedInput }),
  };
}

describe("the terminal input log", () => {
  let now = 1_000;
  const clock = () => now;
  let log: TerminalInputLog;

  beforeEach(() => {
    now = 1_000;
    log = new TerminalInputLog("writer-1", clock);
  });

  it("numbers input from one and drops everything an ack covers", () => {
    expect(log.record("a").id).toBe(1);
    expect(log.record("b").id).toBe(2);
    expect(log.record("c").id).toBe(3);
    log.acknowledge(2);
    expect(log.pending.map((entry) => entry.data)).toEqual(["c"]);
    // An ack that says nothing new cannot resurrect or lose anything.
    log.acknowledge(0);
    log.acknowledge(Number.NaN);
    expect(log.pending.map((entry) => entry.data)).toEqual(["c"]);
  });

  it("resends only what is unacknowledged and still recent", () => {
    log.record("typed-before-the-drop");
    log.record("also-before");
    now += INPUT_TTL_MS + 1;
    log.record("just-now");
    // The runtime already ran the first one; the second is too old to be safe
    // to repeat, and only the fresh one is sent again.
    expect(log.resume(1).map((entry) => entry.data)).toEqual(["just-now"]);
    // The expired entry is gone for good rather than returning next time.
    expect(log.resume(0).map((entry) => entry.data)).toEqual(["just-now"]);
    expect(log.resume(3)).toEqual([]);
  });

  it("gives every log its own writer label", () => {
    expect(new TerminalInputLog().writerId).not.toBe(
      new TerminalInputLog().writerId,
    );
  });
});

describe("a terminal transport that keeps an input log", () => {
  it("acknowledges, and after a drop resends only what never landed", () => {
    let now = 5_000;
    const log = new TerminalInputLog("writer-1", () => now);
    const first = new FakeSocket();
    const transport = createTerminalTransport("ws://x", {}, () => first, log);
    first.emit("open", {});
    first.frame(hello(0));
    transport.input("one\r");
    transport.input("two\r");
    expect(first.inputs()).toEqual([
      { type: "input", data: "one\r", inputId: 1 },
      { type: "input", data: "two\r", inputId: 2 },
    ]);

    // The runtime confirms the first keystroke and then the socket dies.
    first.frame({ type: "ack", inputId: 1 });
    first.close();

    const second = new FakeSocket();
    const resumed = createTerminalTransport("ws://x", {}, () => second, log);
    second.emit("open", {});
    // The session says it applied the first one; only the second is repeated,
    // and it keeps its number so the runtime can recognize it.
    second.frame(hello(1));
    expect(second.inputs()).toEqual([
      { type: "input", data: "two\r", inputId: 2 },
    ]);
    resumed.input("three\r");
    expect(second.inputs()).toEqual([
      { type: "input", data: "two\r", inputId: 2 },
      { type: "input", data: "three\r", inputId: 3 },
    ]);
  });

  it("repeats nothing the session already applied while we were away", () => {
    const log = new TerminalInputLog("writer-1");
    const first = new FakeSocket();
    const transport = createTerminalTransport("ws://x", {}, () => first, log);
    first.emit("open", {});
    first.frame(hello(0));
    transport.input("dangerous\r");
    // No ack arrives before the drop, but the input did reach the pty.
    first.close();

    const second = new FakeSocket();
    createTerminalTransport("ws://x", {}, () => second, log);
    second.emit("open", {});
    second.frame(hello(1));
    expect(second.inputs()).toEqual([]);
  });

  it("holds input typed before the attach and sends it exactly once", () => {
    const log = new TerminalInputLog("writer-1");
    const socket = new FakeSocket();
    const transport = createTerminalTransport("ws://x", {}, () => socket, log);
    socket.emit("open", {});
    transport.input("early\r");
    expect(socket.inputs()).toEqual([]);
    socket.frame(hello(0));
    expect(socket.inputs()).toEqual([
      { type: "input", data: "early\r", inputId: 1 },
    ]);
  });

  it("sends plain input when no log is kept", () => {
    const socket = new FakeSocket();
    const transport = createTerminalTransport("ws://x", {}, () => socket);
    socket.emit("open", {});
    socket.frame(hello());
    transport.input("x");
    expect(socket.inputs()).toEqual([{ type: "input", data: "x" }]);
  });

  it("still reports hello without an acknowledgement mark", () => {
    const onHello = vi.fn();
    const socket = new FakeSocket();
    createTerminalTransport("ws://x", { onHello }, () => socket);
    socket.emit("open", {});
    socket.frame(hello());
    expect(onHello).toHaveBeenCalledWith(
      expect.objectContaining({ acknowledgedInput: undefined }),
    );
  });
});
