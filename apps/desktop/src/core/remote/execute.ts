/**
 * 「在这个工作空间所在的机器上执行」——路由与执行位置之间唯一的缝。
 *
 * 路由做完权限与参数解析后调 {@link executeOn}。执行主机为空时就在本进程里查
 * {@link OPERATIONS} 执行；否则经远端域把同一个操作名发给那台主机上的 Worker。
 * 远端工作空间**绝不**回退到本机：远端域没装配、主机不在配置里、Worker 不可达，
 * 都是明确的错误，而不是悄悄读控制端磁盘上同名的路径。
 */

import { RepositoryService } from "../git/repository/service";
import { DomainError } from "../workspaces/support";
import { OPERATIONS, type OperationContext } from "./operations";
import type { OperationPayload } from "./server";
import { RemoteError } from "./worker";

/** 把一个操作发给某台执行主机上的 Worker。 */
export type RemoteCaller = (
  hostId: string,
  operation: string,
  payload: OperationPayload,
  replay: boolean,
) => Promise<unknown>;

let caller: RemoteCaller | undefined;

/**
 * 远端域装配时登记自己；测试用它把一个本地子进程里的真 Worker 接上来。
 * 返回之前那一个，便于测试还原。
 */
export function setRemoteCaller(
  next: RemoteCaller | undefined,
): RemoteCaller | undefined {
  const previous = caller;
  caller = next;
  return previous;
}

let fallback: OperationContext | undefined;

/** 文件操作用不到 Git 服务；给它们一个共享的，免得每次新建。 */
function defaultContext(): OperationContext {
  fallback ??= { service: new RepositoryService(), freshDiscovery: true };
  return fallback;
}

export interface ExecutionTarget {
  readonly rootPath: string;
  readonly executionHostId?: string | undefined;
}

export function isRemote(target: ExecutionTarget): boolean {
  return (target.executionHostId ?? "") !== "";
}

/** 在 `target` 所在的机器上执行 `operation`。 */
export async function executeOn(
  target: ExecutionTarget,
  operation: string,
  args: Record<string, unknown> = {},
  local: OperationContext = defaultContext(),
): Promise<unknown> {
  const entry = OPERATIONS[operation];
  if (entry === undefined) {
    throw new DomainError(
      500,
      "internal_error",
      `Unknown operation ${operation}`,
    );
  }
  const hostId = target.executionHostId ?? "";
  if (hostId === "") return await entry.run(local, target.rootPath, args);
  return await executeRemote(hostId, operation, target.rootPath, args);
}

/** 在指定执行主机上执行；用于还没有工作空间行的场合（建远端工作空间、切换）。 */
export async function executeRemote(
  hostId: string,
  operation: string,
  root: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const entry = OPERATIONS[operation];
  if (entry === undefined) {
    throw new DomainError(
      500,
      "internal_error",
      `Unknown operation ${operation}`,
    );
  }
  if (caller === undefined) {
    throw new DomainError(
      501,
      "unsupported",
      "这个 core 没有装配远端执行，远端工作空间不能在这里打开",
    );
  }
  try {
    return await caller(hostId, operation, { root, args }, entry.replay);
  } catch (failure) {
    if (failure instanceof RemoteError) {
      throw new DomainError(failure.status, failure.code, failure.message);
    }
    throw failure;
  }
}

/* ------------------------------ 推送与连接事件 ------------------------------ */

/**
 * 一台执行主机上的哪一条连接：`control` 是文件 / Git / 资源那条，`language` 是
 * 承载语言服务的第二条（`worker --stdio --language-link`）。
 */
export type RemoteChannel = "control" | "language";

export interface RemotePushEvent {
  readonly type: string;
  readonly [field: string]: unknown;
}

/** Worker 推来的一帧，或连接的起落。各域按需订阅，互不知道对方。 */
export interface RemoteListener {
  event?(hostId: string, channel: RemoteChannel, event: RemotePushEvent): void;
  /** 握手成功、连接可用。重连之后要重新登记的东西在这里重登。 */
  connected?(hostId: string, channel: RemoteChannel): void;
  /** 连接没了。那边的 Worker 随 stdin 关闭退出，它持有的状态一并消失。 */
  disconnected?(hostId: string, channel: RemoteChannel): void;
}

const listeners = new Set<RemoteListener>();

/** 订阅；返回退订。 */
export function listenRemote(listener: RemoteListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function each(visit: (listener: RemoteListener) => void): void {
  for (const listener of [...listeners]) {
    try {
      visit(listener);
    } catch {
      // 一个域处理失败不该让别的域收不到同一帧。
    }
  }
}

/** 远端域（或测试）收到一帧推送时调。 */
export function remotePushed(
  hostId: string,
  channel: RemoteChannel,
  event: unknown,
): void {
  if (typeof event !== "object" || event === null) return;
  const typed = event as RemotePushEvent;
  if (typeof typed.type !== "string") return;
  each((listener) => listener.event?.(hostId, channel, typed));
}

export function remoteConnected(hostId: string, channel: RemoteChannel): void {
  each((listener) => listener.connected?.(hostId, channel));
}

export function remoteDisconnected(
  hostId: string,
  channel: RemoteChannel,
): void {
  each((listener) => listener.disconnected?.(hostId, channel));
}
