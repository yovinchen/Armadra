import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeSocketFactory, lastSocket, resetSockets } from "./fake-socket";
import { createSessionTransport } from "./transport";

beforeEach(resetSockets);

describe("language session transport", () => {
  it("holds messages sent before the socket opens instead of dropping them", () => {
    const transport = createSessionTransport(
      "ws://x/stream",
      {},
      fakeSocketFactory,
    );
    // `LSPClient.connect()` 一被调用就发 `initialize`，而 socket 通常还在
    // 握手。丢掉它等于会话永远初始化不完。
    transport.send('{"id":1,"method":"initialize"}');
    const socket = lastSocket()!;
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toEqual(['{"id":1,"method":"initialize"}']);

    transport.send('{"method":"textDocument/didOpen"}');
    expect(socket.sent).toHaveLength(2);
  });

  it("delivers text frames to every subscriber and stops at unsubscribe", () => {
    const transport = createSessionTransport(
      "ws://x/stream",
      {},
      fakeSocketFactory,
    );
    const first = vi.fn();
    const second = vi.fn();
    transport.subscribe(first);
    transport.subscribe(second);
    const socket = lastSocket()!;
    socket.open();
    socket.receive({ method: "textDocument/publishDiagnostics" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    transport.unsubscribe(first);
    socket.receive({ method: "textDocument/publishDiagnostics" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("ignores a binary frame rather than guessing an encoding", () => {
    const transport = createSessionTransport(
      "ws://x/stream",
      {},
      fakeSocketFactory,
    );
    const handler = vi.fn();
    transport.subscribe(handler);
    const socket = lastSocket()!;
    socket.open();
    socket.onmessage?.({ data: new Uint8Array([1, 2, 3]) });
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports a drop once, and says nothing when we close it ourselves", () => {
    const onClose = vi.fn();
    const transport = createSessionTransport(
      "ws://x/stream",
      { onClose },
      fakeSocketFactory,
    );
    const socket = lastSocket()!;
    socket.open();
    socket.drop();
    expect(onClose).toHaveBeenCalledTimes(1);
    // 再来一次 close 不该让上层排第二次重连。
    socket.drop();
    expect(onClose).toHaveBeenCalledTimes(1);

    const second = createSessionTransport(
      "ws://x/stream",
      { onClose },
      fakeSocketFactory,
    );
    second.close();
    lastSocket()!.drop();
    expect(onClose).toHaveBeenCalledTimes(1);
    void transport;
  });

  it("stops sending after it has been closed", () => {
    const transport = createSessionTransport(
      "ws://x/stream",
      {},
      fakeSocketFactory,
    );
    const socket = lastSocket()!;
    socket.open();
    transport.close();
    transport.send('{"method":"textDocument/didChange"}');
    expect(socket.sent).toEqual([]);
  });
});
