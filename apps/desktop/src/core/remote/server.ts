/**
 * 远端那一侧：`armadra-core worker --stdio`。
 *
 * 控制端经 `ssh` 起这个进程，stdin / stdout 就是整条连接（为什么不用隧道到
 * 远端 core 的 HTTP，见 {@link ./frames}）。它不开数据库、不监听任何端口、
 * 不写端点文件：它只是「在这台机器上替控制端执行操作」的一段代码，stdin
 * 关闭就退出，所以连接断了不会留下孤儿进程。
 *
 * 帧的顺序：
 *
 *  1. 进程起来后先**主动**发一帧握手（`requestId = "hello"`），控制端据此判断
 *     协议、服务契约与能力（{@link ./handshake}）；
 *  2. 此后每个请求帧按 `action` 查 {@link OPERATIONS} 执行，答复带回同一个
 *     `requestId` 与本进程的 `instanceId`；
 *  3. 请求之间互不等待——Git 写入的串行由 Worker 自己的仓库队列保证，与控制端
 *     本机的规则相同。
 *
 * stdout 只写帧。任何诊断只能写 stderr：多出一个字节，控制端的解码器就会把整条
 * 流判为坏流并断开。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { RepositoryService } from "../git/repository/service";
import { VERSION } from "../instance";
import { DomainError } from "../workspaces/support";
import {
  FrameDecoder,
  HELLO_ID,
  MAX_FRAME,
  type WorkerRequest,
  type WorkerResponse,
  encodeFrame,
} from "./frames";
import {
  CONTRACT_VERSION,
  PROTOCOL_MAJOR,
  REMOTE_CAPABILITY,
  type WorkerHello,
} from "./handshake";
import { LANGUAGE_CAPABILITY, LANGUAGE_OPERATIONS } from "./language";
import {
  FILES_CAPABILITY,
  GIT_CAPABILITY,
  GIT_OPERATIONS_CAPABILITY,
  OPERATIONS,
  RESOURCES_CAPABILITY,
  WATCH_CAPABILITY,
  type Operation,
  type OperationContext,
} from "./operations";
import { WorkerSession } from "./session";

/** 这个构建的 Worker（控制连接）声明的能力。 */
export const WORKER_CAPABILITIES: readonly string[] = [
  REMOTE_CAPABILITY,
  FILES_CAPABILITY,
  GIT_CAPABILITY,
  GIT_OPERATIONS_CAPABILITY,
  WATCH_CAPABILITY,
  RESOURCES_CAPABILITY,
];

/** 语言连接（`--language-link`）声明的能力。 */
export const LANGUAGE_LINK_CAPABILITIES: readonly string[] = [
  REMOTE_CAPABILITY,
  LANGUAGE_CAPABILITY,
];

/** 远端的协议次版本；主版本见 {@link PROTOCOL_MAJOR}。 */
export const PROTOCOL_MINOR = 0;

/** 一个请求的载荷：在哪个根上、带什么参数。 */
export interface OperationPayload {
  readonly root: string;
  readonly args?: Record<string, unknown>;
}

export interface WorkerServerOptions {
  readonly input: Readable;
  readonly output: Writable;
  /** 测试用；缺省每个进程一个随机值。 */
  readonly instanceId?: string;
  readonly version?: string;
  /**
   * 这条连接执行哪张表、声明哪些能力。缺省是控制连接；`--language-link` 换成
   * 语言那一张（{@link ./language}）。
   */
  readonly operations?: Readonly<Record<string, Operation>>;
  readonly capabilities?: readonly string[];
}

/** 起一个 Worker 会话；返回的 Promise 在输入结束、所有在途请求答完后兑现。 */
export async function serveWorker(options: WorkerServerOptions): Promise<void> {
  const instanceId = options.instanceId ?? randomUUID().replace(/-/gu, "");
  const table = options.operations ?? OPERATIONS;
  const decoder = new FrameDecoder();
  const inFlight = new Set<Promise<void>>();

  const send = (response: WorkerResponse): void => {
    let frame = encodeFrame(response);
    if (frame.byteLength - 4 > MAX_FRAME) {
      // 不截断：截断的答复看起来像一个完整答复。说清是哪一个操作太大。
      frame = encodeFrame({
        requestId: response.requestId,
        instanceId,
        status: 413,
        error: {
          code: "resource_exhausted",
          message: "The answer is larger than one worker frame",
        },
      } satisfies WorkerResponse);
    }
    options.output.write(frame);
  };

  // 推送帧的 `requestId` 为空：控制端据此把它交给订阅方，而不是某个等答复的请求。
  const session = new WorkerSession((event) => {
    if (options.output.writableEnded || options.output.destroyed) return;
    send({ requestId: "", instanceId, status: 200, result: event });
  });
  const service = new RepositoryService();
  const context: OperationContext = {
    service,
    freshDiscovery: false,
    session,
  };
  // 连接结束时还在排队或在跑的 Git 长操作一并取消：控制端已经听不到它们的结局，
  // 让它们在没有人看的地方继续推送或改仓库，比取消更糟。
  session.slot(
    "git.shutdown",
    () => service,
    async (owned) => {
      try {
        await owned.shutdown(10_000);
      } catch {
        // 超时也要继续收尾别的东西。
      }
    },
  );

  const hello: WorkerHello = {
    protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
    instanceId,
    runtimeVersion: options.version ?? VERSION,
    serviceContractVersion: CONTRACT_VERSION,
    capabilities: [...(options.capabilities ?? WORKER_CAPABILITIES)],
    platform: process.platform,
    architecture: process.arch,
  };
  send({ requestId: HELLO_ID, instanceId, status: 200, result: hello });

  const handle = async (request: WorkerRequest): Promise<void> => {
    send(await answer(context, instanceId, request, table));
  };

  await new Promise<void>((resolve) => {
    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      void Promise.allSettled([...inFlight])
        .then(() => session.dispose())
        .then(() => resolve());
    };
    options.input.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        const request = frame as WorkerRequest;
        if (typeof request?.requestId !== "string") continue;
        const pending = handle(request).finally(() => inFlight.delete(pending));
        inFlight.add(pending);
      }
      // 读不懂的流不再往下读：继续只会把后面的字节错当成帧。
      if (decoder.broken) {
        process.stderr.write("armadra worker: unreadable frame, closing\n");
        options.input.destroy();
        finish();
      }
    });
    options.input.on("end", finish);
    options.input.on("close", finish);
    options.input.on("error", finish);
  });
}

/** 执行一个请求并组好答复帧；不抛出。 */
export async function answer(
  context: OperationContext,
  instanceId: string,
  request: WorkerRequest,
  table: Readonly<Record<string, Operation>> = OPERATIONS,
): Promise<WorkerResponse> {
  const reply = (
    status: number,
    body: { result?: unknown; error?: { code: string; message: string } },
  ): WorkerResponse => ({
    requestId: request.requestId,
    instanceId,
    status,
    ...body,
  });
  // 发给别的会话的请求不执行：那是一次重连之前的请求，执行它就是执行两遍。
  if (
    request.expectedInstanceId !== "" &&
    request.expectedInstanceId !== instanceId
  ) {
    return reply(409, {
      error: {
        code: "instance_mismatch",
        message: "The request was addressed to another worker session",
      },
    });
  }
  if (
    typeof request.deadlineUnixMs === "number" &&
    request.deadlineUnixMs > 0 &&
    Date.now() > request.deadlineUnixMs
  ) {
    return reply(504, {
      error: { code: "deadline_exceeded", message: "The request expired" },
    });
  }
  const operation = table[request.action];
  if (operation === undefined) {
    return reply(501, {
      error: {
        code: "unsupported",
        message: `This worker does not perform ${request.action}`,
      },
    });
  }
  const payload = request.payload as OperationPayload | undefined;
  if (typeof payload?.root !== "string" || !payload.root.startsWith("/")) {
    return reply(400, {
      error: {
        code: "bad_request",
        message: "A worker request names no absolute root",
      },
    });
  }
  try {
    const result = await operation.run(
      context,
      payload.root,
      payload.args ?? {},
    );
    return reply(200, { result: result ?? null });
  } catch (failure) {
    if (failure instanceof DomainError) {
      return reply(failure.status, {
        error: { code: failure.code, message: failure.message },
      });
    }
    const status =
      typeof (failure as { status?: unknown })?.status === "number"
        ? (failure as { status: number }).status
        : 500;
    const code =
      typeof (failure as { code?: unknown })?.code === "string"
        ? (failure as { code: string }).code
        : "internal_error";
    return reply(status, {
      error: {
        code,
        message: failure instanceof Error ? failure.message : String(failure),
      },
    });
  }
}

/** `worker` 子命令读到的参数。 */
export interface WorkerArguments {
  readonly stdio: boolean;
  readonly stateDir: string | undefined;
  readonly languageLink: boolean;
}

/**
 * 进程入口：`main` 看到 `worker` 子命令时调这里，而不是起 core。
 *
 * `--language-link` 起的是同一台主机上的第二个 Worker：同一套帧与握手，执行的是
 * 语言那张表，语言服务器就是它的子进程——连接一断，stdin 关闭，它们随之停掉。
 */
export async function runWorker(args: WorkerArguments): Promise<number> {
  if (!args.stdio) {
    process.stderr.write("armadra worker: only --stdio is supported\n");
    return 2;
  }
  if (args.stateDir !== undefined) {
    try {
      mkdirSync(args.stateDir, { recursive: true, mode: 0o700 });
    } catch (failure) {
      process.stderr.write(
        `armadra worker: cannot create the state directory: ${
          failure instanceof Error ? failure.message : String(failure)
        }\n`,
      );
      return 2;
    }
  }
  await serveWorker({
    input: process.stdin,
    output: process.stdout,
    ...(args.languageLink
      ? {
          operations: LANGUAGE_OPERATIONS,
          capabilities: LANGUAGE_LINK_CAPABILITIES,
        }
      : {}),
  });
  return 0;
}
