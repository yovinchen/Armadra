import {
  GitActionKind,
  GitOperationState,
  GitReadMethod,
  type GitOperationRecord,
  type HostGitClient,
} from "@armadra/host-client";
import {
  gitBranchSnapshotSchema,
  gitCherryPickPreviewSchema,
  gitCommitDetailSchema,
  gitCommitFileDiffSchema,
  gitHistoryPageSchema,
  gitIntegrationSnapshotSchema,
  gitRebaseTodoPreviewSchema,
  gitReflogPageSchema,
  gitRemotesSchema,
  gitRepositoryActionSchema,
  gitRepositoryListSchema,
  gitStashDetailSchema,
  gitStashSnapshotSchema,
  gitStatusBatchSchema,
  gitStatusSchema,
  gitTagSnapshotSchema,
  gitWorktreeBindingVerdictSchema,
  gitWorktreesSchema,
  type GitExpectedState,
  type GitRepositoryAction,
  type GitRepositoryOperation,
  type GitRestoreSource,
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

/** 读的 body 与写的动作走同一种编码：都是 Runtime 自己的 camelCase JSON。 */
function encode(value: unknown): Uint8Array {
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
    progress: record.progress,
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

/**
 * 一次读走哪一侧。
 *
 * 规则和写不同，而且必须不同：**归属没落定时读走 Runtime**。它交出写权之后
 * 仍然照常答读，所以切换窗口里面板照旧有内容；反过来把读也停掉，只会让用户
 * 在一次维护里看到一整块空白，而那块空白并不代表仓库出了任何事。
 */
function readRoute(): "runtime" | "host" {
  const state = useOwnership.getState();
  const current = state.failed ? "error" : domainStatus("git", state.domains);
  if (current === "host") return "host";
  if (current === "unknown" || current === "error") {
    // 顺手补一次探测，但**不等它**：这一次读照旧走 Runtime，下一次就走对
    // 边。等下去的代价是每个面板第一次渲染都卡在一次网络往返上，而这次往返
    // 换来的信息，对一次读来说并不改变答案——Runtime 两侧都答读。
    void state.probe().catch(() => undefined);
  }
  return "runtime";
}

/**
 * Host 那侧的读回来的是「Runtime 自己那条路由会返回的状态码 + 原样的 JSON」。
 * 状态码原样带回是这条通道的全部意义：一个不存在的提交在两侧都得是 404，而
 * 不能因为过了一次转发就变成 500。
 */
async function hostRead<T>(
  target: GitTarget,
  method: GitReadMethod,
  body: unknown,
  schema: { parse: (value: unknown) => T },
): Promise<T> {
  const client = await resolver(target.workspaceId, false);
  const answer = await client.read({
    method,
    scope: {
      workspaceId: target.workspaceId,
      repositoryPath: target.repositoryPath,
      repositoryId: target.repositoryId,
    },
    requestJson: body === undefined ? undefined : encode(body),
  });
  const text = new TextDecoder().decode(answer.body);
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : {};
  if (answer.httpStatus < 200 || answer.httpStatus >= 300) {
    const failure = parsed as { code?: unknown; message?: unknown };
    // 状态码与 code 原样抛出：调用方处理一个 404 的方式，两侧必须一样。
    throw new RuntimeRequestError(
      answer.httpStatus,
      typeof failure.message === "string" ? failure.message : "Git read failed",
      typeof failure.code === "string" ? failure.code : undefined,
      parsed,
    );
  }
  return schema.parse(parsed);
}

/**
 * 一次读的两条实现，选一条执行。
 *
 * 调用方只写一次形状：Runtime 那侧调它自己的路由，Host 那侧走 `Read` 通道，
 * 两边解析同一份 zod schema——因为两边本来就是同一份 JSON。
 */
async function route<T>(
  target: GitTarget,
  method: GitReadMethod,
  body: unknown,
  schema: { parse: (value: unknown) => T },
  runtime: () => Promise<T>,
): Promise<T> {
  if (readRoute() === "runtime") return runtime();
  return hostRead(target, method, body, schema);
}

/**
 * 队列条目里的动作字节 → 面板渲染的那个动作。
 *
 * 这些字节是**调用方自己发出去的那一份**：Host 只按 `kind` 排序，从不解析
 * 它们。所以这里是在读自己写的东西，不是在依赖一份协议承诺的形状；解不出来
 * 就是解不出来，不猜。
 */
function decodeAction(action: Uint8Array): GitRepositoryAction | null {
  if (action.length === 0) return null;
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(action));
    const body = decoded as { action?: unknown };
    // 仓库动作包在 `{ path, action, expected }` 里；暂存这类逐路径写则是平的。
    const candidate =
      body && typeof body === "object" && "action" in body
        ? body.action
        : decoded;
    const parsed = gitRepositoryActionSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Host 的读 body 里，检出目录这一项。 */
function at(target: GitTarget): { path: string } {
  return { path: target.path ?? "." };
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

  /* --------------------------------- 读 ---------------------------------- */
  //
  // 每一条读都只写一次形状，两侧解析同一份 zod schema——因为两边本来就是同
  // 一份 JSON：Host 那侧转发的是 Runtime 自己的路由，连状态码都原样带回。
  //
  // 面板从此不再直接调 `runtimeApi`。这不是整洁问题：切到 Host 之后，直连
  // Runtime 的读读的是**那台 Runtime 眼里的仓库**，而写走的是 Host 的队列，
  // 两者之间隔着一次转发和一份快照缓存；同一个面板里一半数据来自一侧、另一
  // 半来自另一侧，是「暂存了却看不到」这类报告的来源。

  /** 工作空间下的仓库发现。 */
  repositories(
    target: GitTarget,
    options: { refresh?: boolean; maxDepth?: number } = {},
    signal?: AbortSignal,
  ) {
    return route(
      target,
      GitReadMethod.REPOSITORIES,
      { workspaceId: target.workspaceId, maxDepth: options.maxDepth },
      gitRepositoryListSchema,
      () => runtimeApi.gitRepositories(target.workspaceId, options, signal),
    );
  },

  /** 一个检出的状态；`pathspecs` 由服务端过滤，不在浏览器里再筛一遍。 */
  status(
    target: GitTarget,
    options: { pathspecs?: string[] } = {},
    signal?: AbortSignal,
  ) {
    return route(
      target,
      GitReadMethod.STATUS,
      { ...at(target), paths: options.pathspecs ?? [] },
      gitStatusSchema,
      () =>
        runtimeApi.gitStatus(
          target.workspaceId,
          target.path ?? ".",
          options.pathspecs,
          signal,
        ),
    );
  },

  /**
   * 一次取多个检出的状态（Git 设计 §4.1 全部仓库聚合）。
   *
   * 聚合视图原来是每个仓库一次往返，十二个仓库就是十二次；更糟的是那十二个
   * 答案被当成一份列表渲染，而它们是十二个不同时刻观察到的。
   */
  statusBatch(
    target: GitTarget,
    paths: string[],
    options: { pathspecs?: string[] } = {},
    signal?: AbortSignal,
  ) {
    return route(
      target,
      GitReadMethod.STATUS_BATCH,
      { paths, pathspecs: options.pathspecs ?? [] },
      gitStatusBatchSchema,
      () =>
        runtimeApi.gitRepositoryStatusBatch(
          target.workspaceId,
          paths,
          options,
          signal,
        ),
    );
  },

  branches(target: GitTarget, signal?: AbortSignal) {
    return route(
      target,
      GitReadMethod.BRANCHES,
      at(target),
      gitBranchSnapshotSchema,
      () =>
        runtimeApi.gitRepositoryBranches(
          target.workspaceId,
          target.path ?? ".",
          signal,
        ),
    );
  },

  tags(target: GitTarget, signal?: AbortSignal) {
    return route(
      target,
      GitReadMethod.TAGS,
      at(target),
      gitTagSnapshotSchema,
      () =>
        runtimeApi.gitRepositoryTags(
          target.workspaceId,
          signal,
          target.path ?? ".",
        ),
    );
  },

  remotes(target: GitTarget, signal?: AbortSignal) {
    return route(
      target,
      GitReadMethod.REMOTES,
      at(target),
      gitRemotesSchema,
      () =>
        runtimeApi.gitRepositoryRemotes(
          target.workspaceId,
          signal,
          target.path ?? ".",
        ),
    );
  },

  stashes(target: GitTarget, signal?: AbortSignal) {
    return route(
      target,
      GitReadMethod.STASHES,
      at(target),
      gitStashSnapshotSchema,
      () =>
        runtimeApi.gitRepositoryStashes(
          target.workspaceId,
          signal,
          target.path ?? ".",
        ),
    );
  },

  stashDetail(target: GitTarget, oid: string, signal?: AbortSignal) {
    return route(
      target,
      GitReadMethod.STASH_DETAIL,
      { ...at(target), oid },
      gitStashDetailSchema,
      () =>
        runtimeApi.gitRepositoryStashDetail(
          target.workspaceId,
          oid,
          signal,
          target.path ?? ".",
        ),
    );
  },

  worktrees(target: GitTarget, signal?: AbortSignal) {
    return route(
      target,
      GitReadMethod.WORKTREES,
      at(target),
      gitWorktreesSchema,
      () =>
        runtimeApi.gitRepositoryWorktrees(
          target.workspaceId,
          signal,
          target.path ?? ".",
        ),
    );
  },

  /**
   * Frame 绑定的这个 worktree 还在不在、还是不是它声称的那个仓库
   * （Git 设计 §5.1、§5.3）。两侧都做同一套判定，Host 侧另外先拒掉落在
   * 工作空间根之外的路径——那是一句关于「这个工作空间能不能碰它」的话，
   * 不需要起一个进程才能说。
   */
  worktreeBinding(
    target: GitTarget,
    binding: {
      worktreePath: string;
      branch?: string | null;
      repositoryId?: string | null;
    },
    signal?: AbortSignal,
  ) {
    return route(
      target,
      GitReadMethod.WORKTREE_BINDING,
      {
        worktreePath: binding.worktreePath,
        ...(binding.branch ? { branch: binding.branch } : {}),
        ...(binding.repositoryId ? { repositoryId: binding.repositoryId } : {}),
      },
      gitWorktreeBindingVerdictSchema,
      () =>
        runtimeApi.gitRepositoryWorktreeBinding(
          target.workspaceId,
          binding,
          signal,
        ),
    );
  },

  history(
    target: GitTarget,
    options: {
      reference?: string;
      cursor?: string;
      limit?: number;
      paths?: string[];
    } = {},
    signal?: AbortSignal,
  ) {
    const reference = options.reference ?? "HEAD";
    return route(
      target,
      GitReadMethod.HISTORY,
      {
        ...at(target),
        reference,
        limit: options.limit ?? 50,
        cursor: options.cursor,
        paths: options.paths ?? [],
      },
      gitHistoryPageSchema,
      () =>
        runtimeApi.gitRepositoryHistory(
          target.workspaceId,
          reference,
          options.cursor,
          signal,
          target.path ?? ".",
          options.limit,
          options.paths,
        ),
    );
  },

  /** 一个引用的 reflog；找回被 reset 或 rebase 丢掉的提交就靠它。 */
  reflog(
    target: GitTarget,
    options: { reference?: string; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) {
    const reference = options.reference ?? "HEAD";
    return route(
      target,
      GitReadMethod.REFLOG,
      {
        ...at(target),
        reference,
        limit: options.limit ?? 50,
        cursor: options.cursor,
      },
      gitReflogPageSchema,
      () =>
        runtimeApi.gitRepositoryReflog(
          target.workspaceId,
          reference,
          options.cursor,
          signal,
          target.path ?? ".",
          options.limit,
        ),
    );
  },

  commitDetail(
    target: GitTarget,
    oid: string,
    base: string | null,
    signal?: AbortSignal,
  ) {
    return route(
      target,
      GitReadMethod.COMMIT_DETAIL,
      { ...at(target), oid, ...(base === null ? {} : { base }) },
      gitCommitDetailSchema,
      () =>
        runtimeApi.gitRepositoryCommitDetail(
          target.workspaceId,
          oid,
          base,
          signal,
          target.path ?? ".",
        ),
    );
  },

  commitFile(
    target: GitTarget,
    oid: string,
    base: string | null,
    file: string,
    signal?: AbortSignal,
  ) {
    return route(
      target,
      GitReadMethod.COMMIT_FILE,
      { ...at(target), oid, file, ...(base === null ? {} : { base }) },
      gitCommitFileDiffSchema,
      () =>
        runtimeApi.gitRepositoryCommitFile(
          target.workspaceId,
          oid,
          base,
          file,
          signal,
          target.path ?? ".",
        ),
    );
  },

  rebaseTodo(target: GitTarget, onto: string, signal?: AbortSignal) {
    return route(
      target,
      GitReadMethod.REBASE_TODO,
      { ...at(target), onto },
      gitRebaseTodoPreviewSchema,
      () =>
        runtimeApi.gitRepositoryRebaseTodo(
          target.workspaceId,
          onto,
          signal,
          target.path ?? ".",
        ),
    );
  },

  cherryPickPreview(
    target: GitTarget,
    oid: string,
    mainline: number | null,
    signal?: AbortSignal,
  ) {
    return route(
      target,
      GitReadMethod.CHERRY_PICK_PREVIEW,
      { ...at(target), oid, ...(mainline === null ? {} : { mainline }) },
      gitCherryPickPreviewSchema,
      () =>
        runtimeApi.gitRepositoryCherryPickPreview(
          target.workspaceId,
          oid,
          mainline,
          signal,
          target.path ?? ".",
        ),
    );
  },

  integration(target: GitTarget, signal?: AbortSignal) {
    return route(
      target,
      GitReadMethod.INTEGRATION,
      at(target),
      gitIntegrationSnapshotSchema,
      () =>
        runtimeApi.gitRepositoryIntegration(
          target.workspaceId,
          signal,
          target.path ?? ".",
        ),
    );
  },

  /**
   * 队列里的一条。轮询一次写的结果走的就是它。
   *
   * 和 `operations` 一样不转发：这条记录是 Host 自己的。动作解不出来时回退
   * 到调用方手里那一份——它正是刚发出去的那个意图，比留空更接近事实。
   */
  async operation(
    target: GitTarget,
    operationId: string,
    fallback: GitRepositoryAction,
    signal?: AbortSignal,
  ): Promise<GitRepositoryOperation> {
    if (readRoute() === "runtime")
      return runtimeApi.gitRepositoryOperation(
        target.workspaceId,
        operationId,
        signal,
      );
    const client = await resolver(target.workspaceId, false);
    const record = await client.getOperation(operationId);
    return snapshot(record, decodeAction(record.action) ?? fallback);
  },

  /**
   * 队列里的条目。
   *
   * 这一条**不转发**：Host 那侧读的是它自己的队列记录（`ListOperations`），
   * 而那份记录正是这个域搬过来的东西。转发到执行主机只会读到 Runtime 那份
   * 进程内队列——一个刚起来的 Worker 里它必然是空的。
   */
  async operations(target: GitTarget, signal?: AbortSignal) {
    if (readRoute() === "runtime")
      return runtimeApi.gitRepositoryOperations(
        target.workspaceId,
        target.path ?? ".",
        signal,
      );
    const client = await resolver(target.workspaceId, false);
    const records = await client.listOperations({
      workspaceId: target.workspaceId,
      repositoryPath: target.repositoryPath,
      repositoryId: target.repositoryId,
    });
    return records.flatMap((record) => {
      const action = decodeAction(record.action);
      // 解不出动作的条目直接不显示。面板的每一行都要说清「这是哪条命令」，
      // 编不出那句话时留白，好过挂一个名字对不上的动作。
      return action ? [snapshot(record, action)] : [];
    });
  },
};
