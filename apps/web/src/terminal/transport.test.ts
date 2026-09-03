import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTerminalTransport,
  type SocketLike,
  type TerminalTransport,
} from "./transport";

/** 最小可用的假 WebSocket：只记录发出的帧，事件由测试手动触发。 */
class FakeSocket implements SocketLike {
  readyState = 1;
  readonly sent: string[] = [];
  closed = false;
  private listeners = new Map<string, ((event: never) => void)[]>();

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(type: string, listener: (event: never) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as never);
    }
  }

  frame(message: unknown) {
    this.emit("message", { data: JSON.stringify(message) });
  }

  parsedSent() {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

const HELLO = {
  type: "hello",
  sessionId: "s1",
  generation: 3,
  backend: "tmux",
  rows: 24,
  cols: 80,
  alive: true,
};

describe("terminal transport", () => {
  let socket: FakeSocket;
  let transport: TerminalTransport;
  const handlers = {
    onHello: vi.fn(),
    onSnapshot: vi.fn(),
    onOutput: vi.fn(),
    onStatus: vi.fn(),
    onWarning: vi.fn(),
    onStale: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    socket = new FakeSocket();
    transport = createTerminalTransport("ws://x", handlers, () => socket);
  });

  it("waits for hello before delivering output", () => {
    socket.emit("open", {});
    expect(transport.state).toBe("attaching");

    socket.frame({ type: "output", data: "early" });
    expect(handlers.onOutput).not.toHaveBeenCalled();

    socket.frame(HELLO);
    expect(transport.state).toBe("live");
    expect(transport.generation).toBe(3);
    expect(handlers.onHello).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 3, backend: "tmux", alive: true }),
    );
    // 攒下的那帧在 hello（调用方清屏）之后才落到 xterm 上
    expect(handlers.onOutput).toHaveBeenCalledWith("early");
  });

  it("applies snapshot then streams output", () => {
    socket.frame(HELLO);
    socket.frame({ type: "snapshot", data: "screen" });
    socket.frame({ type: "output", data: "tick" });
    expect(handlers.onSnapshot).toHaveBeenCalledWith("screen");
    expect(handlers.onOutput).toHaveBeenCalledWith("tick");
  });

  it("queues client frames until hello and collapses resizes", () => {
    transport.resize(80, 24);
    transport.input("a");
    transport.resize(100, 30);
    expect(socket.sent).toHaveLength(0);

    socket.frame(HELLO);
    expect(socket.parsedSent()).toEqual([
      { type: "input", data: "a" },
      { type: "resize", cols: 100, rows: 30 },
    ]);
  });

  it("reports stale, stops delivering and closes the socket", () => {
    socket.frame(HELLO);
    socket.frame({ type: "stale", generation: 3 });

    expect(handlers.onStale).toHaveBeenCalledWith(3);
    expect(transport.state).toBe("stale");
    expect(socket.closed).toBe(true);

    socket.frame({ type: "output", data: "ignored" });
    expect(handlers.onOutput).not.toHaveBeenCalled();
  });

  it("forwards status and warning frames", () => {
    socket.frame(HELLO);
    socket.frame({ type: "status", status: "exited", exitCode: 130 });
    socket.frame({ type: "warning", message: "backpressure" });
    expect(handlers.onStatus).toHaveBeenCalledWith("exited", 130);
    expect(handlers.onWarning).toHaveBeenCalledWith("backpressure");
  });

  it("ignores malformed frames instead of tearing down the stream", () => {
    socket.frame(HELLO);
    socket.emit("message", { data: "not json" });
    socket.frame({ type: "nope" });
    socket.frame({ type: "output", data: "still here" });
    expect(handlers.onOutput).toHaveBeenCalledExactlyOnceWith("still here");
    expect(transport.state).toBe("live");
  });

  it("sends the three-level terminate mode", () => {
    socket.frame(HELLO);
    transport.terminate("session");
    expect(socket.parsedSent().at(-1)).toEqual({
      type: "terminate",
      mode: "session",
    });
  });

  it("stops sending after close", () => {
    socket.frame(HELLO);
    transport.close();
    const before = socket.sent.length;
    transport.input("x");
    expect(socket.sent).toHaveLength(before);
    expect(transport.state).toBe("closed");
  });
});
