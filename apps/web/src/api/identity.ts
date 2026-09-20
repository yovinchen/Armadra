import { z } from "zod";

import { fetchNativeTicket, isNativeShell } from "../host/native-session";
import { RUNTIME_URL } from "./request";

/**
 * 身份面的客户端 —— core 的 `/api/identity/*`（typescript-core D9）。
 *
 * 形状与错误信封（`{ code, message }`）写在
 * `docs/contracts/core-json-api.md` §3，所以这里不需要生成码，只需要一份 zod。
 *
 * 两条传输，选哪一条由环境决定，不由调用方决定：
 *
 *  - **桌面壳**：页面停在壳的回环 HTTP 静态服务上，core 在另一个回环端口。
 *    Cookie 按 host 不按 port 隔离，所以这条路上根本不能用 Cookie 会话；壳经
 *    preload 桥签一张两分钟的票，页面拿它换一份只在内存里的 Bearer 凭据。
 *  - **服务器壳**：页面由 core 自己托管，是一个真正的浏览器会话——HttpOnly
 *    Cookie + 双提交的 CSRF 头。配对材料从地址栏的 `#pair=<票>` 来。
 *
 * 凭据只在内存里：不写 localStorage、不进 URL、不发往本源以外的任何地方。
 */

const PREFIX = "/api/identity/";

/* --------------------------------- 形状 ---------------------------------- */

const scopeSchema = z.object({
  permission: z.string(),
  workspaceId: z.string().default(""),
  executionHostId: z.string().default(""),
});

const deviceSchema = z.object({
  deviceId: z.string(),
  principalId: z.string().default(""),
  displayName: z.string().default(""),
  role: z.string().default("owner"),
  createdAtUnixMs: z.number().default(0),
  revision: z.number().default(0),
});

/** 一份已认证的会话。密钥不在里面——原生传输的那两把在 `native` 里。 */
export const identitySessionSchema = z.object({
  hostId: z.string(),
  device: deviceSchema,
  scopes: z.array(scopeSchema).default([]),
  expiresAtUnixMs: z.number().default(0),
  csrfToken: z.string().optional(),
  native: z
    .object({ accessToken: z.string(), refreshToken: z.string() })
    .optional(),
});

export type IdentitySession = z.infer<typeof identitySessionSchema>;
export type IdentityScope = z.infer<typeof scopeSchema>;
export type IdentityDevice = z.infer<typeof deviceSchema>;

/**
 * `GET /api/identity/hello`。
 *
 * `capabilities` 是各域装配时报上来的能力名，页面据此判断一个面在不在——
 * 旧版本的沉默不是承诺，所以缺名字一律当「没有」。
 */
export const identityHelloSchema = z.object({
  protocol: z
    .object({ major: z.number(), minor: z.number() })
    .default({ major: 0, minor: 0 }),
  hostId: z.string().default(""),
  hostInstanceId: z.string().default(""),
  capabilities: z.array(z.string()).default([]),
  maxFrameBytes: z.number().default(0),
});

export type IdentityHello = z.infer<typeof identityHelloSchema>;

export const identityDevicesSchema = z.object({
  devices: z.array(
    z.object({
      deviceId: z.string(),
      principalId: z.string().default(""),
      name: z.string().default(""),
      role: z.string().default("owner"),
      epoch: z.number().default(0),
      createdAtMs: z.number().default(0),
      revokedAtMs: z.number().default(0),
    }),
  ),
  nextId: z.string().default(""),
  hasMore: z.boolean().default(false),
});

export type IdentityDevicePage = z.infer<typeof identityDevicesSchema>;

/** core 拒绝时的稳定代码与说明。 */
export class IdentityRequestError extends Error {
  readonly name = "IdentityRequestError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message || code);
  }
}

/** 传输本身没走通（离线、core 没起来）。和「core 拒绝了」是两件事。 */
export class IdentityTransportError extends Error {
  readonly name = "IdentityTransportError";
  constructor(cause?: unknown) {
    super("The identity surface could not be reached.", { cause });
  }
}

/* ------------------------------ 内存里的凭据 ------------------------------ */

/** `core/identity/http.ts` 用同一个形状校验：32 字节 base64url。 */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

let csrf = "";
let access = "";
let refresh = "";
let renewing: Promise<string> | null = null;
const listeners = new Set<() => void>();

/**
 * 会话变了（配对成功、刷新、登出）时通知一次。
 *
 * 配对之前页面上的每一次 `/api` 请求都会被拒掉，那些失败会留在 React Query
 * 的缓存里；配对成功之后不重新取一遍，用户看到的就是一个刚登录完却写着
 * 「已断开」的界面。返回退订函数。
 */
export function onIdentitySessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* 一个订阅者出错不该拖垮其它订阅者。 */
    }
  }
}

/** 记住（或作废）一枚刚拿到的 CSRF 令牌。 */
export function rememberCsrf(value: string): void {
  const next = SECRET.test(value) ? value : "";
  const changed = next !== csrf;
  csrf = next;
  renewing = null;
  if (changed) announce();
}

/** 收到 403 后作废本地这枚，下一次写请求会重新取。 */
export function forgetCsrf(): void {
  csrf = "";
  renewing = null;
}

/** 仅供测试与 `api/request.ts` 读取当前内存值。 */
export function currentCsrf(): string {
  return csrf;
}

/** 测试与登出后重置：丢掉全部内存凭据。 */
export function resetIdentityCredentials(): void {
  csrf = "";
  access = "";
  refresh = "";
  renewing = null;
}

/**
 * 取一枚可用的 CSRF 令牌。
 *
 * 刷新页面后内存里什么都没有，此时凭仍然有效的 refresh Cookie 向
 * `session/csrf` 重新取一枚（这会轮换，所以只在没有时才取）。没有会话时返回
 * 空字符串，由调用方照常发请求——被拒绝是 core 的事，前端不在这里替它判断。
 */
export async function ensureCsrf(): Promise<string> {
  if (csrf) return csrf;
  renewing ??= renewCsrf()
    .catch(() => "")
    .finally(() => {
      renewing = null;
    });
  return renewing;
}

function remember(session: IdentitySession): IdentitySession {
  if (session.native) {
    access = session.native.accessToken;
    refresh = session.native.refreshToken;
  }
  rememberCsrf(session.csrfToken ?? "");
  // CSRF 没变（例如原生传输上两次都是空）时也要announce一次：换了会话。
  if (session.csrfToken === undefined || !SECRET.test(session.csrfToken))
    announce();
  return session;
}

/* --------------------------------- 传输 ---------------------------------- */

interface CallOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** 用刷新密钥而不是访问密钥当 Bearer：刷新 / 换 CSRF / 登出三条。 */
  readonly refreshBearer?: boolean;
  /** 不需要会话的那两条：hello 与配对。 */
  readonly anonymous?: boolean;
}

async function call<T>(
  action: string,
  schema: z.ZodType<T>,
  options: CallOptions = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const native = isNativeShell();
  const bearer = options.refreshBearer ? refresh : access;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (native && !options.anonymous && bearer)
    headers.Authorization = `Bearer ${bearer}`;
  if (!native && method !== "GET" && csrf) headers["X-Armadra-CSRF"] = csrf;

  let response: Response;
  try {
    response = await fetch(`${RUNTIME_URL}${PREFIX}${action}`, {
      method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      // 原生传输上没有 Cookie，带凭据只会让 CORS 更严而毫无所得。
      credentials: native ? "omit" : "include",
      redirect: "error",
      cache: "no-store",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    throw new IdentityTransportError(cause);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body = (payload ?? {}) as { code?: unknown; message?: unknown };
    throw new IdentityRequestError(
      response.status,
      typeof body.code === "string" ? body.code : "UNKNOWN",
      typeof body.message === "string" ? body.message : "",
    );
  }
  return schema.parse(payload);
}

/* --------------------------------- 动作 ---------------------------------- */

/** core 在 hello 里报的两个会话能力名。 */
export const NATIVE_SESSION_CAPABILITY = "identity.native-session.v1";
export const BROWSER_SESSION_CAPABILITY = "identity.browser-session.v1";

/** 这个环境要求 hello 报的会话能力名。 */
export function sessionCapability(): string {
  return isNativeShell()
    ? NATIVE_SESSION_CAPABILITY
    : BROWSER_SESSION_CAPABILITY;
}

/** hello 报没报当前环境能用的会话能力。 */
export function hasSessionCapability(hello: IdentityHello): boolean {
  return hello.capabilities.includes(sessionCapability());
}

/** `GET hello` —— 这个 core 是谁、这一轮进程是哪一次、它装了哪些面。 */
export function identityHello(signal?: AbortSignal): Promise<IdentityHello> {
  return call("hello", identityHelloSchema, {
    anonymous: true,
    ...(signal ? { signal } : {}),
  });
}

/**
 * 用一张配对票换一个会话。
 *
 * 票在桌面壳里由 preload 桥签发（壳与 core 同一棵进程树），在服务器壳里由
 * 运维从 `armadra-server` 打印的 `…/#pair=<票>` 里带来。票原样送出，不进日志、
 * 不进存储。
 */
export async function pairIdentity(ticket: string): Promise<IdentitySession> {
  return remember(
    await call("pair", identitySessionSchema, {
      method: "POST",
      body: { ticket },
      anonymous: true,
    }),
  );
}

/**
 * 这条会话还在不在。
 *
 * 桌面壳里内存中没有 Bearer 就先取一张票换一份——壳里「已经登录」是常态，
 * 让用户手动贴票是把一个进程内的事实推给人做。没有会话返回 `null`。
 */
export async function resumeIdentity(): Promise<IdentitySession | null> {
  if (isNativeShell() && !access)
    return pairIdentity(await fetchNativeTicket());
  try {
    return await call("session", identitySessionSchema);
  } catch (error) {
    if (
      error instanceof IdentityRequestError &&
      (error.status === 401 || error.status === 403)
    ) {
      // 会话过期时刷新密钥可能还在：换一份再说「没登录」。
      const refreshed = await refreshIdentity().catch(() => null);
      if (refreshed) return refreshed;
      if (isNativeShell()) {
        // 桌面壳里「登录」是进程内的事实：访问密钥过了 15 分钟、刷新密钥也
        // 到期时，向壳再要一张票重新配对，而不是让面板停在「已断开」等人
        // 重载页面。
        resetIdentityCredentials();
        return pairIdentity(await fetchNativeTicket());
      }
      return null;
    }
    throw error;
  }
}

/** 轮转访问密钥。 */
export async function refreshIdentity(): Promise<IdentitySession> {
  return remember(
    await call("session/refresh", identitySessionSchema, {
      method: "POST",
      refreshBearer: true,
    }),
  );
}

/** 只换一枚 CSRF 令牌（刷新页面之后内存是空的，但 refresh Cookie 还在）。 */
export async function renewCsrf(): Promise<string> {
  const answer = await call(
    "session/csrf",
    z.object({ csrfToken: z.string() }),
    { method: "POST", refreshBearer: true },
  );
  rememberCsrf(answer.csrfToken);
  return currentCsrf();
}

/** 结束这条会话。 */
export async function logoutIdentity(): Promise<void> {
  try {
    await call("session/logout", z.object({ closed: z.boolean() }), {
      method: "POST",
      refreshBearer: true,
    });
  } finally {
    resetIdentityCredentials();
    announce();
  }
}

/** 这个 principal 配过的设备，按 id 分页。 */
export function listIdentityDevices(
  afterId = "",
  limit = 50,
): Promise<IdentityDevicePage> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (afterId) query.set("afterId", afterId);
  return call(`devices?${query.toString()}`, identityDevicesSchema);
}

/**
 * 撤销一台设备。
 *
 * `expectedRevision` 是读到那一行时的 epoch：两台设备同时撤销同一台是两个
 * 决定，输的那个要知道自己输了，而不是把一次已经发生的撤销再执行一遍。
 */
export async function revokeIdentityDevice(
  deviceId: string,
  expectedRevision: number,
): Promise<void> {
  await call("devices/revoke", z.object({ revoked: z.boolean() }), {
    method: "POST",
    body: { deviceId, expectedRevision },
  });
}

/** 一条授权覆不覆盖这次动作。空的 `workspaceId` 表示「整台机器」。 */
export function permits(
  session: IdentitySession,
  permission: string,
  options: { workspaceId?: string; hostId?: string } = {},
): boolean {
  return session.scopes.some(
    (scope) =>
      scope.permission === permission &&
      (options.workspaceId === undefined
        ? !scope.workspaceId
        : !scope.workspaceId || scope.workspaceId === options.workspaceId) &&
      (!scope.executionHostId ||
        options.hostId === undefined ||
        scope.executionHostId === options.hostId),
  );
}

/**
 * 地址栏里带来的配对票（服务器壳，R6a）。
 *
 * `armadra-server` 启动时打印 `https://…/#pair=<票>`。片段不会发给服务端，也
 * 不进浏览器历史里的查询串，所以票只在这张页面的内存里走一趟；读完立刻把
 * 片段从地址栏抹掉，免得它留在分享出去的链接里。
 */
export function takePairingTicket(): string {
  const location = globalThis.location;
  const hash = location?.hash ?? "";
  const found = /^#pair=([A-Za-z0-9._~-]+)$/.exec(hash);
  if (!found) return "";
  try {
    globalThis.history?.replaceState(
      null,
      "",
      `${location.pathname}${location.search}`,
    );
  } catch {
    /* 抹不掉地址栏不该让配对失败。 */
  }
  return found[1] as string;
}
