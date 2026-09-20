/**
 * 页面所在的壳，以及在桌面壳里怎么拿到一张配对票（typescript-core §4.3）。
 *
 * 两种壳，两条认证路径：
 *
 *  - **桌面壳**：页面由壳的回环 HTTP 静态服务提供，core 在另一个回环端口。
 *    Cookie 按 host 不按 port 隔离（`127.0.0.1:A` 的 Cookie 会发往同 profile
 *    的任何 `127.0.0.1:B`），所以这条路上不能用 Cookie 会话。壳经 preload 桥
 *    签一张两分钟的票，页面拿它换一份只在内存里的 Bearer 凭据。壳的静态服务
 *    端口由内核分配，所以「在壳里」不可能是一个常量判断。
 *  - **服务器壳**：页面由 core 自己托管在一个 HTTPS 来源上，是一个真正的
 *    浏览器会话——HttpOnly Cookie + 双提交的 CSRF 头，配对材料从 `#pair=` 来。
 *
 * 判定只在这一处做，所以「壳内要不要自动登录」也只有一个答案。
 */

/**
 * 壳取票失败的原因。前五个是壳报的稳定标记，
 * `shellUnavailable` 是页面这边的：不在壳里、通道不存在或返回了认不出的东西。
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
    super(`Desktop shell could not issue a session ticket (${reason}).`);
  }
}

/** 壳返回的票据：和 core 私有控制通道签出来的那份 JSON 同一个形状。 */
export interface NativeTicket {
  hostId: string;
  hostInstanceId: string;
  origin: string;
  ticket: string;
  expiresAtUnixMs: string;
}

/**
 * 页面来源，按 core 在 `Origin` 头里看到的拼法。`URL.origin` 对非特殊 scheme
 * 是 `"null"`，所以在那种情况下从 protocol 和 host 拼。
 */
export function pageOrigin(): string | undefined {
  const location = globalThis.location;
  if (!location) return undefined;
  if (location.origin && location.origin !== "null") return location.origin;
  if (location.protocol && location.host)
    return `${location.protocol}//${location.host}`;
  return undefined;
}

function loopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * 壳能呈现的那种来源：回环上的明文 HTTP。
 *
 * 这是**拼法判断，不是授权**——浏览器也可以停在一个回环 HTTP 来源上，它只是
 * 造不出票，因为票只有同用户的私有通道签得出来。core 的
 * `identity/origin.ts::nativeOrigin` 是同一条规则的服务端一半。
 */
export function isNativePageOrigin(value: string | undefined): boolean {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  if (url.pathname !== "" && url.pathname !== "/") return false;
  return loopbackHost(url.hostname.toLowerCase());
}

/** 壳的取票桥；不在壳里是 `undefined`。 */
function ticketBridge(): { ticket(): Promise<unknown> } | undefined {
  const identity = globalThis.window?.armadra?.identity;
  return typeof identity?.ticket === "function" ? identity : undefined;
}

/**
 * 这份页面是不是跑在桌面壳里、并以壳能呈现的来源加载。
 *
 * 两个条件都要：光有来源不够（浏览器也可以停在一个回环 HTTP 来源上，它只是
 * 拿不到票），光有壳也不够（壳的开发模式可能把页面指向别处）。
 */
export function isNativeShell(): boolean {
  return ticketBridge() !== undefined && isNativePageOrigin(pageOrigin());
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
 * 向壳要一张一次性票据。
 *
 * 通道是 `window.armadra.identity.ticket()`，拒绝是返回值里的
 * `{ ok: false, error: { code } }`——Electron 会把 `handle` 的拒绝压成一句话，
 * 结构留不下来，所以拒绝走返回值而不是异常。
 *
 * 认不出的东西一律 `shellUnavailable`。票据不进日志、不进存储。
 *
 * 交出去的是**信封里那个票本身**，不是信封。`POST /api/identity/pair` 的
 * `ticket` 是 `<id>.<secret>` 那个字符串（core 那边 `parseToken` 就按这个拆），
 * 服务器壳从 `#pair=<票>` 带来的也是同一种东西。把整个信封 JSON 塞进去会在
 * `parseToken` 那一步就落空，配对永远 401——于是桌面壳上一台设备都配不出来，
 * 自动化面板显示「连不上 Host」、GitHub 面板打不开，两张 JSON 面的本机主人
 * 判定也答 `unauthenticated`。信封的其余字段（host、instance、origin、有效期）
 * 在壳里由 `checkCoreTicket` 核过，不需要再送一遍。
 */
export async function fetchNativeTicket(): Promise<string> {
  const bridge = isNativeShell() ? ticketBridge() : undefined;
  if (!bridge) throw new HostNativeSessionError("shellUnavailable");
  const ticket = await ticketFromBridge(bridge);
  if (!validTicket(ticket)) throw new HostNativeSessionError("malformed");
  return ticket.ticket;
}

async function ticketFromBridge(bridge: {
  ticket(): Promise<unknown>;
}): Promise<unknown> {
  let answer: unknown;
  try {
    answer = await bridge.ticket();
  } catch {
    throw new HostNativeSessionError("shellUnavailable");
  }
  if (!answer || typeof answer !== "object")
    throw new HostNativeSessionError("shellUnavailable");
  const result = answer as {
    ok?: unknown;
    ticket?: unknown;
    error?: { code?: unknown };
  };
  if (result.ok === true) return result.ticket;
  const code = result.error?.code;
  throw new HostNativeSessionError(isFailure(code) ? code : "shellUnavailable");
}

/** 壳取票失败对应的文案键；不是壳的失败返回 `null`。 */
export function nativeSessionFailureKey(error: unknown): string | null {
  return error instanceof HostNativeSessionError
    ? `hostNative.blocked.${error.reason}`
    : null;
}
