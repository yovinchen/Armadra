import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { EventBus } from "../bus";
import type { CorePlatform } from "../platform";
import { CLOSE_GRACE_MS, CoreServer } from "./server";

/**
 * `close()` must not wait on a WebSocket: with one open, `http.Server#close`
 * never called back (the socket left its list at the upgrade), the core never
 * exited, and the shell fell through to SIGKILL and then refused to quit.
 */
describe("closing the core server", () => {
  it("returns promptly with an upgraded WebSocket still connected", async () => {
    const log = { error() {}, warn() {}, info() {}, debug() {} };
    const server = new CoreServer({
      platform: { log } as unknown as CorePlatform,
      bus: new EventBus(),
      version: "test",
    });
    const path = "/api/workspaces/{workspaceId}/events";
    server.router.handle("GET", path, () => ({ status: 200, body: {} }));
    server.stream(path, (connection) => {
      connection.on("message", () => {});
    });
    const listener = server.createListener();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const { port } = listener.address() as AddressInfo;
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/api/workspaces/w1/events`,
      // The upgrade is gated on a loopback Origin, as a browser would send.
      { origin: `http://127.0.0.1:${port}` },
    );
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });
    const closed = new Promise<void>((resolve) =>
      client.once("close", () => resolve()),
    );

    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(CLOSE_GRACE_MS);
    await closed;
    expect(client.readyState).toBe(WebSocket.CLOSED);
  });
});
