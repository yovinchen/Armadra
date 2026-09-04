import { describe, expect, it } from "vitest";
import { resolveRuntimeUrl, runtimeSocketUrl } from "./runtime-url";

describe("Runtime addresses across desktop and web", () => {
  it("keeps the desktop loopback default", () => {
    expect(resolveRuntimeUrl(undefined, "tauri://localhost/")).toBe(
      "http://127.0.0.1:43120",
    );
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
