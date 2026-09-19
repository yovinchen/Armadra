import { afterEach, describe, expect, it } from "vitest";
import {
  CORS_HEADERS,
  CORS_METHODS,
  allowOrigins,
  allowedOrigins,
  corsHeaders,
  isLoopbackOrigin,
  websocketOriginAllowed,
} from "./cors";

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

describe("壳注入的额外来源", () => {
  afterEach(() => allowOrigins([]));

  it("默认什么都不放行：桌面壳从不调用它", () => {
    expect(allowedOrigins()).toEqual([]);
    expect(corsHeaders("https://armadra.example")).toBeUndefined();
    expect(websocketOriginAllowed("https://armadra.example")).toBe(false);
  });

  it("注入之后 HTTP 与升级两处一起认，回环照旧", () => {
    // 服务器壳（R6a）在绑定之后注入 `--public-origin` 与监听地址自己那个来源。
    allowOrigins(["https://armadra.example", "https://armadra.example"]);
    expect(allowedOrigins()).toEqual(["https://armadra.example"]);
    expect(corsHeaders("https://armadra.example")).toMatchObject({
      "access-control-allow-origin": "https://armadra.example",
      vary: "origin",
    });
    expect(websocketOriginAllowed("https://armadra.example")).toBe(true);
    expect(corsHeaders("http://127.0.0.1:1420")).toBeDefined();
    // 注入的是数据不是规则：没在列表里的来源仍然不被回答。
    expect(corsHeaders("https://evil.example")).toBeUndefined();
    expect(websocketOriginAllowed("https://evil.example")).toBe(false);
  });

  it("逐字节比较：多一个尾斜杠就是另一个来源", () => {
    allowOrigins(["https://armadra.example"]);
    expect(corsHeaders("https://armadra.example/")).toBeUndefined();
    expect(corsHeaders("https://armadra.example:443")).toBeUndefined();
  });
});
