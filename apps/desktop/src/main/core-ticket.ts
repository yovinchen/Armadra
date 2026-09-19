import { request as httpRequest } from "node:http";
import { join } from "node:path";

import {
  type NativeTicket,
  NativeTicketError,
  TICKET_OUTPUT_LIMIT,
  checkCoreTicket,
  nativeOrigin,
} from "../shell-core/ticket";

/**
 * 从 core 的私有通道取一张原生会话票——页面能向壳要的唯一一样东西。
 *
 * 规则在 `shell-core/ticket.ts`，这个文件只是那一次 HTTP 往返。core 与壳在同一
 * 棵进程树里，通道是数据目录下一个 0600 的 Unix socket，文件权限就是鉴权（设计
 * D6）。
 */

/** core 的私有通道，和 `core/identity/control.ts` 里那个名字是同一个。 */
export const CORE_CONTROL_SOCKET = "core-control.sock";

/** 一次取票最多等这么久；通道在同一台机器上，慢只可能是没人在听。 */
const CORE_TICKET_TIMEOUT_MS = 5_000;

/** core 记下的这台机器的设备名。 */
export function deviceName(locale: string): string {
  return locale.toLowerCase().startsWith("zh") ? "本机桌面" : "This desktop";
}

/**
 * 签一张票。
 *
 * 失败只带一个稳定标记：通道不在、core 还没起来，都是 `hostUnavailable`；core
 * 拒绝签票（来源不是壳能呈现的那种）是 `originUnsupported`。
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
      const error: NodeJS.ErrnoException = new Error("ticket request timed out");
      error.code = "ETIMEDOUT";
      request.destroy(error);
    });
    request.on("error", reject);
    request.end(body);
  });
}
