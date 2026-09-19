import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CORS_HEADERS,
  CORS_METHODS,
  corsHeaders,
  isLoopbackOrigin,
  websocketOriginAllowed,
} from "./cors";

const here = dirname(fileURLToPath(import.meta.url));

describe("which origins a loopback core answers", () => {
  it("accepts the four loopback forms and nothing else", () => {
    for (const origin of [
      "http://127.0.0.1:1420",
      "http://localhost:5173",
      "http://127.0.0.1",
      "http://localhost",
    ]) {
      expect(isLoopbackOrigin(origin), origin).toBe(true);
    }
    for (const origin of [
      "https://127.0.0.1:1420",
      "http://127.0.0.2:1420",
      "http://example.com",
      "http://localhost.evil.com",
      "http://127.0.0.1.evil.com",
      "null",
      "",
    ]) {
      expect(isLoopbackOrigin(origin), origin).toBe(false);
    }
  });

  it("spells the rule the same way the Rust Runtime does", () => {
    const rust = readFileSync(
      resolve(here, "../../../../runtime/src/api/support.rs"),
      "utf8",
    );
    for (const literal of [
      'origin.starts_with("http://127.0.0.1:")',
      'origin.starts_with("http://localhost:")',
      'origin == "http://127.0.0.1"',
      'origin == "http://localhost"',
    ]) {
      expect(rust).toContain(literal);
    }
  });

  it("answers a request with no Origin at all", () => {
    // Not a browser: curl, the shell's probe and the hook client.
    expect(corsHeaders(undefined)).toEqual({});
  });

  it("echoes an allowed origin and varies on it", () => {
    expect(corsHeaders("http://127.0.0.1:1420")).toEqual({
      "access-control-allow-origin": "http://127.0.0.1:1420",
      "access-control-allow-methods": CORS_METHODS,
      "access-control-allow-headers": CORS_HEADERS,
      vary: "origin",
    });
  });

  it("refuses an origin that is not loopback", () => {
    expect(corsHeaders("http://example.com")).toBeUndefined();
  });

  it("lists the five verbs and the preflight", () => {
    expect(CORS_METHODS.split(",")).toEqual([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ]);
  });

  it("requires an origin on a WebSocket upgrade, because there is no preflight", () => {
    expect(websocketOriginAllowed(undefined)).toBe(false);
    expect(websocketOriginAllowed("http://example.com")).toBe(false);
    expect(websocketOriginAllowed("http://127.0.0.1:1420")).toBe(true);
  });
});
