import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

import { acceptKey, encodeFrame, MessageReader } from "../../shell-core/browser/websocket";
import { startDriveServer, type DriveServer } from "./drive-server";

/**
 * The drive channel end to end, against a real loopback socket.
 *
 * A mock would test the shape of the code rather than the protocol, and the
 * protocol is the part with a handshake, a masking rule and a token in it.
 */

let server: DriveServer | null = null;
const sockets: Socket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  server?.close();
  server = null;
});

/** A client, speaking RFC 6455 the way a client must: masked frames. */
function mask(payload: Buffer): Buffer {
  const key = randomBytes(4);
  const body = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    body.writeUInt8(payload.readUInt8(i) ^ key.readUInt8(i & 3), i);
  }
  const length = payload.length;
  const head =
    length < 126
      ? Buffer.from([0x81, 0x80 | length])
      : Buffer.concat([
          Buffer.from([0x81, 0x80 | 126]),
          (() => {
            const size = Buffer.alloc(2);
            size.writeUInt16BE(length);
            return size;
          })(),
        ]);
  return Buffer.concat([head, key, body]);
}

interface Client {
  send(value: unknown): void;
  next(): Promise<Record<string, unknown>>;
  closed(): Promise<void>;
}

async function dial(address: string): Promise<Client> {
  const url = new URL(address);
  const socket = connect(Number(url.port), url.hostname);
  sockets.push(socket);
  const key = randomBytes(16).toString("base64");
  await new Promise<void>((done) => socket.once("connect", () => done()));
  socket.write(
    `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  // The client side of the protocol: this server's answers are unmasked.
  const reader = new MessageReader(false);
  const inbox: Array<Record<string, unknown>> = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  let handshake = false;
  let ended = false;
  const endWaiters: Array<() => void> = [];

  socket.on("data", (chunk: Buffer) => {
    let rest = chunk;
    if (!handshake) {
      const split = chunk.indexOf("\r\n\r\n");
      const head = chunk.subarray(0, split).toString("latin1");
      expect(head).toContain("101");
      expect(head).toContain(`Sec-WebSocket-Accept: ${acceptKey(key)}`);
      handshake = true;
      rest = chunk.subarray(split + 4);
      if (rest.length === 0) return;
    }
    for (const message of reader.push(rest)) {
      if (message.kind !== "text") continue;
      const value = JSON.parse(message.data.toString("utf8")) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else inbox.push(value);
    }
  });
  socket.on("close", () => {
    ended = true;
    for (const waiter of endWaiters.splice(0)) waiter();
  });

  return {
    send: (value) => socket.write(mask(Buffer.from(JSON.stringify(value), "utf8"))),
    next: () =>
      new Promise((resolve) => {
        const ready = inbox.shift();
        if (ready) resolve(ready);
        else waiters.push(resolve);
      }),
    closed: () =>
      new Promise((resolve) => {
        if (ended) resolve();
        else endWaiters.push(resolve);
      }),
  };
}

// A short per-test timeout: every case here is a loopback round trip that
// either happens in milliseconds or is not going to happen at all, and a
// minute of waiting tells nobody anything the first second did not.
describe("the drive channel", { timeout: 10_000 }, () => {
  it("answers a correct token and then carries a verb both ways", async () => {
    const seen: unknown[] = [];
    server = await startDriveServer(async (request) => {
      seen.push(request);
      return { url: "https://example.com", title: "Example" };
    });
    const client = await dial(server.address);
    client.send({ type: "hello", token: server.token });
    expect(await client.next()).toEqual({ type: "ready" });

    client.send({ id: "r1", nodeId: "browser-1", verb: "read", args: { mode: "title" } });
    const answer = await client.next();
    expect(answer).toEqual({
      id: "r1",
      ok: true,
      result: { url: "https://example.com", title: "Example" },
    });
    expect(seen).toEqual([
      { id: "r1", nodeId: "browser-1", verb: "read", args: { mode: "title" } },
    ]);
    expect(server.connected()).toBe(true);
  });

  it("closes a socket that presents the wrong token, and answers nothing first", async () => {
    server = await startDriveServer(async () => ({}));
    const client = await dial(server.address);
    client.send({ type: "hello", token: "not-the-token" });
    await client.closed();
    expect(server.connected()).toBe(false);
  });

  it("closes a socket that sends a verb before saying hello", async () => {
    server = await startDriveServer(async () => ({}));
    const client = await dial(server.address);
    client.send({ id: "r1", nodeId: "browser-1", verb: "read", args: {} });
    await client.closed();
  });

  it("turns a thrown refusal into { code, message }", async () => {
    server = await startDriveServer(async () => {
      throw Object.assign(new Error("no drivable browser node \"browser-9\""), {
        code: "browser_not_drivable",
      });
    });
    const client = await dial(server.address);
    client.send({ type: "hello", token: server.token });
    await client.next();
    client.send({ id: "r2", nodeId: "browser-9", verb: "click", args: {} });
    expect(await client.next()).toEqual({
      id: "r2",
      ok: false,
      error: {
        code: "browser_not_drivable",
        message: 'no drivable browser node "browser-9"',
      },
    });
  });

  it("refuses a verb that is not one, without reaching the runner", async () => {
    let called = false;
    server = await startDriveServer(async () => {
      called = true;
      return {};
    });
    const client = await dial(server.address);
    client.send({ type: "hello", token: server.token });
    await client.next();
    client.send({ id: "r3", nodeId: "browser-1", verb: "Runtime.evaluate", args: {} });
    const answer = await client.next();
    expect((answer.error as { code: string }).code).toBe("browser_unknown_verb");
    expect(called).toBe(false);
  });

  it("pushes an event to whoever is connected, and drops it when nobody is", async () => {
    server = await startDriveServer(async () => ({}));
    // No peer: this must not throw.
    server.publish({ type: "event", event: "navigated", nodeId: "browser-1" });
    const client = await dial(server.address);
    client.send({ type: "hello", token: server.token });
    await client.next();
    server.publish({ type: "event", event: "navigated", nodeId: "browser-1", url: "https://a" });
    expect(await client.next()).toEqual({
      type: "event",
      event: "navigated",
      nodeId: "browser-1",
      url: "https://a",
    });
  });

  it("lets a reconnecting Runtime replace the previous peer", async () => {
    server = await startDriveServer(async () => ({ ok: true }));
    const first = await dial(server.address);
    first.send({ type: "hello", token: server.token });
    await first.next();
    const second = await dial(server.address);
    second.send({ type: "hello", token: server.token });
    expect(await second.next()).toEqual({ type: "ready" });
    await first.closed();
    expect(server.connected()).toBe(true);
  });

  it("binds loopback only", async () => {
    server = await startDriveServer(async () => ({}));
    expect(new URL(server.address).hostname).toBe("127.0.0.1");
    expect(server.address.endsWith("/browser/drive")).toBe(true);
    // A fresh 32-byte token per run, so nothing that saw a previous one is
    // still holding a key.
    expect(server.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an upgrade on any other path", async () => {
    server = await startDriveServer(async () => ({}));
    const url = new URL(server.address);
    const socket = connect(Number(url.port), url.hostname);
    sockets.push(socket);
    await new Promise<void>((done) => socket.once("connect", () => done()));
    socket.write(
      `GET /elsewhere HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    );
    await new Promise<void>((done) => socket.once("close", () => done()));
  });

  it("drops a peer that sends a frame it cannot parse", async () => {
    server = await startDriveServer(async () => ({}));
    const url = new URL(server.address);
    const client = await dial(server.address);
    client.send({ type: "hello", token: server.token });
    await client.next();
    // An UNMASKED server-shaped frame, which a client is never allowed to send.
    const socket = sockets[sockets.length - 1]!;
    socket.write(encodeFrame(0x1, Buffer.from("{}")));
    await client.closed();
    expect(createHash("sha1").update(url.host).digest("hex")).toBeTruthy();
  });
});
