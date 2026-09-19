import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { HostStatus } from "@armadra/protocol";
import {
  type HostLaunchConfig,
  nativeOrigin,
} from "../../shell-core/host/config";
import { hostErrorOf } from "../../shell-core/host/errors";
import {
  type NativeTicket,
  NativeTicketError,
  TICKET_OUTPUT_LIMIT,
  decodeTicket,
  pairArguments,
  reasonFor,
  ticketPrecondition,
  ticketShape,
} from "../../shell-core/host/ticket";
import { runCli } from "./launch";

/**
 * Minting one native session ticket for the page — the one thing the page may
 * ask the shell for (docs/design/host-native-session.md §4.4).
 *
 * The rules are in `shell-core/host/ticket.ts`; this file is only the CLI call
 * that feeds them, the same division the rest of `host/` uses. Ported from
 * the Rust shell this one replaced.
 */

/** The device label the Host records for this machine's shell. */
export function deviceName(locale: string): string {
  return locale.toLowerCase().startsWith("zh") ? "本机桌面" : "This desktop";
}

/**
 * Mints one ticket. `status` is what `ensureHost` reported; a Host without a
 * loopback listener has nowhere the ticket could be spent, and an origin no
 * shell can present has no native session to offer.
 */
export async function issueNativeTicket(
  config: HostLaunchConfig,
  status: HostStatus | null,
  name: string,
): Promise<NativeTicket> {
  const blocked = ticketPrecondition(config, status, name);
  if (blocked) throw new NativeTicketError(blocked);
  let wire: Uint8Array;
  try {
    wire = await runCli(
      config,
      pairArguments(config, name),
      TICKET_OUTPUT_LIMIT,
    );
  } catch (thrown) {
    // Whatever the CLI wrote is dropped here: stderr is the one stream that
    // could carry a credential the Host printed while refusing.
    throw new NativeTicketError(reasonFor(hostErrorOf(thrown)));
  }
  return decodeTicket(
    wire,
    status as HostStatus,
    config.browserOrigin,
    Date.now(),
  );
}

/* ------------------------- ARMADRA_CORE=ts 的取票 ------------------------- */

/** core 的私有通道，和 `core/identity/control.ts` 里那个名字是同一个。 */
export const CORE_CONTROL_SOCKET = "core-control.sock";

/** 一次取票最多等这么久；通道在同一台机器上，慢只可能是没人在听。 */
const CORE_TICKET_TIMEOUT_MS = 5_000;

/**
 * 从 TS core 的私有通道取一张票。
 *
 * `ts` 模式下壳不拉 Host，`armadra-host pair` 也就无从谈起。core 与壳在同一棵
 * 进程树里，票据走数据目录下那个 0600 的 Unix socket——文件权限就是鉴权，只有
 * 同一个操作系统用户的进程连得上（设计 D6）。
 *
 * 答的是 `armadra-host pair` 印的那个 JSON 形状，所以页面侧
 * （`HostIdentityClient.pair()`）一行不用改。
 *
 * 失败照旧只带一个稳定标记：通道不在、core 还没起来，都是 `hostUnavailable`；
 * core 拒绝签票（来源不是壳能呈现的那种）是 `originUnsupported`。
 */
export async function issueCoreTicket(options: {
  readonly dataDir: string;
  readonly origin: string;
  readonly deviceName: string;
}): Promise<NativeTicket> {
  if (!nativeOrigin(options.origin)) {
    throw new NativeTicketError("originUnsupported");
  }
  if (options.deviceName.trim() === "") {
    throw new NativeTicketError("hostUnavailable");
  }
  let answer: { status: number; body: string };
  try {
    answer = await requestOverSocket(
      join(options.dataDir, CORE_CONTROL_SOCKET),
      { origin: options.origin, deviceName: options.deviceName },
    );
  } catch (error) {
    throw new NativeTicketError(
      (error as NodeJS.ErrnoException).code === "ETIMEDOUT"
        ? "timeout"
        : "hostUnavailable",
    );
  }
  if (answer.status === 400) throw new NativeTicketError("originUnsupported");
  if (answer.status !== 200) throw new NativeTicketError("cliFailed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    throw new NativeTicketError("malformed");
  }
  return checkCoreTicket(parsed, options.origin, Date.now());
}

/**
 * 核对 core 答的东西。`decodeTicket` 核对的是 Host 的 `HostStatus`；这里没有
 * 那个对象，但该核对的东西一样：来源必须是页面自己的，票必须长得像票，过期
 * 时间必须还在前面。`hostId` 由 core 自己报，页面再拿它和 Hello 对账。
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

function requestOverSocket(
  socketPath: string,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        path: "/control/identity/ticket",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.byteLength),
        },
        timeout: CORE_TICKET_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > TICKET_OUTPUT_LIMIT) {
            response.destroy();
            reject(new Error("ticket response exceeds its limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("timeout", () => {
      const error: NodeJS.ErrnoException = new Error(
        "ticket request timed out",
      );
      error.code = "ETIMEDOUT";
      request.destroy(error);
    });
    request.on("error", reject);
    request.end(body);
  });
}
