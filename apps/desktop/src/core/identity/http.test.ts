import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open";
import type { CoreRequest } from "../http/router";
import {
  BROWSER_SESSION_CAPABILITY,
  IdentityHttp,
  NATIVE_SESSION_CAPABILITY,
  bearerCredential,
  cookieName,
} from "./http";
import { MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./protocol";
import { allScopes } from "./scopes";
import { IdentityService } from "./service";
import { IdentityStore } from "./store";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const INSTANCE = "0123456789abcdef0123456789abcdef";

const closing: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) {
    try {
      await close();
    } catch {
      // Already closed.
    }
  }
});

interface Harness {
  readonly base: string;
  readonly origin: string;
  readonly hostId: string;
  readonly service: IdentityService;
}

async function harness(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "armadra-identity-http-"));
  const opened = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir,
  });
  closing.push(opened.close);
  const store = new IdentityStore(opened.database);
  const service = new IdentityService(store, INSTANCE);
  const http = new IdentityHttp({ service, instanceId: INSTANCE });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://core");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const core: CoreRequest = {
        method: (request.method ?? "GET").toUpperCase(),
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        body,
        raw: request,
        json: <T>() => JSON.parse(body.toString("utf8") || "null") as T,
      };
      void http.handle(core, response, {});
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closing.push(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${address.port}`,
    // 页面来源与 core 的地址是两回事；壳的静态服务是另一个端口。
    origin: "http://127.0.0.1:1420",
    hostId: service.hostId(),
    service,
  };
}

type Headers = Record<string, string>;

async function call(
  fixture: Harness,
  method: string,
  path: string,
  body?: unknown,
  headers: Headers = {},
): Promise<Response> {
  return fetch(`${fixture.base}/api/identity/${path}`, {
    method,
    headers: {
      origin: fixture.origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface Session {
  hostId: string;
  csrfToken: string;
  device: { deviceId: string; role: string; revision: number };
  scopes: unknown[];
  native: { accessToken: string; refreshToken: string };
}

async function pair(
  fixture: Harness,
): Promise<{ ticket: { ticket: string }; session: Session }> {
  const ticket = fixture.service.issueBootstrap({
    hostId: fixture.hostId,
    instanceId: INSTANCE,
    origin: fixture.origin,
    deviceName: "本机桌面",
    scopes: allScopes(),
  });
  const response = await call(fixture, "POST", "pair", {
    ticket: ticket.ticket,
  });
  expect(response.status).toBe(200);
  return { ticket, session: (await response.json()) as Session };
}

describe("身份域的 JSON 面", () => {
  it("Hello 报出这台 core 是谁、支持什么，不要求凭据", async () => {
    const fixture = await harness();
    const response = await call(fixture, "GET", "hello");
    expect(response.status).toBe(200);
    const hello = (await response.json()) as {
      protocol: { major: number; minor: number };
      hostId: string;
      hostInstanceId: string;
      capabilities: string[];
      maxFrameBytes: number;
    };
    expect(hello.hostId).toBe(fixture.hostId);
    expect(hello.hostInstanceId).toBe(INSTANCE);
    expect(hello.protocol).toEqual({
      major: PROTOCOL_MAJOR,
      minor: PROTOCOL_MINOR,
    });
    expect(hello.maxFrameBytes).toBe(MAX_FRAME_BYTES);
    // 页面靠这两个名字决定走原生传输还是浏览器会话。
    expect(hello.capabilities).toContain(NATIVE_SESSION_CAPABILITY);
    expect(hello.capabilities).toContain(BROWSER_SESSION_CAPABILITY);
  });

  it("配对答出原生密钥，回环 HTTP 上不发 Cookie", async () => {
    const fixture = await harness();
    const ticket = fixture.service.issueBootstrap({
      hostId: fixture.hostId,
      instanceId: INSTANCE,
      origin: fixture.origin,
      deviceName: "本机桌面",
      scopes: allScopes(),
    });
    const response = await call(fixture, "POST", "pair", {
      ticket: ticket.ticket,
    });
    const session = (await response.json()) as Session;
    expect(session.hostId).toBe(fixture.hostId);
    expect(session.device.role).toBe("owner");
    expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.native.accessToken).toMatch(
      /^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/,
    );
    expect(session.native.refreshToken).not.toBe(session.native.accessToken);
    expect(session.scopes.length).toBeGreaterThan(0);
    // Cookie 不按端口隔离：回环 HTTP 上发 Cookie 等于发给同一个 profile 下的
    // 任何本机端口。这条传输只发 Bearer。
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("同一张票用第二次就是 401", async () => {
    const fixture = await harness();
    const { ticket } = await pair(fixture);
    const again = await call(fixture, "POST", "pair", {
      ticket: ticket.ticket,
    });
    expect(again.status).toBe(401);
    expect(((await again.json()) as { code: string }).code).toBe(
      "UNAUTHENTICATED",
    );
  });

  it("从访问密钥读当前会话，没有密钥就是 401", async () => {
    const fixture = await harness();
    const { session } = await pair(fixture);
    const current = await call(fixture, "GET", "session", undefined, {
      authorization: `Bearer ${session.native.accessToken}`,
    });
    expect(current.status).toBe(200);
    expect(
      ((await current.json()) as { device: { deviceId: string } }).device
        .deviceId,
    ).toBe(session.device.deviceId);

    const anonymous = await call(fixture, "GET", "session");
    expect(anonymous.status).toBe(401);
  });

  it("轮转之后旧的刷新密钥被拒", async () => {
    const fixture = await harness();
    const { session } = await pair(fixture);
    const rotate = () =>
      call(fixture, "POST", "session/refresh", {}, {
        authorization: `Bearer ${session.native.refreshToken}`,
        "x-armadra-csrf": session.csrfToken,
      });
    expect((await rotate()).status).toBe(200);
    expect((await rotate()).status).toBe(401);
  });

  it("丢了的 CSRF 可以从刷新密钥上补一张", async () => {
    const fixture = await harness();
    const { session } = await pair(fixture);
    const response = await call(fixture, "POST", "session/csrf", {}, {
      authorization: `Bearer ${session.native.refreshToken}`,
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { csrfToken: string }).csrfToken).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });

  it("登出之后访问密钥被拒", async () => {
    const fixture = await harness();
    const { session } = await pair(fixture);
    const logout = await call(fixture, "POST", "session/logout", {}, {
      authorization: `Bearer ${session.native.refreshToken}`,
      "x-armadra-csrf": session.csrfToken,
    });
    expect(logout.status).toBe(200);
    const current = await call(fixture, "GET", "session", undefined, {
      authorization: `Bearer ${session.native.accessToken}`,
    });
    expect(current.status).toBe(401);
  });

  it("列设备、撤一台，撤掉之后它的会话就是 401", async () => {
    const fixture = await harness();
    const { session } = await pair(fixture);
    const list = await call(fixture, "GET", "devices", undefined, {
      authorization: `Bearer ${session.native.accessToken}`,
    });
    const page = (await list.json()) as { devices: { name: string }[] };
    expect(page.devices).toHaveLength(1);
    expect(page.devices[0]?.name).toBe("本机桌面");

    const revoked = await call(
      fixture,
      "POST",
      "devices/revoke",
      { deviceId: session.device.deviceId, expectedRevision: 1 },
      {
        authorization: `Bearer ${session.native.accessToken}`,
        "x-armadra-csrf": session.csrfToken,
      },
    );
    expect(revoked.status).toBe(200);

    const after = await call(fixture, "GET", "session", undefined, {
      authorization: `Bearer ${session.native.accessToken}`,
    });
    expect(after.status).toBe(401);
  });

  it("没有 Origin 的请求一律 403", async () => {
    const fixture = await harness();
    const response = await fetch(`${fixture.base}/api/identity/session`, {
      method: "GET",
    });
    expect(response.status).toBe(403);
  });

  it("不存在的动作是 404，而不是一个看起来成功的空响应", async () => {
    const fixture = await harness();
    const response = await call(fixture, "GET", "nonsense");
    expect(response.status).toBe(404);
  });

  it("失败是 { code, message }", async () => {
    const fixture = await harness();
    const response = await call(fixture, "GET", "session");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Device session is invalid or expired",
    });
  });
});

describe("配对到撤销的一整条路", () => {
  it("pairs, reads the session and revokes, in JSON", async () => {
    const fixture = await harness();
    const ticket = fixture.service.issueBootstrap({
      hostId: fixture.hostId,
      instanceId: INSTANCE,
      origin: fixture.origin,
      deviceName: "本机桌面",
      scopes: allScopes(),
    });
    const paired = await fetch(`${fixture.base}/api/identity/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: fixture.origin },
      body: JSON.stringify({ ticket: ticket.ticket }),
    });
    expect(paired.status).toBe(200);
    const session = (await paired.json()) as {
      hostId: string;
      csrfToken: string;
      device: { deviceId: string; revision: number };
      native: { accessToken: string; refreshToken: string };
    };
    expect(session.hostId).toBe(fixture.hostId);
    expect(session.native.accessToken).toMatch(
      /^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/,
    );

    const current = await fetch(`${fixture.base}/api/identity/session`, {
      headers: {
        origin: fixture.origin,
        authorization: `Bearer ${session.native.accessToken}`,
      },
    });
    expect(current.status).toBe(200);
    expect(
      ((await current.json()) as { device: { deviceId: string } }).device
        .deviceId,
    ).toBe(session.device.deviceId);

    const devices = await fetch(`${fixture.base}/api/identity/devices`, {
      headers: {
        origin: fixture.origin,
        authorization: `Bearer ${session.native.accessToken}`,
      },
    });
    expect(
      ((await devices.json()) as { devices: unknown[] }).devices,
    ).toHaveLength(1);

    const revoked = await fetch(`${fixture.base}/api/identity/devices/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: fixture.origin,
        authorization: `Bearer ${session.native.accessToken}`,
        "x-armadra-csrf": session.csrfToken,
      },
      body: JSON.stringify({
        deviceId: session.device.deviceId,
        expectedRevision: 1,
      }),
    });
    expect(revoked.status).toBe(200);
  });

});

describe("reading a credential off a request", () => {
  it("takes one bearer and refuses a malformed one", () => {
    const request = (authorization?: string): CoreRequest =>
      ({
        headers: authorization === undefined ? {} : { authorization },
      }) as unknown as CoreRequest;
    expect(bearerCredential(request("Bearer abc"))).toBe("abc");
    expect(bearerCredential(request("bearer abc"))).toBe("abc");
    expect(bearerCredential(request("Basic abc"))).toBe("");
    expect(bearerCredential(request("Bearer a b"))).toBe("");
    expect(bearerCredential(request())).toBe("");
  });

  it("names a cookie the way the Host did", () => {
    expect(cookieName("abc", false, "access")).toBe("armadra_abc_access");
    expect(cookieName("abc", true, "refresh")).toBe(
      "__Host-armadra_abc_refresh",
    );
  });
});
