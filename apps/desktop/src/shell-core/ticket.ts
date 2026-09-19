/**
 * 原生会话票据的形状与拒绝理由，不含取票那个动作本身。
 *
 * 壳与 core 在同一棵进程树里、同一个操作系统用户下。core 的私有控制通道是数据
 * 目录下一个 0600 的 Unix socket——**文件权限就是鉴权**，只有同一个用户的进程连
 * 得上。壳在那条通道上换一张一次性的票，票绑定页面自己的来源和一个固定的设备名；
 * 页面再拿它在回环监听器上换一个 Bearer 会话。
 *
 * 进程、路径、参数一个字都不进页面：过去的只有票，以及没有票时的一个稳定标记。
 */

/** 一张票是几百字节；接近这个数的东西不是票。 */
export const TICKET_OUTPUT_LIMIT = 65_536;

/** 页面侧 `apps/web/src/host/native-session.ts` 逐字段收的就是这个形状。 */
export interface NativeTicket {
  readonly hostId: string;
  readonly hostInstanceId: string;
  readonly origin: string;
  /** 毫秒，十进制字符串：页面按 bigint 比。 */
  readonly expiresAtUnixMs: string;
  readonly ticket: string;
}

/**
 * 为什么签不出票。每一个值都是页面映射成自己那句话的稳定标记，不带路径、不带
 * 退出码、不带任何子进程输出。这一组名字页面已经认得（`hostNative.blocked.*`）。
 */
export type NativeTicketReason =
  /** core 的私有通道不在，或者 core 还没起来。 */
  | "hostUnavailable"
  /** 页面的来源不是壳能呈现的那种。 */
  | "originUnsupported"
  /** 通道在，但这次取票没成。 */
  | "cliFailed"
  | "timeout"
  /** 答回来的东西不是一张属于这台 core 的票。 */
  | "malformed";

export class NativeTicketError extends Error {
  readonly name = "NativeTicketError";
  constructor(readonly reason: NativeTicketReason) {
    super(`Native session ticket unavailable (${reason})`);
  }
}

/** `<32 位小写十六进制>.<43 位 base64url>`，此外什么都不是。 */
export function ticketShape(value: string): boolean {
  return /^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/.test(value);
}

/** 壳能呈现的来源：回环上的明文 HTTP，且只有 scheme、主机与端口。 */
export function nativeOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // `parsed.origin === origin` 把路径、查询串与凭据挡在外面：一个来源就是
  // scheme + 主机 + 端口，别的都不是。
  if (parsed.protocol !== "http:" || parsed.origin !== origin) return false;
  return loopbackHostname(parsed.hostname);
}

/** 回环：`localhost`、`::1`，或任何 `127.0.0.0/8`。 */
export function loopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * 核对 core 答回来的东西。
 *
 * 来源必须是页面自己的，票必须长得像票，过期时间必须还在前面。`hostId` 由 core
 * 自己报，页面再拿它和 `GET /api/identity/hello` 对账。
 */
export function checkCoreTicket(
  value: unknown,
  origin: string,
  nowUnixMs: number,
): NativeTicket {
  if (!value || typeof value !== "object") {
    throw new NativeTicketError("malformed");
  }
  const ticket = value as Record<string, unknown>;
  if (
    typeof ticket.hostId !== "string" ||
    !/^[0-9a-f]{32}$/.test(ticket.hostId) ||
    typeof ticket.hostInstanceId !== "string" ||
    !/^[0-9a-f]{32}$/.test(ticket.hostInstanceId) ||
    ticket.origin !== origin ||
    typeof ticket.ticket !== "string" ||
    !ticketShape(ticket.ticket) ||
    typeof ticket.expiresAtUnixMs !== "string" ||
    !/^\d{1,19}$/.test(ticket.expiresAtUnixMs) ||
    BigInt(ticket.expiresAtUnixMs) <= BigInt(nowUnixMs)
  ) {
    throw new NativeTicketError("malformed");
  }
  return {
    hostId: ticket.hostId,
    hostInstanceId: ticket.hostInstanceId,
    origin: ticket.origin,
    ticket: ticket.ticket,
    expiresAtUnixMs: ticket.expiresAtUnixMs,
  };
}
