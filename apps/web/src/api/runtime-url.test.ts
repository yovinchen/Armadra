import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostServedOrigin,
  isShellTransport,
  resetShellEndpoints,
  resolveRuntimeUrl,
  resolveSocketBase,
  runtimeSocketUrl,
  shellEndpoints,
} from "./runtime-url";

/** Stands in for the shell's preload bridge. */
function shell(
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
    expect(hostServedOrigin("http://127.0.0.1:1420/")).toBe(null);
    expect(hostServedOrigin("not a url")).toBe(null);
  });
  it("never treats a loopback HTTP page as Host-served", () => {
    // The shell's own static server is loopback HTTP; it answers through the
    // preload bridge, never by guessing from the page's address.
    expect(hostServedOrigin("http://127.0.0.1:61000/")).toBe(null);
    expect(resolveRuntimeUrl(undefined, "http://127.0.0.1:61000/")).toBe(
      "http://127.0.0.1:43120",
    );
  });
  it("lets an explicit address win", () => {
    // Desktop development still points at an external Runtime on its port.
    expect(
      resolveRuntimeUrl("http://127.0.0.1:43120", "http://127.0.0.1:61000/"),
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
 * The desktop shell (docs/design/electron-migration.md §2.1). The page is
 * served over loopback HTTP and talks to the Runtime directly; the Runtime's
 * port is the kernel's, so the only thing that knows it is the shell.
 */
describe("Runtime addresses inside the desktop shell", () => {
  it("takes the base from the shell, not from the page's own address", () => {
    // In development the page is on Vite's port — which is not the Runtime's
    // and is not the documented default either.
    shell();
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
    shell();
    expect(
      resolveRuntimeUrl("http://127.0.0.1:43120", "http://127.0.0.1:1420/"),
    ).toBe("http://127.0.0.1:43120");
  });

  it("does not let the dev server's proxy opt-in override the shell", () => {
    // `""` is what apps/web's Vite config defines once it has found a Runtime:
    // a browser tab then proxies through 1420. Inside the shell that would
    // route every socket through the dev proxy, unlike the packaged build.
    shell();
    expect(resolveRuntimeUrl("", "http://127.0.0.1:1420/")).toBe(
      "http://127.0.0.1:52341",
    );
    expect(resolveSocketBase("http://127.0.0.1:52341")).toBe(
      "ws://127.0.0.1:52341",
    );
  });

  it("uses the shell's WebSocket base without asking for a forwarder", () => {
    shell();
    const base = resolveRuntimeUrl(undefined, "http://127.0.0.1:1420/");
    // There is no custom scheme and no forwarding port any more: the socket
    // base came with the HTTP one, so this resolution is synchronous.
    expect(resolveSocketBase(base)).toBe("ws://127.0.0.1:52341");
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
      shell({ httpBase });
      // The bridge is refused outright rather than half-believed, so the page
      // falls back exactly as it would in a browser.
      expect(shellEndpoints(), httpBase).toBeNull();
      expect(resolveRuntimeUrl(undefined, "http://127.0.0.1:1420/")).toBe(
        "http://127.0.0.1:43120",
      );
    }
  });

  it("derives the socket base when the shell's is unusable", () => {
    shell({ wsBase: "wss://armadra.example" });
    const base = resolveRuntimeUrl(undefined, "http://127.0.0.1:1420/");
    expect(resolveSocketBase(base)).toBe("ws://127.0.0.1:52341");
  });

  it("is absent in a browser", () => {
    vi.stubGlobal("window", {});
    resetShellEndpoints();
    expect(shellEndpoints()).toBeNull();
    expect(resolveRuntimeUrl(undefined, "http://127.0.0.1:1420/")).toBe(
      "http://127.0.0.1:43120",
    );
  });
});

describe("WebSocket base resolution", () => {
  it("leaves a real HTTP address alone and asks nobody", () => {
    expect(resolveSocketBase("http://127.0.0.1:43120")).toBe(
      "http://127.0.0.1:43120",
    );
    expect(isShellTransport("http://127.0.0.1:43120")).toBe(false);
  });

  it("keeps a Host-served origin as its own socket base", () => {
    // `runtimeSocketUrl` is what upgrades the scheme; the base is unchanged.
    expect(resolveSocketBase("https://canvas.example/runtime")).toBe(
      "https://canvas.example/runtime",
    );
    expect(isShellTransport("https://canvas.example/runtime")).toBe(false);
  });

  it("does not hand the shell's socket base to a base the shell did not give", () => {
    // Desktop development can point at an external Runtime; that Runtime's
    // own port is its socket port, not the one the shell announced.
    shell();
    expect(resolveSocketBase("http://127.0.0.1:43120")).toBe(
      "http://127.0.0.1:43120",
    );
  });
});
