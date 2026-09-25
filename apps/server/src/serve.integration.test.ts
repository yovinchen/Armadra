import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "./serve";
import { tempDir } from "../../desktop/src/core/testing/temp-dir";

/**
 * 装配级用例：真起一次 `serve`。
 *
 * 这一支同时是「core 不依赖 Electron」的端到端证明——`apps/server` 是个纯 Node
 * 进程，它能把 core 整个装起来并对外服务，本身就说明扫描器守住的那条边界是真
 * 的（`core/no-electron.test.ts` 守的是源码，这里守的是运行时）。
 *
 * 覆盖：健康检查、静态托管与 CSP、根限定（`..` 与指向包外的符号链接）、未认证
 * 的 401、来源不在白名单的 403、配对之后带 Cookie 的 200、撤销之后立刻回到 401。
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../desktop/src/core/db/migrations");

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

let running: Awaited<ReturnType<typeof serve>>;
let origin: string;
let outside: string;
let webRoot: string;

function call(
  path: string,
  options: {
    method?: string;
    origin?: string | null;
    cookie?: string;
    csrf?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Answer> {
  const url = new URL(path, origin);
  return new Promise((done, failed) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.origin !== null) headers.origin = options.origin ?? origin;
    if (options.cookie !== undefined) headers.cookie = options.cookie;
    if (options.csrf !== undefined) headers["x-armadra-csrf"] = options.csrf;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(options.body));
    }
    const client = httpsRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method ?? "GET",
        headers,
        // 自签名证书：这条用例验证的是服务器壳的行为，不是证书链。
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    client.on("error", failed);
    if (options.body !== undefined) client.write(options.body);
    client.end();
  });
}

beforeAll(async () => {
  const dataDir = tempDir("armadra-server-");
  webRoot = tempDir("armadra-web-");
  outside = tempDir("armadra-outside-");
  writeFileSync(join(outside, "secret.txt"), "不该被读到");
  writeFileSync(
    join(webRoot, "index.html"),
    "<!doctype html><title>armadra</title>",
  );
  mkdirSync(join(webRoot, "assets"));
  writeFileSync(
    join(webRoot, "assets", "app-D3fK9x2a.js"),
    "export const a = 1;\n",
  );
  writeFileSync(join(webRoot, "assets", "plain.js"), "export const b = 2;\n");
  // 包内一个指向包外的符号链接：字符串上完全合法，只有 realpath 那道拦得住。
  symlinkSync(join(outside, "secret.txt"), join(webRoot, "escape.txt"));
  running = await serve({
    listen: { host: "127.0.0.1", port: 0 },
    publicOrigins: [],
    dataDir,
    webRoot,
    deviceName: "测试设备",
    pairing: true,
    env: {
      ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
      ARMADRA_LOG: "error",
    },
    stdout: () => {},
    moduleDir: here,
  });
  origin = running.origin;
});

afterAll(async () => {
  await running?.stop();
});

describe("服务器壳的装配", () => {
  it("在配置的地址上用 TLS 服务，并答健康检查", async () => {
    expect(origin.startsWith("https://127.0.0.1:")).toBe(true);
    expect(running.tls.selfSigned).toBe(true);
    const answer = await call("/health", { origin: null });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body).status).toBe("ok");
  });

  it("托管 index.html，带 CSP 且不缓存", async () => {
    const answer = await call("/", { origin: null });
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(String(answer.headers["content-security-policy"])).toContain(
      "frame-ancestors 'none'",
    );
    // 回环授权是桌面壳的事；服务器壳的页面和 core 同源。
    expect(String(answer.headers["content-security-policy"])).not.toContain(
      "127.0.0.1",
    );
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.body).toContain("armadra");
  });

  it("未知路径回退到 index.html，缺的资产仍然是 404", async () => {
    expect((await call("/workspace/abc", { origin: null })).status).toBe(200);
    expect((await call("/assets/missing.js", { origin: null })).status).toBe(
      404,
    );
  });

  it("带哈希的资产可以永久缓存", async () => {
    const hashed = await call("/assets/app-D3fK9x2a.js", { origin: null });
    expect(hashed.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    const plain = await call("/assets/plain.js", { origin: null });
    expect(plain.headers["cache-control"]).toBe("no-cache");
  });

  it("根限定挡住 `..` 与指向包外的符号链接", async () => {
    // 一条真的能走出去的相对路径，而且带扩展名——不带扩展名的路径会被单页回退
    // 接住，那答的是 index.html，验不到根限定。
    const traversal = relative(webRoot, join(outside, "secret.txt"))
      .split(sep)
      .join("/");
    const raw = await call(`/${traversal}`, { origin: null });
    expect(raw.status).toBe(404);
    expect(raw.body).not.toContain("不该被读到");
    const encoded = await call(
      `/${traversal.split("/").map(encodeURIComponent).join("/")}`,
      { origin: null },
    );
    expect(encoded.status).toBe(404);
    expect(encoded.body).not.toContain("不该被读到");
    const escaped = await call("/escape.txt", { origin: null });
    expect(escaped.status).toBe(404);
    expect(escaped.body).not.toContain("不该被读到");
  });

  it("未认证的 /api/workspaces 是 401，来源不在白名单是 403", async () => {
    const anonymous = await call("/api/workspaces");
    expect(anonymous.status).toBe(401);
    expect(JSON.parse(anonymous.body).code).toBe("unauthenticated");
    const foreign = await call("/api/workspaces", {
      origin: "https://evil.example",
    });
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body).code).toBe("forbidden");
    // 回环专用面在公网这一侧不存在。
    expect((await call("/hook/anything", { origin: null })).status).toBe(404);
  });

  it("配对之后带 Cookie 的请求是 200，撤销之后立刻回到 401", async () => {
    const ticket = running.pairingTicket as string;
    expect(ticket).toMatch(/^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
    const paired = await call("/api/identity/pair", {
      method: "POST",
      body: JSON.stringify({ ticket }),
    });
    expect(paired.status).toBe(200);
    const cookies = paired.headers["set-cookie"] as string[];
    // `__Host-` 前缀、HttpOnly、Secure、SameSite=Strict：会话 Cookie 的四件套。
    expect(cookies.some((value) => value.startsWith("__Host-armadra_"))).toBe(
      true,
    );
    for (const value of cookies) {
      expect(value).toContain("HttpOnly");
      expect(value).toContain("Secure");
      expect(value).toContain("SameSite=Strict");
      expect(value).toContain("Path=/");
    }
    const session = JSON.parse(paired.body);
    const cookie = cookies
      .map((value) => (value.split(";")[0] as string).trim())
      .join("; ");
    const authenticated = await call("/api/workspaces", { cookie });
    expect(authenticated.status).toBe(200);

    // 写方法没有 CSRF 头一律 403，哪怕 Cookie 是对的。
    const withoutCsrf = await call("/api/workspaces", {
      method: "POST",
      cookie,
      body: JSON.stringify({ name: "x" }),
    });
    expect(withoutCsrf.status).toBe(403);

    // 一张票只能用一次。
    const replayed = await call("/api/identity/pair", {
      method: "POST",
      body: JSON.stringify({ ticket }),
    });
    expect(replayed.status).toBe(401);

    const revoked = await call("/api/identity/devices/revoke", {
      method: "POST",
      cookie,
      csrf: session.csrfToken,
      body: JSON.stringify({
        deviceId: session.device.deviceId,
        expectedRevision: session.device.revision,
      }),
    });
    expect(revoked.status).toBe(200);
    const after = await call("/api/workspaces", { cookie });
    expect(after.status).toBe(401);
  });

  it("同源的只读请求不带 Origin：凭 Sec-Fetch-Site 与 Host 补上页面来源", async () => {
    // 浏览器对同源的 GET / HEAD 不发 Origin（Fetch 规范只对跨源与写方法发）。
    // 服务器壳的页面与接口同源，所以页面的每一个读请求都长这样——此前一律
    // 403「来源不被允许」，真浏览器里连配对面板都打不开。
    const pairedAgain = await call("/api/identity/pair", {
      method: "POST",
      body: JSON.stringify({ ticket: running.pair().ticket }),
    });
    expect(pairedAgain.status).toBe(200);
    const cookie = (pairedAgain.headers["set-cookie"] as string[])
      .map((value) => (value.split(";")[0] as string).trim())
      .join("; ");
    const sameOrigin = { "sec-fetch-site": "same-origin" };

    const session = await call("/api/identity/session", {
      origin: null,
      cookie,
      headers: sameOrigin,
    });
    expect(session.status).toBe(200);
    const listed = await call("/api/workspaces", {
      origin: null,
      cookie,
      headers: sameOrigin,
    });
    expect(listed.status).toBe(200);
    expect(
      (await call("/api/health", { origin: null, headers: sameOrigin })).status,
    ).toBe(200);

    // 没有 Sec-Fetch-Site 的（不是浏览器）、跨站的、Host 不在白名单里的，照旧拒绝。
    expect(
      (await call("/api/workspaces", { origin: null, cookie })).status,
    ).toBe(403);
    expect(
      (
        await call("/api/workspaces", {
          origin: null,
          cookie,
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("/api/workspaces", {
          origin: null,
          cookie,
          headers: { ...sameOrigin, host: "evil.example" },
        })
      ).status,
    ).toBe(403);
    // 写方法浏览器一定带 Origin；不带的写照旧拒绝，不替它补。
    expect(
      (
        await call("/api/workspaces", {
          method: "POST",
          origin: null,
          cookie,
          headers: sameOrigin,
          body: JSON.stringify({ name: "x" }),
        })
      ).status,
    ).toBe(403);
  });

  it("再铸一张配对码不会复用上一张", async () => {
    const first = running.pair();
    const second = running.pair();
    expect(first.ticket).not.toBe(second.ticket);
    // 票只进片段：它不上请求行，也就不进任何访问日志。
    expect(second.url.startsWith(`${origin}/#pair=`)).toBe(true);
  });
});
