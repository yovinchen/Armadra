import { describe, expect, it, vi } from "vitest";
import {
  isShellTransport,
  nativeShellRuntimeUrl,
  resolveRuntimeUrl,
  resolveSocketBase,
  runtimeSocketUrl,
  TRANSPORT_PATH,
} from "./runtime-url";

describe("Runtime addresses across desktop and web", () => {
  it("keeps the loopback default outside a native shell", () => {
    expect(resolveRuntimeUrl(undefined, "http://127.0.0.1:1420/")).toBe(
      "http://127.0.0.1:43120",
    );
    expect(resolveRuntimeUrl(undefined, "https://canvas.example/app")).toBe(
      "http://127.0.0.1:43120",
    );
  });
  it("uses the shell's custom protocol when the page is a packaged desktop page", () => {
    // A packaged Runtime holds no port at all; this is the only way in.
    expect(resolveRuntimeUrl(undefined, "tauri://localhost/")).toBe(
      "armadra://localhost",
    );
    expect(
      resolveRuntimeUrl(undefined, "http://tauri.localhost/index.html"),
    ).toBe("http://armadra.localhost");
    expect(resolveRuntimeUrl(undefined, "https://tauri.localhost/")).toBe(
      "https://armadra.localhost",
    );
    // A page that merely looks similar is not a shell page.
    expect(nativeShellRuntimeUrl("https://tauri.localhost.evil.example/")).toBe(
      null,
    );
    expect(nativeShellRuntimeUrl("not a url")).toBe(null);
  });
  it("lets an explicit address win over the shell protocol", () => {
    // Desktop development still points at an external Runtime on its port.
    expect(
      resolveRuntimeUrl("http://127.0.0.1:43120", "tauri://localhost/"),
    ).toBe("http://127.0.0.1:43120");
  });
  it("supports explicit same-origin and relative proxy prefixes", () => {
    expect(resolveRuntimeUrl("", "https://canvas.example/app?board=1")).toBe(
      "https://canvas.example",
    );
    expect(resolveRuntimeUrl("/runtime/", "https://canvas.example/app")).toBe(
      "https://canvas.example/runtime",
    );
  });
  it("uses secure sockets without discarding a configured prefix", () => {
    expect(
      runtimeSocketUrl(
        "https://canvas.example/runtime",
        "/api/workspaces/one/events",
      ),
    ).toBe("wss://canvas.example/runtime/api/workspaces/one/events");
    expect(
      runtimeSocketUrl("http://127.0.0.1:43120/", "/api/terminals/one/ws"),
    ).toBe("ws://127.0.0.1:43120/api/terminals/one/ws");
  });
  it("rejects addresses that would append API paths to a query or non-HTTP scheme", () => {
    expect(() =>
      resolveRuntimeUrl("https://host/?token=secret", "https://canvas.example"),
    ).toThrow();
    expect(() =>
      resolveRuntimeUrl("file:///tmp/runtime", "https://canvas.example"),
    ).toThrow();
  });
});

describe("WebSocket base resolution", () => {
  it("leaves a real HTTP address alone and asks nobody", async () => {
    const fetcher = vi.fn();
    expect(await resolveSocketBase("http://127.0.0.1:43120", fetcher)).toBe(
      "http://127.0.0.1:43120",
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(isShellTransport("http://127.0.0.1:43120")).toBe(false);
  });

  it("asks the shell for the loopback forwarder it opened", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ websocket: "ws://127.0.0.1:51234" }),
    );
    expect(await resolveSocketBase("armadra://localhost", fetcher)).toBe(
      "ws://127.0.0.1:51234",
    );
    expect(fetcher).toHaveBeenCalledWith(
      `armadra://localhost${TRANSPORT_PATH}`,
    );
    expect(isShellTransport("armadra://localhost")).toBe(true);
    expect(isShellTransport("http://armadra.localhost")).toBe(true);
  });

  it("never follows the shell to an address that is not a loopback socket", async () => {
    for (const websocket of [
      "wss://evil.example",
      "ws://10.0.0.5:80",
      "http://127.0.0.1:51234",
      42,
      undefined,
    ]) {
      const fetcher = vi.fn(async () => Response.json({ websocket }));
      expect(await resolveSocketBase("armadra://localhost", fetcher)).toBe(
        "armadra://localhost",
      );
    }
  });

  it("falls back to the HTTP base when the shell cannot answer", async () => {
    for (const fetcher of [
      vi.fn(async () => {
        throw new Error("no shell");
      }),
      vi.fn(async () => new Response("nope", { status: 503 })),
      vi.fn(async () => new Response("not json", { status: 200 })),
    ]) {
      expect(await resolveSocketBase("armadra://localhost", fetcher)).toBe(
        "armadra://localhost",
      );
    }
  });
});
