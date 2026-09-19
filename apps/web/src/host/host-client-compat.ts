import {
  HostClient,
  HostIdentityClient,
  HostNativeCredentials,
  isNativePageOrigin,
  type HelloResponse,
  type HostIdentityClientOptions,
} from "@armadra/host-client";

import { fetchNativeTicket, isNativeShell, pageOrigin } from "./native-session";

/**
 * 还没改打 JSON 面的那两个面（GitHub、自动化）用的旧接线。
 *
 * R7c 把身份、会话、事件流、更新与设置全部移到 `api/identity.ts` 与
 * `api/` 下的 JSON 客户端；`packages/host-client` 在页面里只剩这两个消费者，
 * 它们由并行的一条线改造。这个文件是那两条路径的全部依赖面，所以它们落地
 * 之后整文件删除，`packages/host-client` 随之退出前端。
 *
 * 这里不新增任何判断——地址、来源与会话能力的规则和以前逐字一致。
 */

export const DEFAULT_HOST_ADDRESS = "http://127.0.0.1:43121";
export const HOST_ADDRESS_STORAGE_KEY = "armadra.host-check.address.v1";
const CLIENT_ID = "armadra-web-host-check";

/** Host 配好 HTTPS 认证时在 Hello 里报的能力名。 */
export const BROWSER_SESSION_CAPABILITY = "identity.browser-session.v1";
/** Host 在回环 HTTP 上对被允许的原生来源报的能力名。 */
export const NATIVE_SESSION_CAPABILITY = "identity.native-session.v1";

/** 地址本身就用不了会话传输的两种原因。 */
export type HostSessionBlock = "tlsRequired" | "sameOrigin";

export type HostProbe = (
  address: string,
  signal: AbortSignal,
) => Promise<HelloResponse>;

export const probeHost: HostProbe = (address, signal) =>
  new HostClient({ baseUrl: address, clientId: CLIENT_ID }).hello({ signal });

function validateAddress(address: string): void {
  // Construction validates configuration without making any request.
  new HostClient({ baseUrl: address, clientId: CLIENT_ID });
}

export function loadHostAddress(): string {
  try {
    const stored = localStorage.getItem(HOST_ADDRESS_STORAGE_KEY);
    if (stored) {
      try {
        validateAddress(stored);
        return stored;
      } catch {
        localStorage.removeItem(HOST_ADDRESS_STORAGE_KEY);
      }
    }
  } catch {
    /* Browser storage may be disabled. */
  }
  return DEFAULT_HOST_ADDRESS;
}

export function rememberHostAddress(address: string): void {
  validateAddress(address);
  try {
    localStorage.setItem(HOST_ADDRESS_STORAGE_KEY, address);
  } catch {
    /* A failed preference write must not block the connection check. */
  }
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
    // 壳里配了一个远端地址：页面自己停在回环 HTTP 来源上，HTTPS 同源不可能
    // 成立，明说而不是假装能登录。
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
 * 壳内所有身份客户端共用的一份原生凭据。共用是关键：每个客户端各配一次对，
 * Host 上就会多出好几台「本机桌面」，而且各自的轮转会互相作废。
 */
export function nativeCredentials(): HostNativeCredentials {
  credentials ??= new HostNativeCredentials({ ticket: fetchNativeTicket });
  return credentials;
}

/** 测试与登出后重置：丢掉这份凭据，下一次会重新取票。 */
export function resetNativeSession(): void {
  credentials = null;
}

/** 按环境构造身份客户端：浏览器走 Cookie，壳内走共享的原生凭据。 */
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

export { isNativePageOrigin };
