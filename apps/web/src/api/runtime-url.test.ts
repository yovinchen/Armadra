import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostServedOrigin,
  isShellTransport,
  nativeShellRuntimeUrl,
  resetShellEndpoints,
  resolveRuntimeUrl,
  resolveSocketBase,
  runtimeSocketUrl,
  shellEndpoints,
  TRANSPORT_PATH,
} from "./runtime-url";

/** Stands in for the Electron preload bridge. */
function electronShell(
  endpoints: Partial<{
    httpBase: string;
    wsBase: string;
    hostBase: string;
    dataDir: string;
  }> = {},
): void {
  resetShellEndpoints();
  vi.stubGlobal("window", {
    armadra: {
      transport: {
        endpointsSync: () => ({
          httpBase: "http://127.0.0.1:52341",
          wsBase: "ws://127.0.0.1:52341",
          hostBase: "http://127.0.0.1:43121",
          dataDir: "/tmp/armadra",
          ...endpoints,
        }),
        endpoints: () => Promise.resolve({}),
      },
      identity: { ticket: () => Promise.resolve({ ok: false }) },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetShellEndpoints();
});

describe("Runtime addresses across desktop and web", () => {
  it("keeps the loopback default for a local development page", () => {
    expect(resolveRuntimeUrl(undefined, "http://127.0.0.1:1420/")).toBe(
      "http://127.0.0.1:43120",
    );
    expect(resolveRuntimeUrl(undefined, "http://localhost:5173/")).toBe(
      "http://127.0.0.1:43120",
    );
  });
  it("uses its own origin when the Host served this page over HTTPS", () => {
    // H02: the Host proxies /api and the WebSockets on the same origin, and an
    // HTTPS page could not reach a loopback HTTP port anyway.
    expect(resolveRuntimeUrl(undefined, "https://192.168.1.20:8443/")).toBe(
      "https://192.168.1.20:8443",
    );
    expect(
      resolveRuntimeUrl(undefined, "https://canvas.example/workspace/one"),
    ).toBe("https://canvas.example");
    // The packaged desktop shell still wins: it has no port to talk to.
    expect(resolveRuntimeUrl(undefined, "https://tauri.localhost/")).toBe(
      "https://armadra.localhost",
    );
    expect(hostServedOrigin("http://127.0.0.1:1420/")).toBe(null);
    expect(hostServedOrigin("https://tauri.localhost/")).toBe(null);
    expect(hostServedOrigin("not a url")).toBe(null);
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

/**
 * The Electron shell (docs/design/electron-migration.md §2.1). The page is
 * served over loopback HTTP and talks to the Runtime directly; the Runtime's
 * port is the kernel's, so the only thing that knows it is the shell.
 */
describe("Runtime addresses inside the Electron shell", () => {
  it("takes the base from the shell, not from the page's own address", () => {
    // In development the page is on Vite's port — which is not the Runtime's
    // and is not the documented default either.
    electronShell();
    expect(resolveRuntimeUrl(undefined, "http://127.0.0.1:1420/")).toBe(
      "http://127.0.0.1:52341",
    );
    // And once packaged, from the shell's own static server.
    expect(resolveRuntimeUrl(undefined, "http://127.0.0.1:61000/")).toBe(
      "http://127.0.0.1:52341",
    );
  });

  it("reads the bridge once and remembers the answer", () => {
    let reads = 0;
    resetShellEndpoints();
    vi.stubGlobal("window", {
      armadra: {
        transport: {
          endpointsSync: () => {
            reads += 1;
            return {
              httpBase: "http://127.0.0.1:52341",
              wsBase: "ws://127.0.0.1:52341",
              hostBase: "http://127.0.0.1:43121",
              dataDir: "/tmp",
            };
          },
        },
      },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) shellEndpoints();
    expect(reads).toBe(1);
  });

  it("lets an explicit address win, as it always has", () => {
    electronShell();
    expect(
      resolveRuntimeUrl("http://127.0.0.1:43120", "http://127.0.0.1:1420/"),
    ).toBe("http://127.0.0.1:43120");
  });

  it("uses the shell's WebSocket base without asking for a forwarder", async () => {
    electronShell();
    const fetcher = vi.fn();
    const base = resolveRuntimeUrl(undefined, "http://127.0.0.1:1420/");
    // There is no custom scheme and no forwarding port any more: the socket
    // base came with the HTTP one.
    expect(await resolveSocketBase(base, fetcher)).toBe("ws://127.0.0.1:52341");
    expect(fetcher).not.toHaveBeenCalled();
    expect(isShellTransport(base)).toBe(true);
    expect(isShellTransport("http://127.0.0.1:43120")).toBe(false);
  });

  it("never follows the shell to an address that is not loopback", () => {
    for (const httpBase of [
      "https://armadra.example",
      "http://10.0.0.5:43120",
      "http://user:pass@127.0.0.1:43120",
      "not a url",
    ]) {
      electronShell({ httpBase });
      // The bridge is refused outright rather than half-believed, so the page
      // falls back exactly as it would in a browser.
      expect(shellEndpoints(), httpBase).toBeNull();
      expect(resolveRuntimeUrl(undefined, "http://127.0.0.1:1420/")).toBe(
        "http://127.0.0.1:43120",
      );
    }
  });

  it("derives the socket base when the shell's is unusable", async () => {
    electronShell({ wsBase: "wss://armadra.example" });
    const base = resolveRuntimeUrl(undefined, "http://127.0.0.1:1420/");
    expect(await resolveSocketBase(base, vi.fn())).toBe("ws://127.0.0.1:52341");
  });

  it("is absent in a browser and in the Tauri shell", () => {
    vi.stubGlobal("window", {});
    resetShellEndpoints();
    expect(shellEndpoints()).toBeNull();
    expect(resolveRuntimeUrl(undefined, "tauri://localhost/")).toBe(
      "armadra://localhost",
    );
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
