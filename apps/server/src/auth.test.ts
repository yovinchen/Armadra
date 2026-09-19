import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import { IdentityError } from "../../desktop/src/core/identity/errors";
import type { IdentityService } from "../../desktop/src/core/identity/service";
import {
  accessCookieName,
  anonymousPath,
  cookieValue,
  gate,
  loopbackOnlyPath,
  safeMethod,
} from "./auth";

const HOST = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://armadra.example";

interface Seen {
  accessToken: string;
  requireCsrf: boolean;
  csrfToken: string;
  origin: string;
}

/**
 * 一份只记账的身份服务。这里验的是门自己的判定——哪些请求该带凭据、带哪一份、
 * 要不要 CSRF——而不是 `core/identity` 的认证，那边有自己的用例。
 */
function fake(outcome?: IdentityError): {
  service: IdentityService;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const service = {
    authenticate(request: {
      accessToken: string;
      requireCsrf?: boolean;
      csrfToken?: string;
      origin: string;
    }) {
      seen.push({
        accessToken: request.accessToken,
        requireCsrf: request.requireCsrf === true,
        csrfToken: request.csrfToken ?? "",
        origin: request.origin,
      });
      if (outcome !== undefined) throw outcome;
      return {} as never;
    },
  } as unknown as IdentityService;
  return { service, seen };
}

function context(outcome?: IdentityError) {
  const { service, seen } = fake(outcome);
  return {
    seen,
    value: { origins: new Set([ORIGIN]), service, hostId: HOST },
  };
}

function headers(extra: Record<string, string> = {}): IncomingHttpHeaders {
  return { origin: ORIGIN, ...extra };
}

describe("认证门", () => {
  it("回环专用面在公网这一侧不存在", () => {
    for (const path of ["/hook/abc", "/control/x", "/verify"]) {
      expect(loopbackOnlyPath(path)).toBe(true);
      expect(
        gate({ method: "GET", path, headers: headers() }, context().value),
      ).toMatchObject({ status: 404 });
    }
  });

  it("只接受白名单里的来源，逐字节比规范化之后的拼法", () => {
    const ctx = context().value;
    expect(
      gate({ method: "GET", path: "/api/workspaces", headers: headers() }, ctx),
    ).toMatchObject({ status: 401 });
    expect(
      gate(
        {
          method: "GET",
          path: "/api/workspaces",
          headers: { origin: "https://evil.example" },
        },
        ctx,
      ),
    ).toMatchObject({ status: 403 });
    // 默认端口的另一种拼法规范化之后仍是同一个来源。
    expect(
      gate(
        {
          method: "GET",
          path: "/api/workspaces",
          headers: { origin: `${ORIGIN}:443` },
        },
        ctx,
      ),
    ).toMatchObject({ status: 401 });
  });

  it("API 与升级必须带 Origin，静态请求不必", () => {
    const ctx = context().value;
    expect(
      gate({ method: "GET", path: "/api/workspaces", headers: {} }, ctx),
    ).toMatchObject({ status: 403 });
    expect(
      gate(
        {
          method: "GET",
          path: "/api/workspaces/1/events",
          headers: {},
          upgrade: true,
        },
        ctx,
      ),
    ).toMatchObject({ status: 403 });
    expect(
      gate({ method: "GET", path: "/index.html", headers: {} }, ctx),
    ).toBeUndefined();
  });

  it("Sec-Fetch-Site：发了就必须是同源，没发不放宽", () => {
    const ctx = context().value;
    expect(
      gate(
        {
          method: "GET",
          path: "/api/health",
          headers: headers({ "sec-fetch-site": "cross-site" }),
        },
        ctx,
      ),
    ).toMatchObject({ status: 403 });
    expect(
      gate(
        {
          method: "GET",
          path: "/api/health",
          headers: headers({ "sec-fetch-site": "same-origin" }),
        },
        ctx,
      ),
    ).toBeUndefined();
  });

  it("健康检查与身份面不要会话，其余都要", () => {
    const ctx = context();
    for (const path of ["/health", "/api/health", "/api/identity/pair"]) {
      expect(anonymousPath(path)).toBe(true);
      expect(
        gate({ method: "POST", path, headers: headers() }, ctx.value),
      ).toBeUndefined();
    }
    expect(ctx.seen).toHaveLength(0);
  });

  it("写方法要 CSRF，只读方法不要", () => {
    const ctx = context();
    gate(
      {
        method: "GET",
        path: "/api/workspaces",
        headers: headers({ cookie: `${accessCookieName(HOST)}=abc` }),
      },
      ctx.value,
    );
    gate(
      {
        method: "POST",
        path: "/api/workspaces",
        headers: headers({
          cookie: `${accessCookieName(HOST)}=abc`,
          "x-armadra-csrf": "secret",
        }),
      },
      ctx.value,
    );
    expect(ctx.seen[0]).toMatchObject({
      requireCsrf: false,
      accessToken: "abc",
    });
    expect(ctx.seen[1]).toMatchObject({
      requireCsrf: true,
      csrfToken: "secret",
    });
    expect(safeMethod("head")).toBe(true);
    expect(safeMethod("delete")).toBe(false);
  });

  it("认证失败是 401，CSRF 失败是 403", () => {
    const denied = context(new IdentityError("permission"));
    expect(
      gate(
        {
          method: "POST",
          path: "/api/workspaces",
          headers: headers({ cookie: `${accessCookieName(HOST)}=abc` }),
        },
        denied.value,
      ),
    ).toMatchObject({ status: 403 });
    const expired = context(new IdentityError("unauthenticated"));
    expect(
      gate(
        {
          method: "GET",
          path: "/api/workspaces",
          headers: headers({ cookie: `${accessCookieName(HOST)}=abc` }),
        },
        expired.value,
      ),
    ).toMatchObject({ status: 401 });
  });

  it("Cookie 名带 `__Host-` 前缀，同名两条按没有处理", () => {
    const name = accessCookieName(HOST);
    expect(name.startsWith("__Host-armadra_")).toBe(true);
    expect(cookieValue({ cookie: `${name}=one` }, name)).toBe("one");
    expect(cookieValue({ cookie: `${name}=one; ${name}=two` }, name)).toBe("");
    expect(cookieValue({}, name)).toBe("");
  });
});
