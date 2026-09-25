/**
 * 远端 Git 长操作：控制端这一侧的镜像。
 *
 * 队列在执行主机的 Worker 里（与本机同一段 `startOperation`，同一把仓库锁）。
 * 控制端记三件事：
 *
 *  * **归属**：哪个工作空间发起了哪个操作——与本机一样是控制端的事实，路由用
 *    它拒绝别的工作空间查询或继续这个操作；
 *  * **镜像**：Worker 推来的 `git.operation` 帧就是最新快照，`GET …/{id}` 直接答
 *    它，不必每次轮询都往返一次；
 *  * **断线的结局**：Worker 随连接退出，排队中的操作从没开始，记为已取消；在跑
 *    的可能已经改了仓库，记为 `unknownOutcome`——面板据此让人先去看，而不是重试。
 */

import type {
  ExpectedState,
  OperationSnapshot,
  RepositoryAction,
} from "../git/repository/types";
import { isTerminal } from "../git/repository/types";
import { DomainError } from "../workspaces/support";
import { type ExecutionTarget, executeOn, listenRemote } from "./execute";

interface Mirrored {
  readonly hostId: string;
  readonly target: ExecutionTarget;
  readonly workspaceId: string;
  snapshot: OperationSnapshot;
}

/** 镜像最多记这么多；超出时先丢最早结束的。 */
const MAX_MIRRORED = 256;

function notFound(): DomainError {
  return new DomainError(
    404,
    "not_found",
    "Git operation not found in this workspace",
  );
}

export class RemoteGitOperations {
  private readonly mirrored = new Map<string, Mirrored>();
  private readonly early = new Map<
    string,
    { hostId: string; snapshot: OperationSnapshot }
  >();
  private readonly unlisten: () => void;

  constructor() {
    this.unlisten = listenRemote({
      event: (hostId, channel, event) => {
        if (channel !== "control" || event.type !== "git.operation") return;
        const snapshot = event.snapshot as OperationSnapshot | undefined;
        if (snapshot === undefined || typeof snapshot.id !== "string") return;
        const entry = this.mirrored.get(snapshot.id);
        if (entry === undefined) {
          // 发起的答复还没处理完：先记下，`start` 收下它。
          this.early.set(snapshot.id, { hostId, snapshot });
          if (this.early.size > 64) {
            const oldest = this.early.keys().next().value;
            if (oldest !== undefined) this.early.delete(oldest);
          }
          return;
        }
        if (entry.hostId !== hostId) return;
        // 终态之后不回退：晚到的一帧进度不能把「已成功」改回「在跑」。
        if (isTerminal(entry.snapshot.state)) return;
        entry.snapshot = snapshot;
      },
      disconnected: (hostId, channel) => {
        if (channel === "control") this.lost(hostId);
      },
    });
  }

  dispose(): void {
    this.unlisten();
    this.mirrored.clear();
  }

  private lost(hostId: string): void {
    const finishedAt = new Date().toISOString();
    for (const entry of this.mirrored.values()) {
      if (entry.hostId !== hostId || isTerminal(entry.snapshot.state)) continue;
      const started = entry.snapshot.state === "running";
      entry.snapshot = {
        ...entry.snapshot,
        state: started ? "unknownOutcome" : "cancelled",
        finishedAt,
        message: started
          ? "执行主机的连接在操作进行中断开；仓库可能已经改变，请先查看再决定是否重做"
          : "执行主机的连接在操作开始之前断开，操作没有执行",
      };
    }
  }

  private prune(): void {
    if (this.mirrored.size <= MAX_MIRRORED) return;
    for (const [id, entry] of this.mirrored) {
      if (this.mirrored.size <= MAX_MIRRORED) break;
      if (isTerminal(entry.snapshot.state)) this.mirrored.delete(id);
    }
  }

  /** 在执行主机上排一个操作；答复即初始快照。 */
  async start(
    target: ExecutionTarget,
    workspaceId: string,
    args: {
      readonly path: string;
      readonly action: RepositoryAction;
      readonly expected: ExpectedState;
      readonly execute: boolean;
    },
  ): Promise<OperationSnapshot> {
    const snapshot = (await executeOn(target, "git.operationStart", {
      path: args.path,
      action: args.action,
      expected: args.expected,
      execute: args.execute,
    })) as OperationSnapshot;
    const hostId = target.executionHostId ?? "";
    const early = this.early.get(snapshot.id);
    this.early.delete(snapshot.id);
    this.mirrored.set(snapshot.id, {
      hostId,
      target,
      workspaceId,
      // 推送帧可能先于答复被处理：已经有更新的就留着更新的。
      snapshot:
        early !== undefined && early.hostId === hostId
          ? early.snapshot
          : snapshot,
    });
    this.prune();
    return this.mirrored.get(snapshot.id)?.snapshot ?? snapshot;
  }

  /** 这个工作空间发起的操作的最新快照；别的工作空间的一律 404。 */
  snapshot(workspaceId: string, id: string): OperationSnapshot {
    const entry = this.mirrored.get(id);
    if (entry === undefined || entry.workspaceId !== workspaceId) {
      throw notFound();
    }
    return entry.snapshot;
  }

  owns(workspaceId: string, id: string): boolean {
    return this.mirrored.get(id)?.workspaceId === workspaceId;
  }

  async cancel(workspaceId: string, id: string): Promise<OperationSnapshot> {
    const entry = this.mirrored.get(id);
    if (entry === undefined || entry.workspaceId !== workspaceId) {
      throw notFound();
    }
    if (isTerminal(entry.snapshot.state)) return entry.snapshot;
    const snapshot = (await executeOn(entry.target, "git.operationCancel", {
      id,
    })) as OperationSnapshot;
    if (!isTerminal(entry.snapshot.state)) entry.snapshot = snapshot;
    return entry.snapshot;
  }

  /**
   * 一个仓库的操作历史，新的在前。Worker 答它这一次会话里的那些；只留这个工作
   * 空间发起的，并用镜像里更新的那份替换。
   */
  async list(
    target: ExecutionTarget,
    workspaceId: string,
    path: string,
    execute: boolean,
  ): Promise<OperationSnapshot[]> {
    const listed = (await executeOn(target, "git.operations", {
      path,
      execute,
    })) as OperationSnapshot[];
    return listed
      .filter((snapshot) => this.owns(workspaceId, snapshot.id))
      .map((snapshot) => this.mirrored.get(snapshot.id)?.snapshot ?? snapshot);
  }
}

/** core 里唯一的一份。 */
export const remoteGitOperations = new RemoteGitOperations();
