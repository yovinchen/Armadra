import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * 服务器壳那条路上的双提交头（R6a / R7c）。
 *
 * 页面由 core 自己在一个 HTTPS 来源上托管，会话是 HttpOnly Cookie，所以每一次
 * 写请求都要带一枚只在页面内存里的 CSRF 令牌。桌面壳不走这条：那边是票据换
 * Bearer，Cookie 根本发不出来。
 */

const csrf = vi.hoisted(() => ({
  value: "a".repeat(43),
  ensure: vi.fn(),
  forget: vi.fn(),
}));

vi.mock("./identity", () => ({
  ensureCsrf: () => csrf.ensure() as Promise<string>,
  forgetCsrf: () => csrf.forget(),
}));

const PAGE = "https://armadra.test/";
vi.stubGlobal("window", {
  location: { href: PAGE, origin: "https://armadra.test" },
});

const { request, RUNTIME_VIA_SERVER_SHELL } = await import("./request");

let calls: { url: string; init: RequestInit }[];
let status: number[];

beforeEach(() => {
  calls = [];
  status = [200];
  csrf.ensure.mockReset().mockResolvedValue(csrf.value);
  csrf.forget.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const code = status.shift() ?? 200;
      return {
        ok: code >= 200 && code < 300,
        status: code,
        json: async () => ({ ok: true }),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const schema = z.object({ ok: z.boolean() });

describe("the server shell's CSRF header", () => {
  it("recognizes the server shell from the page it was served by", () => {
    expect(RUNTIME_VIA_SERVER_SHELL).toBe(true);
  });

  it("is absent on reads and present on writes", async () => {
    await request("/api/settings", schema);
    expect(
      (calls[0]?.init.headers as Record<string, string>)["X-Armadra-CSRF"],
    ).toBe(undefined);

    await request("/api/settings", schema, { method: "PATCH", body: "{}" });
    expect(
      (calls[1]?.init.headers as Record<string, string>)["X-Armadra-CSRF"],
    ).toBe(csrf.value);
  });

  /**
   * 轮转过的令牌是唯一值得重试的那次失败：请求根本没到达处理器，所以没有
   * 任何东西被执行两遍。其余 403 是 core 在拒绝这台设备，再发一次不会改变。
   */
  it("retries a rotated token exactly once", async () => {
    status = [403, 200];
    csrf.ensure
      .mockResolvedValueOnce(csrf.value)
      .mockResolvedValueOnce("b".repeat(43));
    await request("/api/settings", schema, { method: "PATCH", body: "{}" });
    expect(csrf.forget).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(
      (calls[1]?.init.headers as Record<string, string>)["X-Armadra-CSRF"],
    ).toBe("b".repeat(43));
  });
});
