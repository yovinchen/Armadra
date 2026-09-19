import type {
  GitExpectedState,
  GitLogRequest,
  GitRepositoryAction,
  GitRepositoryOperation,
  GitRestoreSource,
} from "@armadra/shared";

import { runtimeApi } from "../api/client";

/**
 * Git 域网关。
 *
 * 搬迁时代这里要在 Runtime 的进程内队列与 Host 的持久队列之间选一侧，读还要
 * 分「直连」与「经转发」两条路。单一 core 之后队列与命令在同一个进程里，
 * 读写都只剩 core 自己那一套 `/api/workspaces/{id}/git*` 路由。
 *
 * 模块留着的理由没变：面板不直接调 `runtimeApi`。每个面板都有一个
 * `GitTarget`——工作空间、仓库绝对路径、仓库 id、检出目录——把它散进三十个
 * 调用点意味着三十处各自拼一遍 `path ?? "."`。
 */

/**
 * 一次 Git 调用的作用域。
 *
 * `repositoryPath` 是执行主机上的绝对路径；面板给的是工作空间相对路径，由
 * 调用方连同工作空间根一起传进来。
 */
export interface GitTarget {
  workspaceId: string;
  /** 执行主机上的绝对路径。 */
  repositoryPath: string;
  /** 规范 common git dir 的 SHA-256；同一仓库的每个 worktree 共用一个。 */
  repositoryId?: string;
  /** 工作空间相对的检出目录，core 那边的 `path`；默认工作空间根。 */
  path?: string;
}

/** 检出目录，缺省是工作空间根。 */
function at(target: GitTarget): string {
  return target.path ?? ".";
}

export const gitGateway = {
  /* --------------------------------- 写 ---------------------------------- */
  //
  // `seed` 参数留着：调用点按位置传参，而它原本是 Host 队列的幂等键。core
  // 的队列在同一个进程里，重放由调用点自己的 mutation 状态管，这里不再用它。

  /** 队列的通用入口。 */
  operate(
    target: GitTarget,
    action: GitRepositoryAction,
    expected: GitExpectedState,
    _seed?: string,
  ): Promise<GitRepositoryOperation> {
    return runtimeApi.gitRepositoryOperate(
      target.workspaceId,
      action,
      expected,
      at(target),
    );
  },

  /**
   * 取消是一次**请求**，不是一个结果：已经开始改仓库的操作回
   * `unknownOutcome` 而不是 `cancelled`，因为被打断的推送可能已经被远端收下。
   */
  cancel(
    target: GitTarget,
    operationId: string,
    _action?: GitRepositoryAction,
    _seed?: string,
  ): Promise<GitRepositoryOperation> {
    return runtimeApi.gitRepositoryCancel(target.workspaceId, operationId);
  },

  /** `POST /git/stage` 的等价物。 */
  stage(target: GitTarget, paths: string[], _seed?: string) {
    return runtimeApi.gitStage(target.workspaceId, paths, at(target));
  },

  /** `POST /git/unstage` 的等价物。 */
  unstage(target: GitTarget, paths: string[], _seed?: string) {
    return runtimeApi.gitUnstage(target.workspaceId, paths, at(target));
  },

  /** `POST /git/resolve` 的等价物：仍然由服务重读文件后才 `git add`。 */
  markResolved(target: GitTarget, paths: string[], _seed?: string) {
    return runtimeApi.gitMarkResolved(target.workspaceId, paths, at(target));
  },

  /**
   * `POST /git/revert` 的等价物。`source` 一定要传：从索引还原和从 HEAD 还原
   * 丢掉的东西不一样，默认哪一个都是替用户做决定。
   */
  revert(
    target: GitTarget,
    paths: string[],
    source: GitRestoreSource,
    _seed?: string,
  ) {
    return runtimeApi.gitRevert(target.workspaceId, paths, source, at(target));
  },

  /** `POST /git/commit` 的等价物。 */
  commit(
    target: GitTarget,
    message: string,
    _seed?: string,
    paths?: string[],
    amend?: { expectedHead: string; allowPublished: boolean },
  ) {
    return runtimeApi.gitCommit(
      target.workspaceId,
      message,
      paths,
      amend,
      at(target),
    );
  },

  /** `POST /git/init` 的等价物。 */
  init(target: GitTarget, _seed?: string) {
    return runtimeApi.gitInit(target.workspaceId);
  },

  /* --------------------------------- 读 ---------------------------------- */

  /** 工作空间下的仓库发现。 */
  repositories(
    target: GitTarget,
    options: { refresh?: boolean; maxDepth?: number } = {},
    signal?: AbortSignal,
  ) {
    return runtimeApi.gitRepositories(target.workspaceId, options, signal);
  },

  /** 一个检出的状态；`pathspecs` 由服务端过滤，不在浏览器里再筛一遍。 */
  status(
    target: GitTarget,
    options: { pathspecs?: string[] } = {},
    signal?: AbortSignal,
  ) {
    return runtimeApi.gitStatus(
      target.workspaceId,
      at(target),
      options.pathspecs,
      signal,
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
    return runtimeApi.gitRepositoryStatusBatch(
      target.workspaceId,
      paths,
      options,
      signal,
    );
  },

  branches(target: GitTarget, signal?: AbortSignal) {
    return runtimeApi.gitRepositoryBranches(
      target.workspaceId,
      at(target),
      signal,
    );
  },

  tags(target: GitTarget, signal?: AbortSignal) {
    return runtimeApi.gitRepositoryTags(target.workspaceId, signal, at(target));
  },

  remotes(target: GitTarget, signal?: AbortSignal) {
    return runtimeApi.gitRepositoryRemotes(
      target.workspaceId,
      signal,
      at(target),
    );
  },

  stashes(target: GitTarget, signal?: AbortSignal) {
    return runtimeApi.gitRepositoryStashes(
      target.workspaceId,
      signal,
      at(target),
    );
  },

  stashDetail(target: GitTarget, oid: string, signal?: AbortSignal) {
    return runtimeApi.gitRepositoryStashDetail(
      target.workspaceId,
      oid,
      signal,
      at(target),
    );
  },

  worktrees(target: GitTarget, signal?: AbortSignal) {
    return runtimeApi.gitRepositoryWorktrees(
      target.workspaceId,
      signal,
      at(target),
    );
  },

  /**
   * Frame 绑定的这个 worktree 还在不在、还是不是它声称的那个仓库
   * （Git 设计 §5.1、§5.3）。
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
    return runtimeApi.gitRepositoryWorktreeBinding(
      target.workspaceId,
      binding,
      signal,
    );
  },

  /**
   * 整个工作空间的合并提交图（Git 工具窗口设计 §3.1）。
   *
   * 它不是「某个仓库的历史」：有哪些仓库本身就是答案的一部分，所以它不带
   * 检出路径，作用域只认工作空间。
   *
   * 游标绑定在筛选条件上。条件变了还把旧游标送回去会被 `invalid_cursor`
   * 拒绝——`--skip` 数的是通过筛选的提交，换一套条件继续翻页只会给出一个谁
   * 都没见过的窗口。调用方的修复是丢掉游标重读第一页。
   */
  log(target: GitTarget, filters: GitLogRequest = {}, signal?: AbortSignal) {
    return runtimeApi.gitLog(target.workspaceId, filters, signal);
  },

  /** 所有仓库的分支树，一次读完（Git 工具窗口设计 §3.1）。 */
  refs(target: GitTarget, signal?: AbortSignal) {
    return runtimeApi.gitRefs(target.workspaceId, signal);
  },

  /**
   * 这个检出提交出去会署谁的名（`git config user.name` / `user.email`）。
   *
   * 日志页的「我的」筛选与提交页的署名读的是它，而不是从 reflog 最后一条推
   * 出来的那个人——那是**上一个在这里写过东西的人**，未必是坐在这里的人；
   * 刚克隆下来的仓库更是一条 reflog 都没有。没配置就是两个 `null`。
   */
  identity(target: GitTarget, signal?: AbortSignal) {
    return runtimeApi.gitIdentity(target.workspaceId, signal, at(target));
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
    return runtimeApi.gitRepositoryHistory(
      target.workspaceId,
      options.reference ?? "HEAD",
      options.cursor,
      signal,
      at(target),
      options.limit,
      options.paths,
    );
  },

  /** 一个引用的 reflog；找回被 reset 或 rebase 丢掉的提交就靠它。 */
  reflog(
    target: GitTarget,
    options: { reference?: string; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) {
    return runtimeApi.gitRepositoryReflog(
      target.workspaceId,
      options.reference ?? "HEAD",
      options.cursor,
      signal,
      at(target),
      options.limit,
    );
  },

  commitDetail(
    target: GitTarget,
    oid: string,
    base: string | null,
    signal?: AbortSignal,
  ) {
    return runtimeApi.gitRepositoryCommitDetail(
      target.workspaceId,
      oid,
      base,
      signal,
      at(target),
    );
  },

  commitFile(
    target: GitTarget,
    oid: string,
    base: string | null,
    file: string,
    signal?: AbortSignal,
  ) {
    return runtimeApi.gitRepositoryCommitFile(
      target.workspaceId,
      oid,
      base,
      file,
      signal,
      at(target),
    );
  },

  rebaseTodo(target: GitTarget, onto: string, signal?: AbortSignal) {
    return runtimeApi.gitRepositoryRebaseTodo(
      target.workspaceId,
      onto,
      signal,
      at(target),
    );
  },

  cherryPickPreview(
    target: GitTarget,
    oid: string,
    mainline: number | null,
    signal?: AbortSignal,
  ) {
    return runtimeApi.gitRepositoryCherryPickPreview(
      target.workspaceId,
      oid,
      mainline,
      signal,
      at(target),
    );
  },

  integration(target: GitTarget, signal?: AbortSignal) {
    return runtimeApi.gitRepositoryIntegration(
      target.workspaceId,
      signal,
      at(target),
    );
  },

  /** 队列里的一条。轮询一次写的结果走的就是它。 */
  operation(
    target: GitTarget,
    operationId: string,
    _fallback?: GitRepositoryAction,
    signal?: AbortSignal,
  ): Promise<GitRepositoryOperation> {
    return runtimeApi.gitRepositoryOperation(
      target.workspaceId,
      operationId,
      signal,
    );
  },

  /** 队列里的条目。 */
  operations(target: GitTarget, signal?: AbortSignal) {
    return runtimeApi.gitRepositoryOperations(
      target.workspaceId,
      at(target),
      signal,
    );
  },
};
