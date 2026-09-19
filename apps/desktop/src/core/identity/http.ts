import type { ServerResponse } from "node:http";
import {
  AuthenticatedSessionSchema,
  ErrorResponseSchema,
  HelloRequestSchema,
  HelloResponseSchema,
  ListDevicesRequestSchema,
  ListDevicesResponseSchema,
  LogoutSessionRequestSchema,
  MAX_FRAME_BYTES,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  PairDeviceRequestSchema,
  RenewCsrfResponseSchema,
  RevokeDeviceRequestSchema,
  RevokeDeviceResponseSchema,
  SessionClosedResponseSchema,
  create,
  fromBinary,
  toBinary,
} from "@armadra/protocol";
import type { CoreRequest } from "../http/router";
import { IdentityError, identityFailure } from "./errors";
import { nativeOrigin } from "./origin";
import type {
  AccessRequest,
  IdentityService,
  Principal,
  SessionCredentials,
} from "./service";

/**
 * 身份域的两张面。
 *
 * **新面** `/api/identity/*`：JSON，`{ code, message }` 的错误信封，设计 D9 里
 * 前端最终要收到的那一套。
 *
 * **兼容面** `/rpc/armadra.v1.{HostService,IdentityService}/…`：二进制 protobuf，
 * `packages/host-client` 今天发的就是它。本批前端一行不改，所以这一面必须逐字
 * 对上：路径、`application/x-protobuf`、消息形状、以及 `Origin` 与 CSRF 的门。
 * 它活到 R7，前端改打 `/api/` 之后才删。
 *
 * **Cookie 的规矩照 Host**：只有 HTTPS 的那个权威来源才发 Cookie。回环 HTTP
 * 来源拿不到 Cookie 会话——Cookie 按 host 不按 port 隔离，`127.0.0.1:A` 的
 * Cookie 会发往同一个浏览器 profile 下的任何 `127.0.0.1:B`。桌面壳走的是票据
 * 换 Bearer 的原生传输，凭据只在页面内存里。core 今天只在回环明文 HTTP 上服务，
 * 所以实际上永远走原生传输；Cookie 那一支留着给 R6 的服务器壳。
 */

export const MEDIA_TYPE = "application/x-protobuf";
export const RPC_PREFIX = "/rpc/armadra.v1.";
export const API_PREFIX = "/api/identity/";

/** Hello 里报的两个会话能力名，`apps/web/src/host/native-session.ts` 认这两个。 */
export const NATIVE_SESSION_CAPABILITY = "identity.native-session.v1";
export const BROWSER_SESSION_CAPABILITY = "identity.browser-session.v1";

/** 兼容面覆盖的方法。少一个，页面的登录流程就断在那一步。 */
export const RPC_METHODS = [
  "HostService/Hello",
  "IdentityService/Pair",
  "IdentityService/Current",
  "IdentityService/Refresh",
  "IdentityService/RenewCsrf",
  "IdentityService/Logout",
  "IdentityService/ListDevices",
  "IdentityService/RevokeDevice",
] as const;

/** 拿刷新密钥当 Bearer 的三个方法，其余用访问密钥。 */
const REFRESH_BEARER = new Set(["Refresh", "RenewCsrf", "Logout"]);

export interface IdentityHttpOptions {
  readonly service: IdentityService;
  readonly instanceId: string;
  /** 额外的能力名，各域装配时追加。 */
  readonly capabilities?: () => readonly string[];
}

/* ------------------------------ 凭据的读取 -------------------------------- */

/** 这个请求走不走原生传输：明文连接 + 壳能呈现的回环 HTTP 来源。 */
export function nativeRequest(request: CoreRequest): boolean {
  const origin = header(request, "origin");
  return !isSecure(request) && origin !== undefined && nativeOrigin(origin);
}

function isSecure(request: CoreRequest): boolean {
  return (request.raw.socket as { encrypted?: boolean }).encrypted === true;
}

export function cookieName(
  hostId: string,
  secure: boolean,
  purpose: string,
): string {
  return `${secure ? "__Host-armadra_" : "armadra_"}${hostId}_${purpose}`;
}

/** 单独一个 Bearer，重复或不是 Bearer 一律当没有。 */
export function bearerCredential(request: CoreRequest): string {
  const raw = request.headers.authorization;
  if (typeof raw !== "string") return "";
  const separator = raw.indexOf(" ");
  if (separator < 0) return "";
  if (raw.slice(0, separator).toLowerCase() !== "bearer") return "";
  const token = raw.slice(separator + 1).trim();
  if (token === "" || /[\s,]/.test(token)) return "";
  return token;
}

function cookieCredential(
  request: CoreRequest,
  hostId: string,
  purpose: string,
): string {
  const raw = request.headers.cookie;
  if (typeof raw !== "string") return "";
  const name = cookieName(hostId, isSecure(request), purpose);
  const found = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  // 两条同名 Cookie 是一次注入尝试，不是一次可以挑一条的选择。
  return found.length === 1 ? (found[0] as string).slice(name.length + 1) : "";
}

export function credential(
  request: CoreRequest,
  hostId: string,
  purpose: "access" | "refresh",
): string {
  return nativeRequest(request)
    ? bearerCredential(request)
    : cookieCredential(request, hostId, purpose);
}

function sessionCookies(
  request: CoreRequest,
  response: ServerResponse,
  hostId: string,
  credentials: SessionCredentials,
): void {
  // 原生会话的密钥在响应体里；再发一份 Cookie 只会多留一份页面没要的副本。
  if (nativeRequest(request)) return;
  const secure = isSecure(request);
  response.setHeader(
    "set-cookie",
    (
      [
        ["access", credentials.accessToken, credentials.accessExpiresAtMs],
        ["refresh", credentials.refreshToken, credentials.expiresAtMs],
      ] as const
    ).map(
      ([purpose, value, expiry]) =>
        `${cookieName(hostId, secure, purpose)}=${value}; Path=/; Expires=${new Date(expiry).toUTCString()}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`,
    ),
  );
}

function clearSessionCookies(
  request: CoreRequest,
  response: ServerResponse,
  hostId: string,
): void {
  if (nativeRequest(request)) return;
  const secure = isSecure(request);
  response.setHeader(
    "set-cookie",
    ["access", "refresh"].map(
      (purpose) =>
        `${cookieName(hostId, secure, purpose)}=; Path=/; Max-Age=0; Expires=${new Date(1000).toUTCString()}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`,
    ),
  );
}

/* ------------------------------- 响应的形状 ------------------------------- */

function grants(principal: Principal) {
  return principal.scopes.map((value) => ({
    permission: value.Permission,
    workspaceId: value.WorkspaceID,
    executionHostId: value.ExecutionHostID,
  }));
}

function sessionMessage(
  principal: Principal,
  csrfToken: string,
  expiresAtUnixMs: number,
) {
  return create(AuthenticatedSessionSchema, {
    hostId: principal.hostId,
    device: {
      deviceId: principal.deviceId,
      principalId: principal.principalId,
      displayName: principal.deviceName,
      role: principal.role,
      createdAtUnixMs: BigInt(principal.deviceCreatedAtMs),
      revision: BigInt(principal.deviceEpoch),
    },
    scopes: grants(principal),
    csrfToken,
    expiresAtUnixMs: BigInt(expiresAtUnixMs),
  });
}

function credentialMessage(
  request: CoreRequest,
  credentials: SessionCredentials,
) {
  const message = sessionMessage(
    credentials.principal,
    credentials.csrfToken,
    credentials.accessExpiresAtMs,
  );
  if (nativeRequest(request)) {
    message.native = {
      $typeName: "armadra.v1.NativeSessionCredentials",
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
    };
  }
  return message;
}

/** 新面上的会话，JSON，camelCase。密钥不在里面——它们在 `native` 里单独给。 */
export function sessionJson(
  principal: Principal,
  expiresAtUnixMs: number,
): Record<string, unknown> {
  return {
    hostId: principal.hostId,
    device: {
      deviceId: principal.deviceId,
      principalId: principal.principalId,
      displayName: principal.deviceName,
      role: principal.role,
      createdAtUnixMs: principal.deviceCreatedAtMs,
      revision: principal.deviceEpoch,
    },
    scopes: grants(principal),
    expiresAtUnixMs,
  };
}

/* --------------------------------- 分发 ---------------------------------- */

export class IdentityHttp {
  constructor(private readonly options: IdentityHttpOptions) {}

  private get service(): IdentityService {
    return this.options.service;
  }

  capabilities(): string[] {
    return [
      NATIVE_SESSION_CAPABILITY,
      BROWSER_SESSION_CAPABILITY,
      ...(this.options.capabilities?.() ?? []),
    ];
  }

  /** 兼容面。前端发什么，这里就得收什么。 */
  async rpc(
    request: CoreRequest,
    response: ServerResponse,
    cors: Record<string, string>,
  ): Promise<void> {
    const method = request.path.slice(RPC_PREFIX.length);
    const origin = header(request, "origin");
    if (request.method === "OPTIONS") {
      this.preflight(request, response, cors, origin);
      return;
    }
    if (request.method !== "POST") {
      this.fail(response, cors, 405, "UNSUPPORTED", "A POST is required");
      return;
    }
    if (!(RPC_METHODS as readonly string[]).includes(method)) {
      this.fail(response, cors, 404, "NOT_FOUND", "No such method");
      return;
    }
    if (!this.acceptable(request)) {
      this.fail(
        response,
        cors,
        415,
        "INVALID_ARGUMENT",
        "A Protobuf request is required",
      );
      return;
    }
    if (request.body.byteLength > MAX_FRAME_BYTES) {
      this.fail(
        response,
        cors,
        413,
        "RESOURCE_EXHAUSTED",
        "Identity request exceeds its limit",
      );
      return;
    }
    if (method === "HostService/Hello") {
      this.hello(request, response, cors);
      return;
    }
    // 身份方法一律要求已经校验过的精确 Origin，并且必须是非简单 POST——这是
    // 表单与匿名导航配不了对的原因。
    if (origin === undefined || countHeader(request, "origin") !== 1) {
      this.fail(
        response,
        cors,
        403,
        "PERMISSION_DENIED",
        "Device permission or CSRF check failed",
      );
      return;
    }
    try {
      this.identity(
        request,
        response,
        cors,
        method.split("/")[1] as string,
        origin,
      );
    } catch (error) {
      const failure = identityFailure(error);
      this.fail(response, cors, failure.status, failure.code, failure.message);
    }
  }

  /** 新面。同一个服务，JSON 的外衣。 */
  async api(
    request: CoreRequest,
    response: ServerResponse,
    cors: Record<string, string>,
  ): Promise<void> {
    const action = request.path.slice(API_PREFIX.length);
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    const origin = header(request, "origin");
    if (origin === undefined || countHeader(request, "origin") !== 1) {
      this.json(response, cors, 403, {
        code: "PERMISSION_DENIED",
        message: "Device permission or CSRF check failed",
      });
      return;
    }
    const hostId = this.service.hostId();
    const csrfToken = header(request, "x-armadra-csrf") ?? "";
    const actor: AccessRequest = {
      accessToken: credential(request, hostId, "access"),
      hostId,
      origin,
      csrfToken,
    };
    try {
      switch (`${request.method} ${action}`) {
        case "POST pair": {
          const body = request.json<{ ticket?: unknown }>();
          if (typeof body?.ticket !== "string")
            throw new IdentityError("invalid");
          const credentials = this.service.consumeBootstrap({
            ticket: body.ticket,
            hostId,
            instanceId: this.options.instanceId,
            origin,
          });
          sessionCookies(request, response, hostId, credentials);
          this.json(
            response,
            cors,
            200,
            this.credentialJson(request, credentials),
          );
          return;
        }
        case "GET session": {
          const principal = this.service.authenticate(actor);
          this.json(
            response,
            cors,
            200,
            sessionJson(principal, principal.accessExpiresAtMs),
          );
          return;
        }
        case "POST session/refresh": {
          const credentials = this.service.refresh({
            refreshToken: credential(request, hostId, "refresh"),
            csrfToken,
            hostId,
            origin,
          });
          sessionCookies(request, response, hostId, credentials);
          this.json(
            response,
            cors,
            200,
            this.credentialJson(request, credentials),
          );
          return;
        }
        case "POST session/csrf": {
          this.json(response, cors, 200, {
            csrfToken: this.service.renewCsrf({
              refreshToken: credential(request, hostId, "refresh"),
              hostId,
              origin,
            }),
          });
          return;
        }
        case "POST session/logout": {
          this.service.logoutRefresh({
            refreshToken: credential(request, hostId, "refresh"),
            csrfToken,
            hostId,
            origin,
          });
          clearSessionCookies(request, response, hostId);
          this.json(response, cors, 200, { closed: true });
          return;
        }
        case "GET devices": {
          const page = this.service.listDevices(
            actor,
            request.query.get("afterId") ?? "",
            Number(request.query.get("limit") ?? 50),
          );
          this.json(response, cors, 200, page);
          return;
        }
        case "POST devices/revoke": {
          const body = request.json<{
            deviceId?: unknown;
            expectedRevision?: unknown;
          }>();
          if (
            typeof body?.deviceId !== "string" ||
            typeof body.expectedRevision !== "number"
          ) {
            throw new IdentityError("invalid");
          }
          this.service.revokeDevice(
            { ...actor, requireCsrf: true },
            body.deviceId,
            body.expectedRevision,
          );
          this.json(response, cors, 200, {
            deviceId: body.deviceId,
            revoked: true,
          });
          return;
        }
        default:
          this.json(response, cors, 404, {
            code: "NOT_FOUND",
            message: `没有这个接口：${request.path}`,
          });
          return;
      }
    } catch (error) {
      const failure = identityFailure(
        error instanceof SyntaxError ? new IdentityError("invalid") : error,
      );
      this.json(response, cors, failure.status, {
        code: failure.code,
        message: failure.message,
      });
    }
  }

  private credentialJson(
    request: CoreRequest,
    credentials: SessionCredentials,
  ): Record<string, unknown> {
    const body = sessionJson(
      credentials.principal,
      credentials.accessExpiresAtMs,
    );
    body.csrfToken = credentials.csrfToken;
    if (nativeRequest(request)) {
      body.native = {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
      };
    }
    return body;
  }

  private identity(
    request: CoreRequest,
    response: ServerResponse,
    cors: Record<string, string>,
    action: string,
    origin: string,
  ): void {
    const hostId = this.service.hostId();
    const csrfToken = header(request, "x-armadra-csrf") ?? "";
    const actor: AccessRequest = {
      accessToken: credential(request, hostId, "access"),
      hostId,
      origin,
      csrfToken,
    };
    switch (action) {
      case "Pair": {
        const input = fromBinary(PairDeviceRequestSchema, request.body);
        const credentials = this.service.consumeBootstrap({
          ticket: input.ticket,
          hostId: input.expectedHostId,
          instanceId: input.expectedInstanceId,
          origin,
        });
        sessionCookies(request, response, hostId, credentials);
        this.proto(
          response,
          cors,
          200,
          AuthenticatedSessionSchema,
          credentialMessage(request, credentials),
        );
        return;
      }
      case "Current": {
        const principal = this.service.authenticate(actor);
        this.proto(
          response,
          cors,
          200,
          AuthenticatedSessionSchema,
          sessionMessage(principal, "", principal.accessExpiresAtMs),
        );
        return;
      }
      case "Refresh": {
        const credentials = this.service.refresh({
          refreshToken: credential(request, hostId, "refresh"),
          csrfToken,
          hostId,
          origin,
        });
        sessionCookies(request, response, hostId, credentials);
        this.proto(
          response,
          cors,
          200,
          AuthenticatedSessionSchema,
          credentialMessage(request, credentials),
        );
        return;
      }
      case "RenewCsrf": {
        const csrf = this.service.renewCsrf({
          refreshToken: credential(request, hostId, "refresh"),
          hostId,
          origin,
        });
        this.proto(
          response,
          cors,
          200,
          RenewCsrfResponseSchema,
          create(RenewCsrfResponseSchema, { csrfToken: csrf }),
        );
        return;
      }
      case "Logout": {
        fromBinary(LogoutSessionRequestSchema, request.body);
        this.service.logoutRefresh({
          refreshToken: credential(request, hostId, "refresh"),
          csrfToken,
          hostId,
          origin,
        });
        clearSessionCookies(request, response, hostId);
        this.proto(
          response,
          cors,
          200,
          SessionClosedResponseSchema,
          create(SessionClosedResponseSchema, { closed: true }),
        );
        return;
      }
      case "ListDevices": {
        const input = fromBinary(ListDevicesRequestSchema, request.body);
        const limit = input.limit === 0 ? 50 : input.limit;
        const page = this.service.listDevices(actor, input.afterId, limit);
        this.proto(
          response,
          cors,
          200,
          ListDevicesResponseSchema,
          create(ListDevicesResponseSchema, {
            nextId: page.nextId,
            hasMore: page.hasMore,
            devices: page.devices.map((device) => ({
              deviceId: device.deviceId,
              principalId: device.principalId,
              displayName: device.name,
              role: device.role,
              createdAtUnixMs: BigInt(device.createdAtMs),
              revokedAtUnixMs: BigInt(device.revokedAtMs),
              revision: BigInt(device.epoch),
            })),
          }),
        );
        return;
      }
      case "RevokeDevice": {
        const input = fromBinary(RevokeDeviceRequestSchema, request.body);
        this.service.revokeDevice(
          { ...actor, requireCsrf: true },
          input.deviceId,
          Number(input.expectedRevision),
        );
        this.proto(
          response,
          cors,
          200,
          RevokeDeviceResponseSchema,
          create(RevokeDeviceResponseSchema, {
            deviceId: input.deviceId,
            revoked: true,
          }),
        );
        return;
      }
      default:
        this.fail(response, cors, 404, "NOT_FOUND", "No such method");
    }
  }

  private hello(
    request: CoreRequest,
    response: ServerResponse,
    cors: Record<string, string>,
  ): void {
    const input = fromBinary(HelloRequestSchema, request.body);
    void create(HelloRequestSchema);
    this.proto(
      response,
      cors,
      200,
      HelloResponseSchema,
      create(HelloResponseSchema, {
        protocol: {
          major: PROTOCOL_MAJOR,
          minor: Math.min(input.protocol?.minor ?? 0, PROTOCOL_MINOR),
        },
        hostInstanceId: this.options.instanceId,
        hostId: this.service.hostId(),
        capabilities: this.capabilities(),
        maxFrameBytes: MAX_FRAME_BYTES,
      }),
    );
  }

  private preflight(
    request: CoreRequest,
    response: ServerResponse,
    cors: Record<string, string>,
    origin: string | undefined,
  ): void {
    const wanted = header(request, "access-control-request-method");
    if (origin === undefined || wanted !== "POST") {
      this.fail(
        response,
        cors,
        403,
        "PERMISSION_DENIED",
        "Device permission or CSRF check failed",
      );
      return;
    }
    const native = nativeRequest(request);
    for (const line of headerList(request, "access-control-request-headers")) {
      for (const name of line.split(",")) {
        switch (name.trim().toLowerCase()) {
          case "":
          case "content-type":
          case "accept":
          case "x-armadra-csrf":
            break;
          case "authorization":
            // 只有原生传输发 Bearer；浏览器页面问能不能发，照旧拒绝。
            if (!native) {
              this.fail(
                response,
                cors,
                403,
                "PERMISSION_DENIED",
                "Device permission or CSRF check failed",
              );
              return;
            }
            break;
          default:
            this.fail(
              response,
              cors,
              403,
              "PERMISSION_DENIED",
              "Device permission or CSRF check failed",
            );
            return;
        }
      }
    }
    const headers: Record<string, string> = {
      ...cors,
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": native
        ? "Content-Type, Accept, X-Armadra-CSRF, Authorization"
        : "Content-Type, Accept, X-Armadra-CSRF",
      vary: "Access-Control-Request-Method, Access-Control-Request-Headers, Origin",
    };
    // 这条传输上没有 Cookie，也就没有带凭据的 CORS。
    if (!native) headers["access-control-allow-credentials"] = "true";
    response.writeHead(204, headers);
    response.end();
  }

  private acceptable(request: CoreRequest): boolean {
    const encoding = header(request, "content-encoding");
    if (encoding !== undefined && encoding !== "identity") return false;
    const type = header(request, "content-type");
    return type?.split(";", 1)[0]?.trim().toLowerCase() === MEDIA_TYPE;
  }

  private proto(
    response: ServerResponse,
    cors: Record<string, string>,
    status: number,
    schema: Parameters<typeof toBinary>[0],
    message: Parameters<typeof toBinary>[1],
  ): void {
    const payload = Buffer.from(toBinary(schema, message));
    response.writeHead(status, {
      ...cors,
      "content-type": MEDIA_TYPE,
      "content-length": String(payload.byteLength),
    });
    response.end(payload);
  }

  private fail(
    response: ServerResponse,
    cors: Record<string, string>,
    status: number,
    code: string,
    message: string,
  ): void {
    this.proto(
      response,
      cors,
      status,
      ErrorResponseSchema,
      create(ErrorResponseSchema, { code, message }),
    );
  }

  private json(
    response: ServerResponse,
    cors: Record<string, string>,
    status: number,
    body: unknown,
  ): void {
    const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
    response.writeHead(status, {
      ...cors,
      "content-type": "application/json",
      "content-length": String(payload.byteLength),
    });
    response.end(payload);
  }
}

function header(request: CoreRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

function countHeader(request: CoreRequest, name: string): number {
  const value = request.headers[name];
  if (value === undefined) return 0;
  return Array.isArray(value) ? value.length : 1;
}

function headerList(request: CoreRequest, name: string): string[] {
  const value = request.headers[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
