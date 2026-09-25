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

/**
 * 远端还做不了的动作：明确 501 并说出是哪一项，而不是在控制端的磁盘上
 * 跑一个指向别的机器路径的命令。
 */
export function localOnly(target: ExecutionTarget, feature: string): void {
  if (isRemote(target)) {
    throw new DomainError(
      501,
      "unsupported",
      `${feature}还不能在远端执行主机上进行；切换回本机后可用`,
    );
  }
}
