import {
  HostIdentityClient,
  HostNativeCredentials,
  isNativePageOrigin,
  type HelloResponse,
  type HostIdentityClientOptions,
} from "@armadra/host-client";

import { isTauri } from "../platform";

/**
 * 页面拿 Host 会话的共用判定（桌面壳原生 Host 会话 §4.3）。
 *
 * 浏览器里的规则不变：Host 地址必须是 HTTPS 且与页面同源，会话走 Cookie。
 * 打包桌面壳（`isTauri()` 且页面来源是 `tauri://localhost` 或
 * `http(s)://tauri.localhost`）里那条规则永远满足不了，改走原生传输：回环
 * HTTP 的 Host、`Authorization: Bearer`、凭据只在页面内存里；票据由壳经
 * OS 私有控制通道取得，页面只调用一个只读命令 `host_native_ticket`。
 *
 * 九个需要会话的模块都从这里拿判定、能力名和客户端，所以「壳内要不要
 * 自动登录」只在这一处决定。
 */

/** Host 配好 HTTPS 认证时在 Hello 里报的能力名。 */
export const BROWSER_SESSION_CAPABILITY = "identity.browser-session.v1";
/** Host 在回环 HTTP 上对被允许的原生来源报的能力名。 */
export const NATIVE_SESSION_CAPABILITY = "identity.native-session.v1";

/** 地址本身就用不了会话传输的两种原因；文案由各模块的 `*.blocked.*` 给。 */
export type HostSessionBlock = "tlsRequired" | "sameOrigin";

/**
 * 壳取票失败的原因。前五个是壳（Rust）报的稳定标记，`shellUnavailable`
 * 是页面这边的：不在壳里、命令不存在或返回了认不出的东西。
 */
export const NATIVE_SESSION_FAILURES = [
  "hostUnavailable",
  "originUnsupported",
  "cliFailed",
  "timeout",
  "malformed",
  "shellUnavailable",
] as const;
export type NativeSessionFailure = (typeof NATIVE_SESSION_FAILURES)[number];

export class HostNativeSessionError extends Error {
  readonly name = "HostNativeSessionError";
  constructor(readonly reason: NativeSessionFailure) {
    super(`Desktop shell could not issue a Host session ticket (${reason}).`);
  }
}

/** 壳返回的票据：和 `armadra-host pair` 的 JSON 同一个形状。 */
export interface NativeTicket {
  hostId: string;
  hostInstanceId: string;
  origin: string;
  ticket: string;
  expiresAtUnixMs: string;
}

/**
 * 页面来源，按 Host 在 `Origin` 头里看到的拼法。`URL.origin` 对 `tauri:`
 * 这种非特殊 scheme 是 `"null"`，所以从 protocol 和 host 拼。
 */
export function pageOrigin(): string | undefined {
  const location = globalThis.location;
  if (!location) return undefined;
  if (location.origin && location.origin !== "null") return location.origin;
  if (location.protocol && location.host)
    return `${location.protocol}//${location.host}`;
  return undefined;
}

/** 这份页面是不是跑在打包桌面壳里、并以壳的原生来源加载。 */
export function isNativeShell(): boolean {
  return isTauri() && isNativePageOrigin(pageOrigin());
}

function loopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/** 这个 Host 地址能不能承载会话传输；`null` 表示可以。 */
export function hostSessionBlock(address: string): HostSessionBlock | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "tlsRequired";
  }
  if (isNativeShell()) {
    if (url.protocol === "http:" && loopbackHost(url.hostname)) return null;
    // 壳里配了一个远端地址：HTTPS 同源在 tauri:// 页面上不可能成立，
    // 明说而不是假装能登录。
    return url.protocol === "https:" ? "sameOrigin" : "tlsRequired";
  }
  if (url.protocol !== "https:") return "tlsRequired";
  if (url.origin !== globalThis.location?.origin) return "sameOrigin";
  return null;
}

/** 当前环境要求 Hello 报的会话能力名。 */
export function hostSessionCapability(): string {
  return isNativeShell()
    ? NATIVE_SESSION_CAPABILITY
    : BROWSER_SESSION_CAPABILITY;
}

/** Hello 报没报当前环境能用的会话能力。 */
export function hasHostSessionCapability(hello: HelloResponse): boolean {
  return hello.capabilities.includes(hostSessionCapability());
}

let credentials: HostNativeCredentials | null = null;

/**
 * 壳内所有身份客户端共用的一份原生凭据。共用是关键：每个客户端各配一次
 * 对，Host 上就会多出九台「本机桌面」，而且各自的轮转会互相作废。
 */
export function nativeCredentials(): HostNativeCredentials {
  credentials ??= new HostNativeCredentials({ ticket: fetchNativeTicket });
  return credentials;
}

/** 测试与登出后重置：丢掉这份凭据，下一次会重新取票。 */
export function resetNativeSession(): void {
  credentials = null;
}

/**
 * 按环境构造身份客户端：浏览器走 Cookie，壳内走共享的原生凭据。
 * 构造失败（地址不合规）照旧抛 `HostIdentityError`，由调用方映射。
 */
export function createHostIdentity(
  options: Omit<HostIdentityClientOptions, "transport" | "pageOrigin">,
): HostIdentityClient {
  if (!isNativeShell()) return new HostIdentityClient(options);
  return new HostIdentityClient({
    ...options,
    pageOrigin: pageOrigin(),
    transport: { kind: "native", credentials: nativeCredentials() },
  });
}

function isFailure(value: unknown): value is NativeSessionFailure {
  return (
    typeof value === "string" &&
    (NATIVE_SESSION_FAILURES as readonly string[]).includes(value)
  );
}

function validTicket(value: unknown): value is NativeTicket {
  if (!value || typeof value !== "object") return false;
  const ticket = value as Record<string, unknown>;
  return (
    typeof ticket.hostId === "string" &&
    typeof ticket.hostInstanceId === "string" &&
    typeof ticket.origin === "string" &&
    typeof ticket.ticket === "string" &&
    typeof ticket.expiresAtUnixMs === "string" &&
    /^\d{1,19}$/.test(ticket.expiresAtUnixMs)
  );
}

/**
 * 向壳要一张一次性票据。壳只暴露这一个只读命令；它失败时带回一个稳定的
 * `reason`，映射成 {@link HostNativeSessionError}，其它任何异常都算
 * `shellUnavailable`。票据不进日志、不进存储，原样交给 `pair()`。
 */
export async function fetchNativeTicket(): Promise<string> {
  if (!isNativeShell()) throw new HostNativeSessionError("shellUnavailable");
  let invoke: typeof import("@tauri-apps/api/core").invoke;
  try {
    ({ invoke } = await import("@tauri-apps/api/core"));
  } catch {
    throw new HostNativeSessionError("shellUnavailable");
  }
  let ticket: unknown;
  try {
    ticket = await invoke("host_native_ticket");
  } catch (cause) {
    const reason =
      cause && typeof cause === "object"
        ? (cause as { reason?: unknown }).reason
        : undefined;
    throw new HostNativeSessionError(
      isFailure(reason) ? reason : "shellUnavailable",
    );
  }
  if (!validTicket(ticket)) throw new HostNativeSessionError("malformed");
  return JSON.stringify(ticket);
}

/** 壳取票失败对应的文案键；不是壳的失败返回 `null`。 */
export function nativeSessionFailureKey(error: unknown): string | null {
  return error instanceof HostNativeSessionError
    ? `hostNative.blocked.${error.reason}`
    : null;
}
