import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { type ListenSpec, bind, release } from "../listen";
import { IdentityError, identityFailure } from "./errors";
import { nativeOrigin } from "./origin";
import { allScopes } from "./scopes";
import type { IdentityService } from "./service";
import { validName } from "./tokens";

/**
 * 私有控制通道：签票的那一头。
 *
 * 签一张一次性票是**特权操作**——谁拿到票谁就能换一个全权会话。所以它不在公开
 * 的那个监听上，而在数据目录下一个 0600 的 Unix socket 上：文件权限就是鉴权，
 * 只有同一个操作系统用户的进程连得上，网络上没有这个地址。
 *
 * 桌面壳因此不再 spawn `armadra-host pair`：壳和 core 在同一棵进程树里，票据经
 * 这条通道直接取（设计 D6）。壳仍然是唯一能取票的一方，页面只能向壳要。
 *
 * 一个方法，`POST /control/identity/ticket`，请求体 `{ origin, deviceName }`，
 * 答 `armadra-host pair` 印的那个 JSON 形状——`HostIdentityClient.pair()` 原样
 * 收得下，所以前端一行不用改。
 *
 * TODO(R6)：Windows 上换成命名管道，并带上受保护的 DACL 与逐连接的客户端 SID
 * 核对；`node:net` 建出来的普通管道实例达不到这条通道要求的隔离，所以在
 * Windows 上这条通道不开；壳在那里走另一条取票路径。
 */

export const CONTROL_SOCKET = "core-control.sock";
export const TICKET_PATH = "/control/identity/ticket";

/** 请求体本身就是几十个字节；超过这个数的不是一次取票。 */
const MAX_CONTROL_BODY = 8192;

export function controlSocketPath(dataDir: string): string {
  return join(dataDir, CONTROL_SOCKET);
}

export interface ControlChannel {
  readonly spec: ListenSpec;
  close(): Promise<void>;
}

export interface ControlOptions {
  readonly service: IdentityService;
  readonly instanceId: string;
  readonly dataDir: string;
  readonly log?: { warn(message: string, fields?: unknown): void };
}

export async function startControlChannel(
  options: ControlOptions,
): Promise<ControlChannel | undefined> {
  if (process.platform === "win32") {
    options.log?.warn("身份私有通道在 Windows 上尚未实现（R6），本次不开");
    return undefined;
  }
  const server: Server = createServer((request, response) => {
    void handle(options, request, response);
  });
  const spec = await bind(server, {
    kind: "unix",
    path: controlSocketPath(options.dataDir),
  });
  return {
    spec,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          release(spec);
          resolve();
        });
      }),
  };
}

async function handle(
  options: ControlOptions,
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
): Promise<void> {
  const answer = (status: number, body: unknown): void => {
    const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": String(payload.byteLength),
    });
    response.end(payload);
  };
  const path = new URL(request.url ?? "/", "http://control").pathname;
  if (path !== TICKET_PATH) {
    answer(404, { code: "not_found", message: `没有这个接口：${path}` });
    return;
  }
  if (request.method !== "POST") {
    answer(405, { code: "method_not_allowed", message: "只接受 POST" });
    return;
  }
  let body: Buffer;
  try {
    body = await read(request, MAX_CONTROL_BODY);
  } catch (error) {
    answer(413, {
      code: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  try {
    const input = JSON.parse(body.toString("utf8") || "null") as {
      origin?: unknown;
      deviceName?: unknown;
    } | null;
    if (
      !input ||
      typeof input.origin !== "string" ||
      typeof input.deviceName !== "string" ||
      !validName(input.deviceName) ||
      // 这条通道只给桌面壳签票，壳的来源永远是回环明文 HTTP。别的来源（比如
      // R6 的服务器壳要给手机配对的那种）走的是另一条路，不是这里。
      !nativeOrigin(input.origin)
    ) {
      throw new IdentityError("invalid");
    }
    const hostId = options.service.hostId();
    const ticket = options.service.issueBootstrap({
      hostId,
      instanceId: options.instanceId,
      origin: input.origin,
      deviceName: input.deviceName,
      // 壳配对的是本机自己，拿全套授权。空授权不会悄悄扩张成全权，得写出来。
      scopes: allScopes(),
    });
    // `armadra-host pair --output protobuf` 解码后的那个形状，逐字对齐：毫秒是
    // 十进制字符串，因为页面拿 bigint 比较它。
    answer(200, {
      hostId,
      hostInstanceId: options.instanceId,
      origin: input.origin,
      ticket: ticket.ticket,
      expiresAtUnixMs: String(ticket.expiresAtMs),
    });
  } catch (error) {
    const failure = identityFailure(
      error instanceof SyntaxError ? new IdentityError("invalid") : error,
    );
    answer(failure.status, {
      code: failure.code,
      message: failure.message,
    });
  }
}

function read(
  request: import("node:http").IncomingMessage,
  limit: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        request.destroy();
        reject(new Error(`请求体超过 ${limit} 字节上限`));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
