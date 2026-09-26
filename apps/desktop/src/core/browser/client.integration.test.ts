import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { CHANNEL_READY, DriveClient, UNAVAILABLE } from "./client";

/**
 * The drive channel over a real loopback socket.
 *
 * The far end here speaks the shell's half of the protocol — hello, `ready`,
 * one answer per request — rather than being the shell itself, because the
 * core may not import from `shell-core/` or `main/` (`no-electron.test.ts`)
 * and the shell's own server is covered by its own suite. What this proves is
 * the part that is this side's: that the hello goes first, that an answer
 * settles exactly the call waiting for it, that a dropped socket turns every
 * call in flight into a named absence, and that the channel comes back.
 */

interface Peer {
  readonly server: Server;
  readonly address: string;
  /** Everything the client sent after its hello. */
  readonly received: Record<string, unknown>[];
  /** Pushes one event frame at the client. */
  push(frame: Record<string, unknown>): void;
  /** Drops the live socket without closing the listener. */
  drop(): void;
  close(): Promise<void>;
}

const TOKEN = "a".repeat(64);

async function shell(
  options: { readonly token?: string; readonly answer?: unknown } = {},
): Promise<Peer> {
  const expected = options.token ?? TOKEN;
  const received: Record<string, unknown>[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(426);
    response.end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  let live: WebSocket | undefined;
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/browser/drive") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (connection) => {
      let authenticated = false;
      live = connection;
      connection.on("message", (data) => {
        const envelope = JSON.parse(String(data)) as Record<string, unknown>;
        if (!authenticated) {
          // The FIRST message must be the hello, and a wrong token is a closed
          // socket rather than an answer: the channel must not be usable to
          // probe for which verbs exist.
          if (envelope.type !== "hello" || envelope.token !== expected) {
            connection.close();
            return;
          }
          authenticated = true;
          connection.send(JSON.stringify({ type: "ready" }));
          return;
        }
        received.push(envelope);
        if (envelope.type === "notice") return;
        connection.send(
          JSON.stringify({
            id: envelope.id,
            ok: true,
            result: options.answer ?? { echoed: envelope.verb },
          }),
        );
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    address: `ws://127.0.0.1:${port}/browser/drive`,
    received,
    push: (frame) => live?.send(JSON.stringify(frame)),
    drop: () => live?.terminate(),
    close: () =>
      new Promise<void>((resolve) => {
        live?.terminate();
        sockets.close();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function settled(client: DriveClient, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (client.isConnected()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("the drive channel never became ready"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

let open: { peer?: Peer; client?: DriveClient } = {};

afterEach(async () => {
  open.client?.close();
  await open.peer?.close();
  open = {};
});

describe("the drive channel on a real socket", () => {
  it("hands over a token, is told it is ready, and carries a verb", async () => {
    const peer = await shell();
    const lines: string[] = [];
    const client = new DriveClient({
      address: peer.address,
      token: TOKEN,
      log: (message) => lines.push(message),
    });
    open = { peer, client };
    client.connect(() => {});
    await settled(client);
    // The line both sides log when the channel is up.
    expect(lines).toContain("browser drive channel ready");

    const answer = await client.drive("node-1", "read", { mode: "text" });
    expect(answer).toEqual({ echoed: "read" });
    // A verb, never a protocol method name.
    expect(peer.received[0]).toMatchObject({
      nodeId: "node-1",
      verb: "read",
      args: { mode: "text" },
    });
  });

  it("delivers the shell's events to the sink", async () => {
    const peer = await shell();
    const client = new DriveClient({ address: peer.address, token: TOKEN });
    open = { peer, client };
    const events: Record<string, unknown>[] = [];
    client.connect((event) => events.push(event));
    await settled(client);
    peer.push({
      type: "event",
      event: "navigated",
      nodeId: "node-1",
      url: "https://example.com/",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 先是通道接通那一帧（不属于任何节点），再是壳的事件。
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: CHANNEL_READY });
    expect(events[1]).toMatchObject({ event: "navigated" });
  });

  it("pushes a notice without waiting for an answer", async () => {
    const peer = await shell();
    const client = new DriveClient({ address: peer.address, token: TOKEN });
    open = { peer, client };
    client.connect(() => {});
    await settled(client);
    client.notify("node-1", "revoke", { reason: "the user took it back" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(peer.received[0]).toMatchObject({
      type: "notice",
      notice: "revoke",
      nodeId: "node-1",
    });
  });

  it("answers a named absence when the token is not the shell's", async () => {
    const peer = await shell({ token: "b".repeat(64) });
    const client = new DriveClient({ address: peer.address, token: TOKEN });
    open = { peer, client };
    client.connect(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.isConnected()).toBe(false);
    await expect(client.drive("node-1", "read", {})).rejects.toThrow(
      UNAVAILABLE,
    );
  });

  it("comes back after the socket dies", async () => {
    const peer = await shell();
    const client = new DriveClient({ address: peer.address, token: TOKEN });
    open = { peer, client };
    client.connect(() => {});
    await settled(client);
    peer.drop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.isConnected()).toBe(false);
    // A shell that restarts its window, or a socket that died under a laptop
    // lid, must not leave browser nodes permanently unavailable.
    await settled(client, 4_000);
    expect(await client.drive("node-1", "tabs", {})).toEqual({
      echoed: "tabs",
    });
  });

  it("has no channel at all when the environment says nothing", () => {
    expect(DriveClient.fromEnvironment({})).toBeUndefined();
    expect(
      DriveClient.fromEnvironment({
        ARMADRA_SHELL_DRIVE_WS: "ws://127.0.0.1:1/browser/drive",
      }),
    ).toBeUndefined();
    expect(
      DriveClient.fromEnvironment({
        ARMADRA_SHELL_DRIVE_WS: "ws://127.0.0.1:1/browser/drive",
        ARMADRA_SHELL_DRIVE_TOKEN: TOKEN,
      }),
    ).toBeInstanceOf(DriveClient);
  });
});
