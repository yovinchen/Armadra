import {
  GitActionKind,
  GitOperationState,
  type GitOperationRecord,
  type HostGitClient,
} from "@armadra/host-client";
import type {
  GitExpectedState,
  GitRepositoryAction,
  GitRepositoryOperation,
  GitRestoreSource,
} from "@armadra/shared";

import { RuntimeRequestError, runtimeApi } from "../api/client";
import type { CanvasOwnershipStatus } from "../canvas-ownership/store";
import { domainStatus, useOwnership } from "../ownership/store";
import { resolveHostGitClient } from "./host-session";

/**
 * Git 域网关（业务迁移 §2.8）—— 一次写只落一侧。
 *
 * 搬过去的是**队列**，不是 Git：命令永远在执行主机上跑，握着那台机器自己的
 * 仓库锁、读那台机器自己的凭据。Host 拿到的是四样东西——操作的身份、跑的
 * 顺序、决定时的前置版本、跑完之后的结论——而这四样正是 Runtime 留不住的：
 * 它的队列在内存里，一次重启就把「推送过」这件事本身弄丢了，偏偏那正是
 * 「到底推上去没有」必须能回答的时刻。
 *
 * 所以这里做一件事：把面板原来那三十个逐动作调用**拼装成一次 `Enqueue`**。
 * 调用方的签名一个都没变，它不知道自己走了哪一侧；变的只是 Host 那侧多了一
 * 个知道「同一个 worktree 一次只跑一个」的队列。
 *
 * 路由规则与其余网关一致：读跟着最后一次探到的归属走，探不到就读 Runtime
 * （它交出写权之后仍然照常答读，面板不会在切换窗口里变成一片空白）；写则
 * 相反，归属没落定就不写。
 */

/** 归属没落定，这一次写不该发生。 */
export class GitReadOnlyError extends Error {
  readonly name = "GitReadOnlyError";
  constructor(readonly status: CanvasOwnershipStatus) {
    super(`Git writes are read-only (${status}).`);
  }
}

/**
 * Runtime 已经交出 Git 的写权。**不重试**：同一个请求再发一次还是 409，
 * 而且写方已经换人了。捕获它的地方应该重新探归属，再决定走哪边。
 */
export class GitOwnershipMovedError extends Error {
  readonly name = "GitOwnershipMovedError";
}

function isOwnershipMoved(error: unknown): boolean {
  return (
    error instanceof RuntimeRequestError &&
    error.status === 409 &&
    error.code === "ownership_moved"
  );
}

type HostResolver = (
  workspaceId: string,
  mutation: boolean,
) => Promise<HostGitClient>;

let resolver: HostResolver = resolveHostGitClient;

/** 测试注入 Host 客户端；传 `null` 恢复真实实现。 */
export function setGitHostResolver(next: HostResolver | null): void {
  resolver = next ?? resolveHostGitClient;
}

async function settled(): Promise<CanvasOwnershipStatus> {
  const state = useOwnership.getState();
  const current = state.failed ? "error" : domainStatus("git", state.domains);
  // `error` 和 `unknown` 一样要重探：探测失败是一次丢掉的请求，不是判决。
  if (current !== "unknown" && current !== "error") return current;
  const domains = await state.probe();
  return useOwnership.getState().failed
    ? "error"
    : domainStatus("git", domains);
}

async function writeRoute(): Promise<"runtime" | "host"> {
  const status = await settled();
  if (status !== "runtime" && status !== "host")
    throw new GitReadOnlyError(status);
  return status;
}

async function runtimeWrite<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!isOwnershipMoved(error)) throw error;
    await useOwnership.getState().probe();
    throw new GitOwnershipMovedError();
  }
}

/**
 * 面板的动作名到 Host 队列种类的映射。
 *
 * 表是**封闭的**，和 `git.proto` 里的枚举一样，理由也一样：Host 靠种类决定
 * 串行与锁序，一个它叫不出名字的动作就是一个它排不了序的动作。表里没有的
 * 动作在这里就被拒，而不是送到 Host 之后被拒——那时候调用方已经以为自己排
 * 上队了。
 */
const REPOSITORY_KINDS: Record<GitRepositoryAction["kind"], GitActionKind> = {
  startCherryPick: GitActionKind.START_CHERRY_PICK,
  revert: GitActionKind.REVERT,
  checkoutCommit: GitActionKind.CHECKOUT_COMMIT,
  reset: GitActionKind.RESET,
  skipIntegration: GitActionKind.SKIP_INTEGRATION,
  startMerge: GitActionKind.START_MERGE,
  startRebase: GitActionKind.START_REBASE,
  startInteractiveRebase: GitActionKind.START_INTERACTIVE_REBASE,
  continueIntegration: GitActionKind.CONTINUE_INTEGRATION,
  abortIntegration: GitActionKind.ABORT_INTEGRATION,
  createStash: GitActionKind.CREATE_STASH,
  applyStash: GitActionKind.APPLY_STASH,
  popStash: GitActionKind.POP_STASH,
  dropStash: GitActionKind.DROP_STASH,
  createBranch: GitActionKind.CREATE_BRANCH,
  switchBranch: GitActionKind.SWITCH_BRANCH,
  deleteBranch: GitActionKind.DELETE_BRANCH,
  fetch: GitActionKind.FETCH,
  pull: GitActionKind.PULL,
  push: GitActionKind.PUSH,
  sync: GitActionKind.SYNC,
  createTag: GitActionKind.CREATE_TAG,
  deleteTag: GitActionKind.DELETE_TAG,
  pushTag: GitActionKind.PUSH_TAG,
  addRemote: GitActionKind.ADD_REMOTE,
  renameRemote: GitActionKind.RENAME_REMOTE,
  setRemoteUrl: GitActionKind.SET_REMOTE_URL,
  removeRemote: GitActionKind.REMOVE_REMOTE,
  createWorktree: GitActionKind.CREATE_WORKTREE,
  removeWorktree: GitActionKind.REMOVE_WORKTREE,
};

/** Host 的状态枚举 → 面板一直在渲染的那组字符串。 */
const STATES: Record<GitOperationState, GitRepositoryOperation["state"]> = {
  [GitOperationState.UNSPECIFIED]: "queued",
  [GitOperationState.QUEUED]: "queued",
  [GitOperationState.RUNNING]: "running",
  [GitOperationState.SUCCEEDED]: "succeeded",
  [GitOperationState.FAILED]: "failed",
  [GitOperationState.CANCELLED]: "cancelled",
  // 结果未知**不是**失败。渲染成失败会请人去做那一件绝不能自动做的事：
  // 再推一次。
  [GitOperationState.UNKNOWN_OUTCOME]: "unknownOutcome",
  [GitOperationState.AWAITING_RESOLUTION]: "awaitingResolution",
};

const encoder = new TextEncoder();

function body(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

/**
 * 同一次意图的重试用同一个 id：Host 认得出这是重放，不会排第二个提交。
 * 摘要覆盖动作本身，所以「同一个 id 换了内容」是冲突而不是替换。
 */
function operationId(workspaceId: string, seed: string): string {
  return `git/${workspaceId}/${seed}`;
}

/**
 * Host 的队列条目 → 面板的操作快照。
 *
 * `workspaceRoot` 与 `action` 是 Runtime 形状里有、Host 记录里没有直接对应
 * 的两项：Host 存的是版本锁字节而不是解析过的动作。这里回填调用方自己刚发
 * 出去的那一份，而不是去猜——猜出来的动作会在面板上显示成另一条命令。
 */
function snapshot(
  record: GitOperationRecord,
  action: GitRepositoryAction,
): GitRepositoryOperation {
  return {
    id: record.operationId,
    repositoryId: record.scope.repositoryId ?? "",
    workspaceRoot: "",
    repositoryPath: record.scope.repositoryPath,
    action,
    state: STATES[record.state] ?? "queued",
    cancellationRequested: false,
    createdAt: new Date(Number(record.createdAtUnixMs)).toISOString(),
    finishedAt:
      record.finishedAtUnixMs > 0n
        ? new Date(Number(record.finishedAtUnixMs)).toISOString()
        : null,
    message: record.messageCode === "" ? null : record.messageCode,
  };
}

/**
 * 一次写的目标检出。Host 按**路径**串行，所以路径必须是执行主机上的绝对
 * 路径；面板给的是工作空间相对路径，由调用方连同工作空间根一起传进来。
 */
export interface GitTarget {
  workspaceId: string;
  /** 执行主机上的绝对路径。 */
  repositoryPath: string;
  /** 规范 common git dir 的 SHA-256；同一仓库的每个 worktree 共用一个。 */
  repositoryId?: string;
  /** 工作空间相对的检出目录，Runtime 那侧的 `path`；默认工作空间根。 */
  path?: string;
}

async function enqueue(
  target: GitTarget,
  kind: GitActionKind,
  seed: string,
  action: unknown,
  expected?: { headOid?: string },
): Promise<GitOperationRecord> {
  const client = await resolver(target.workspaceId, true);
  return client.enqueue({
    operationId: operationId(target.workspaceId, seed),
    scope: {
      workspaceId: target.workspaceId,
      repositoryPath: target.repositoryPath,
      repositoryId: target.repositoryId,
    },
    kind,
    action: body(action),
    expected: expected?.headOid ? { headOid: expected.headOid } : undefined,
  });
}

export const gitGateway = {
  /**
   * 队列的通用入口：面板的 `gitRepositoryOperate` 在 Host 侧就是一次
   * `Enqueue`。
   */
  async operate(
    target: GitTarget,
    action: GitRepositoryAction,
    expected: GitExpectedState,
    seed: string,
  ): Promise<GitRepositoryOperation> {
    const path = target.path ?? ".";
    if ((await writeRoute()) === "runtime")
      return runtimeWrite(() =>
        runtimeApi.gitRepositoryOperate(
          target.workspaceId,
          action,
          expected,
          path,
        ),
      );
    const kind = REPOSITORY_KINDS[action.kind];
    if (kind === undefined) throw new GitReadOnlyError("unknown");
    const record = await enqueue(
      target,
      kind,
      seed,
      { path, action, expected },
      { headOid: expected.headOid ?? undefined },
    );
    return snapshot(record, action);
  },

  /**
   * 取消是一次**请求**，不是一个结果：已经开始改仓库的操作回
   * `unknownOutcome` 而不是 `cancelled`，因为被打断的推送可能已经被远端收下。
   */
  async cancel(
    target: GitTarget,
    operationId: string,
    action: GitRepositoryAction,
    seed: string,
  ): Promise<GitRepositoryOperation> {
    if ((await writeRoute()) === "runtime")
      return runtimeWrite(() =>
        runtimeApi.gitRepositoryCancel(target.workspaceId, operationId),
      );
    const client = await resolver(target.workspaceId, true);
    const record = await client.cancelOperation(
      `git/${target.workspaceId}/${seed}`,
      operationId,
    );
    return snapshot(record, action);
  },

  /** `POST /git/stage` 的等价物。 */
  async stage(target: GitTarget, paths: string[], seed: string) {
    const path = target.path ?? ".";
    if ((await writeRoute()) === "runtime")
      return runtimeWrite(() =>
        runtimeApi.gitStage(target.workspaceId, paths, path),
      );
    const record = await enqueue(target, GitActionKind.STAGE, seed, {
      paths,
      path,
    });
    return { staged: record.affected };
  },

  /** `POST /git/unstage` 的等价物。 */
  async unstage(target: GitTarget, paths: string[], seed: string) {
    const path = target.path ?? ".";
    if ((await writeRoute()) === "runtime")
      return runtimeWrite(() =>
        runtimeApi.gitUnstage(target.workspaceId, paths, path),
      );
    const record = await enqueue(target, GitActionKind.UNSTAGE, seed, {
      paths,
      path,
    });
    return { unstaged: record.affected };
  },

  /** `POST /git/resolve` 的等价物：仍然由服务重读文件后才 `git add`。 */
  async markResolved(target: GitTarget, paths: string[], seed: string) {
    const path = target.path ?? ".";
    if ((await writeRoute()) === "runtime")
      return runtimeWrite(() =>
        runtimeApi.gitMarkResolved(target.workspaceId, paths, path),
      );
    const record = await enqueue(target, GitActionKind.MARK_RESOLVED, seed, {
      paths,
      path,
    });
    return { resolved: record.affected };
  },

  /**
   * `POST /git/revert` 的等价物。`source` 一定要传：从索引还原和从 HEAD 还原
   * 丢掉的东西不一样，默认哪一个都是替用户做决定。
   */
  async revert(
    target: GitTarget,
    paths: string[],
    source: GitRestoreSource,
    seed: string,
  ) {
    const path = target.path ?? ".";
    if ((await writeRoute()) === "runtime")
      return runtimeWrite(() =>
        runtimeApi.gitRevert(target.workspaceId, paths, source, path),
      );
    const record = await enqueue(target, GitActionKind.RESTORE, seed, {
      paths,
      path,
      source,
    });
    return { reverted: record.affected };
  },

  /** `POST /git/commit` 的等价物。 */
  async commit(
    target: GitTarget,
    message: string,
    seed: string,
    paths?: string[],
    amend?: { expectedHead: string; allowPublished: boolean },
  ) {
    const path = target.path ?? ".";
    if ((await writeRoute()) === "runtime")
      return runtimeWrite(() =>
        runtimeApi.gitCommit(target.workspaceId, message, paths, amend, path),
      );
    const record = await enqueue(
      target,
      GitActionKind.COMMIT,
      seed,
      {
        message,
        path,
        ...(paths && paths.length > 0 ? { paths } : {}),
        ...(amend ? { amend } : {}),
      },
      // amend 带着界面展示过的 HEAD：HEAD 变过就拒，不是覆盖。
      amend ? { headOid: amend.expectedHead } : undefined,
    );
    return { commit: record.affected[0] ?? "", committed: record.affected };
  },

  /** `POST /git/init` 的等价物。 */
  async init(target: GitTarget, seed: string) {
    if ((await writeRoute()) === "runtime")
      return runtimeWrite(() => runtimeApi.gitInit(target.workspaceId));
    const record = await enqueue(target, GitActionKind.INIT, seed, {});
    return { repository: true, branch: null, path: record.affected[0] ?? "" };
  },
};
