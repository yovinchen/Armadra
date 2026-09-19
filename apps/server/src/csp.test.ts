import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../../desktop/src/shell-core/csp";
import { serverContentSecurityPolicy } from "./csp";

describe("服务器壳的 CSP", () => {
  it("与桌面壳同一个来源：指令集合逐条相同", () => {
    const desktop = contentSecurityPolicy()
      .split("; ")
      .map((directive) => directive.split(" ")[0]);
    const server = serverContentSecurityPolicy()
      .split("; ")
      .map((directive) => directive.split(" ")[0]);
    // 指令一条不多一条不少：桌面壳那边收紧什么，这边自动跟着收紧。
    expect(server).toEqual(desktop);
  });

  it("只摘掉回环授权", () => {
    const policy = serverContentSecurityPolicy();
    expect(policy).not.toContain("127.0.0.1");
    expect(policy).not.toContain("localhost");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("img-src 'self' data: blob:");
  });

  it("其余每一条逐字继承", () => {
    const policy = serverContentSecurityPolicy();
    for (const directive of [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
    ]) {
      expect(policy).toContain(directive);
    }
  });
});
