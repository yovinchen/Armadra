import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthenticatedSessionSchema,
  ErrorResponseSchema,
  HelloRequestSchema,
  HelloResponseSchema,
  ListDevicesRequestSchema,
  ListDevicesResponseSchema,
  LogoutSessionRequestSchema,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  PairDeviceRequestSchema,
  RefreshSessionRequestSchema,
  RenewCsrfRequestSchema,
  RenewCsrfResponseSchema,
  RevokeDeviceRequestSchema,
  RevokeDeviceResponseSchema,
  SessionClosedResponseSchema,
  CurrentSessionRequestSchema,
  create,
  fromBinary,
  toBinary,
} from "@armadra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open";
import type { CoreRequest } from "../http/router";
import {
  BROWSER_SESSION_CAPABILITY,
  IdentityHttp,
  MEDIA_TYPE,
  NATIVE_SESSION_CAPABILITY,
  RPC_METHODS,
  bearerCredential,
  cookieName,
} from "./http";
import { allScopes } from "./scopes";
import { IdentityService } from "./service";
import { IdentityStore } from "./store";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../../../runtime/migrations");
const unifiedDir = resolve(here, "../db/migrations");
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
    unifiedMigrationsDir: unifiedDir,
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
      const face = url.pathname.startsWith("/api/identity/")
        ? http.api(core, response, {})
        : http.rpc(core, response, {});
      void face;
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

async function rpc(
  fixture: Harness,
  method: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${fixture.base}/rpc/armadra.v1.${method}`, {
    method: "POST",
    headers: {
      "content-type": MEDIA_TYPE,
      accept: MEDIA_TYPE,
      origin: fixture.origin,
      ...headers,
    },
    body: new Uint8Array(body),
  });
}

async function wire(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

async function pair(fixture: Harness) {
  const ticket = fixture.service.issueBootstrap({
    hostId: fixture.hostId,
    instanceId: INSTANCE,
    origin: fixture.origin,
    deviceName: "本机桌面",
    scopes: allScopes(),
  });
  const response = await rpc(
    fixture,
    "IdentityService/Pair",
    toBinary(
      PairDeviceRequestSchema,
      create(PairDeviceRequestSchema, {
        ticket: ticket.ticket,
        expectedHostId: fixture.hostId,
        expectedInstanceId: INSTANCE,
      }),
    ),
  );
  expect(response.status).toBe(200);
  const session = fromBinary(AuthenticatedSessionSchema, await wire(response));
  return { ticket, session };
}

describe("the compatibility face", () => {
  it("covers the eight methods the front end sends", () => {
    expect([...RPC_METHODS]).toHaveLength(8);
  });

  it("answers Hello with the host identity and the session capabilities", async () => {
    const fixture = await harness();
    const response = await rpc(
      fixture,
      "HostService/Hello",
      toBinary(
        HelloRequestSchema,
        create(HelloRequestSchema, {
          clientId: "test",
          protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
        }),
      ),
    );
    expect(response.headers.get("content-type")).toBe(MEDIA_TYPE);
    const hello = fromBinary(HelloResponseSchema, await wire(response));
    expect(hello.hostId).toBe(fixture.hostId);
    expect(hello.hostInstanceId).toBe(INSTANCE);
    expect(hello.protocol?.major).toBe(PROTOCOL_MAJOR);
    expect(hello.maxFrameBytes).toBeGreaterThan(0);
    expect(hello.capabilities).toContain(NATIVE_SESSION_CAPABILITY);
    expect(hello.capabilities).toContain(BROWSER_SESSION_CAPABILITY);
  });

  it("never advertises a minor above the one it speaks", async () => {
    const fixture = await harness();
    const response = await rpc(
      fixture,
      "HostService/Hello",
      toBinary(
        HelloRequestSchema,
        create(HelloRequestSchema, {
          clientId: "test",
          protocol: { major: PROTOCOL_MAJOR, minor: 99 },
        }),
      ),
    );
    const hello = fromBinary(HelloResponseSchema, await wire(response));
    expect(hello.protocol?.minor).toBe(PROTOCOL_MINOR);
  });

  it("pairs a ticket and answers the native bearers in the body", async () => {
    const fixture = await harness();
    const { session } = await pair(fixture);
    expect(session.hostId).toBe(fixture.hostId);
    expect(session.device?.role).toBe("owner");
    expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.native?.accessToken).toMatch(
      /^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/,
    );
    expect(session.native?.refreshToken).not.toBe(session.native?.accessToken);
    expect(session.scopes.length).toBeGreaterThan(0);
  });

  it("gives a loopback HTTP origin no cookie session", async () => {
    const fixture = await harness();
    const ticket = fixture.service.issueBootstrap({
      hostId: fixture.hostId,
      instanceId: INSTANCE,
      origin: fixture.origin,
      deviceName: "本机桌面",
      scopes: allScopes(),
    });
    const response = await rpc(
      fixture,
      "IdentityService/Pair",
      toBinary(
        PairDeviceRequestSchema,
        create(PairDeviceRequestSchema, {
          ticket: ticket.ticket,
          expectedHostId: fixture.hostId,
          expectedInstanceId: INSTANCE,
        }),
      ),
    );
    // Cookie 不按端口隔离，回环 HTTP 上发 Cookie 等于发给同一个 profile 下的
    // 任何本机端口。这条传输只发 Bearer。
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refuses the second use of the same ticket", async () => {
    const fixture = await harness();
    const { ticket } = await pair(fixture);
    const again = await rpc(
      fixture,
      "IdentityService/Pair",
      toBinary(
        PairDeviceRequestSchema,
        create(PairDeviceRequestSchema, {
          ticket: ticket.ticket,
          expectedHostId: fixture.hostId,
          expectedInstanceId: INSTANCE,
        }),
      ),
    );
    expect(again.status).toBe(401);
    expect(fromBinary(ErrorResponseSchema, await wire(again)).code).toBe(
      "UNAUTHENTICATED",
    );
  });

  it("reads the current session from the access bearer", async () => {
    const fixture = await harness();
    const { session } = await pair(fixture);
    const response = await rpc(
      fixture,
      "IdentityService/Current",
      toBinary(
        CurrentSessionRequestSchema,
        create(CurrentSessionRequestSchema),
      ),
      { authorization: `Bearer ${session.native?.accessToken}` },
    );
    expect(response.status).toBe(200);
    const current = fromBinary(
      AuthenticatedSessionSchema,
      await wire(response),
    );
    expect(current.device?.deviceId).toBe(session.device?.deviceId);
    // Current 不发新的 CSRF：它不是一次轮转。
    expect(current.csrfToken).toBe("");
  });

  it("answers 401 without a bearer at all", async () => {
    const fixture = await harness();
    await pair(fixture);
    const response = await rpc(
      fixture,
      "IdentityService/Current",
      toBinary(
        CurrentSessionRequestSchema,
        create(CurrentSessionRequestSchema),
      ),
    );
    expect(response.status).toBe(401);
  });

  it("rotates, then refuses the rotated-away refresh bearer", async () => {
    const fixture = await harness();
    const { session } = await pair(fixture);
    const rotate = () =>
      rpc(
        fixture,
        "IdentityService/Refresh",
        toBinary(
          RefreshSessionRequestSchema,
          create(RefreshSessionRequestSchema),
        ),
        {
          authorization: `Bearer ${session.native?.refreshToken}`,
          "x-armadra-csrf": session.csrfToken,
        },
      );
    const first = await rotate();
    expect(first.status).toBe(200);
    const second = await rotate();
    expect(second.status).toBe(401);
  });

  it("renews a lost CSRF from the refresh bearer", async () => {
    const fixture = await harness();
    const { session } = await pair(fixture);
    const response = await rpc(
      fixture,
      "IdentityService/RenewCsrf",
      toBinary(RenewCsrfRequestSchema, create(RenewCsrfRequestSchema)),
      { authorization: `Bearer ${session.native?.refreshToken}` },
    );
    expect(response.status).toBe(200);
    expect(
      fromBinary(RenewCsrfResponseSchema, await wire(response)).csrfToken,
    ).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("logs out and then refuses the access bearer", async () => {
    const fixture = await harness();
    const { session } = await pair(fixture);
    const logout = await rpc(
      fixture,
      "IdentityService/Logout",
      toBinary(LogoutSessionRequestSchema, create(LogoutSessionRequestSchema)),
      {
        authorization: `Bearer ${session.native?.refreshToken}`,
        "x-armadra-csrf": session.csrfToken,
      },
    );
    expect(
      fromBinary(SessionClosedResponseSchema, await wire(logout)).closed,
    ).toBe(true);
    const current = await rpc(
      fixture,
      "IdentityService/Current",
      toBinary(
        CurrentSessionRequestSchema,
        create(CurrentSessionRequestSchema),
      ),
      { authorization: `Bearer ${session.native?.accessToken}` },
    );
    expect(current.status).toBe(401);
  });

  it("lists devices and revokes one, after which its session is 401", async () => {
    const fixture = await harness();
    const { session } = await pair(fixture);
    const list = await rpc(
      fixture,
      "IdentityService/ListDevices",
      toBinary(
        ListDevicesRequestSchema,
        create(ListDevicesRequestSchema, { limit: 50 }),
      ),
      { authorization: `Bearer ${session.native?.accessToken}` },
    );
    const page = fromBinary(ListDevicesResponseSchema, await wire(list));
    expect(page.devices).toHaveLength(1);
    expect(page.devices[0]?.displayName).toBe("本机桌面");

    const revoke = await rpc(
      fixture,
      "IdentityService/RevokeDevice",
      toBinary(
        RevokeDeviceRequestSchema,
        create(RevokeDeviceRequestSchema, {
          deviceId: session.device?.deviceId as string,
          expectedRevision: 1n,
        }),
      ),
      {
        authorization: `Bearer ${session.native?.accessToken}`,
        "x-armadra-csrf": session.csrfToken,
      },
    );
    expect(revoke.status).toBe(200);
    expect(
      fromBinary(RevokeDeviceResponseSchema, await wire(revoke)).revoked,
    ).toBe(true);

    const after = await rpc(
      fixture,
      "IdentityService/Current",
      toBinary(
        CurrentSessionRequestSchema,
        create(CurrentSessionRequestSchema),
      ),
      { authorization: `Bearer ${session.native?.accessToken}` },
    );
    expect(after.status).toBe(401);
  });

  it("refuses a request with no Origin, and one that is not protobuf", async () => {
    const fixture = await harness();
    const missing = await fetch(
      `${fixture.base}/rpc/armadra.v1.IdentityService/Current`,
      {
        method: "POST",
        headers: { "content-type": MEDIA_TYPE },
        body: new Uint8Array(),
      },
    );
    expect(missing.status).toBe(403);
    const wrongType = await fetch(
      `${fixture.base}/rpc/armadra.v1.IdentityService/Current`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixture.origin },
        body: "{}",
      },
    );
    expect(wrongType.status).toBe(415);
  });

  it("answers an unknown method 404 rather than pretending", async () => {
    const fixture = await harness();
    const response = await rpc(
      fixture,
      "IdentityService/Nonsense",
      new Uint8Array(),
    );
    expect(response.status).toBe(404);
  });

  it("allows the Authorization header on the native preflight only", async () => {
    const fixture = await harness();
    const allowed = await fetch(
      `${fixture.base}/rpc/armadra.v1.IdentityService/Current`,
      {
        method: "OPTIONS",
        headers: {
          origin: fixture.origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type, authorization",
        },
      },
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-headers")).toContain(
      "Authorization",
    );
    const refused = await fetch(
      `${fixture.base}/rpc/armadra.v1.IdentityService/Current`,
      {
        method: "OPTIONS",
        headers: {
          origin: fixture.origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-somebody-elses-header",
        },
      },
    );
    expect(refused.status).toBe(403);
  });
});

describe("the new face", () => {
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

  it("reports a failure as { code, message }", async () => {
    const fixture = await harness();
    const response = await fetch(`${fixture.base}/api/identity/session`, {
      headers: { origin: fixture.origin },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Device session is invalid or expired",
    });
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
