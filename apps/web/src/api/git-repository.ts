import { z } from "zod";
import {
  gitBranchSnapshotSchema,
  gitCherryPickPreviewSchema,
  gitCommitDetailSchema,
  gitCommitFileDiffSchema,
  gitExpectedStateSchema,
  gitHistoryPageSchema,
  gitIntegrationSnapshotSchema,
  gitIdentitySchema,
  gitLogPageSchema,
  gitRefsSnapshotSchema,
  gitRebaseTodoPreviewSchema,
  gitRemotesSchema,
  gitReflogPageSchema,
  gitRepositoryActionSchema,
  gitRepositoryListSchema,
  gitRepositoryOperationSchema,
  gitStatusBatchSchema,
  gitStashDetailSchema,
  gitStashSnapshotSchema,
  gitTagSnapshotSchema,
  gitWorktreeBindingVerdictSchema,
  gitWorktreesSchema,
  type GitExpectedState,
  type GitLogRequest,
  type GitRepositoryAction,
} from "@armadra/shared";
import { json, query, request } from "./request";

export const gitRepositoryApi = {
  /**
   * Every repository read and write names the checkout it means. `path` is
   * workspace-relative and defaults to the workspace root, so a single-repo
   * workspace behaves exactly as before (roadmap §4.1).
   */
  gitRepositories: (
    workspaceId: string,
    options: { refresh?: boolean; maxDepth?: number } = {},
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    if (options.refresh) params.set("refresh", "true");
    if (options.maxDepth !== undefined) {
      params.set("maxDepth", String(options.maxDepth));
    }
    const search = params.toString();
    return request(
      `/api/workspaces/${query(workspaceId)}/git/repositories${search ? `?${search}` : ""}`,
      gitRepositoryListSchema,
      { signal },
    );
  },
  gitRepositoryBranches: (
    workspaceId: string,
    path = ".",
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/branches?path=${query(path)}`,
      gitBranchSnapshotSchema,
      { signal },
    ),
  gitRepositoryOperations: (
    workspaceId: string,
    path = ".",
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/operations?path=${query(path)}`,
      z.array(gitRepositoryOperationSchema),
      { signal },
    ),
  /**
   * `limit` is capped by the service; the commit graph asks for 100 a page and
   * stops at 500 rows, so a long history stays a scroll rather than a stall.
   */
  gitRepositoryHistory: (
    workspaceId: string,
    reference = "HEAD",
    cursor?: string,
    signal?: AbortSignal,
    path = ".",
    limit = 50,
    paths?: string[],
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/history?path=${query(path)}&reference=${query(reference)}&limit=${limit}${cursor ? `&cursor=${query(cursor)}` : ""}${
        paths && paths.length > 0 ? `&paths=${query(paths.join(","))}` : ""
      }`,
      gitHistoryPageSchema,
      { signal },
    ),
  /**
   * One page of the workspace's merged commit log (Git 工具窗口设计 §3.1).
   *
   * A POST that writes nothing: the filters are a record — a ref selection, an
   * author list, a date range, pathspecs, a search with two switches and a page
   * cursor — and putting that in a query string is where escaping goes wrong.
   *
   * The cursor belongs to the filters it was taken under. Changing any of them
   * and sending the cursor back is refused with `invalid_cursor`; the repair is
   * to drop the cursor and read the first page again.
   */
  gitLog: (
    workspaceId: string,
    filters: GitLogRequest = {},
    signal?: AbortSignal,
  ) =>
    request(`/api/workspaces/${query(workspaceId)}/git/log`, gitLogPageSchema, {
      method: "POST",
      signal,
      ...json(filters),
    }),
  /**
   * Every discovered repository's branch tree in one answer, so the Git
   * window's left column is one request rather than five per repository.
   */
  gitRefs: (workspaceId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/refs`,
      gitRefsSnapshotSchema,
      { signal },
    ),
  /**
   * Who a commit from this checkout would be attributed to — `git config`'s
   * own answer, not one inferred from the reflog. Both fields are null when
   * nothing is configured.
   */
  gitIdentity: (workspaceId: string, signal?: AbortSignal, path = ".") =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/identity?path=${query(path)}`,
      gitIdentitySchema,
      { signal },
    ),
  gitRepositoryWorktrees: (
    workspaceId: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/worktrees?path=${query(path)}`,
      gitWorktreesSchema,
      { signal },
    ),
  /** The commits an interactive rebase onto `onto` would replay, in order. */
  gitRepositoryRebaseTodo: (
    workspaceId: string,
    onto: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/rebase-todo?path=${query(path)}&onto=${query(onto)}`,
      gitRebaseTodoPreviewSchema,
      { signal },
    ),
  /**
   * One page of a ref's reference log (Git 设计 §3 "Reflog").
   *
   * Paged by offset rather than by an anchor: the reflog is prepended to and
   * has no immutable anchor to hold a window still, and every entry carries its
   * own `loggedAt` so a reader can see that the window slid.
   */
  gitRepositoryReflog: (
    workspaceId: string,
    reference = "HEAD",
    cursor?: string,
    signal?: AbortSignal,
    path = ".",
    limit = 50,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/reflog?path=${query(path)}&reference=${query(reference)}&limit=${limit}${cursor ? `&cursor=${query(cursor)}` : ""}`,
      gitReflogPageSchema,
      { signal },
    ),
  /**
   * Several checkouts' status in one request (Git 设计 §4.1 全部仓库聚合).
   *
   * A POST because the list of checkouts is a body, not a path — a dozen paths
   * in a query string is where escaping goes wrong. Nothing about it writes.
   */
  gitRepositoryStatusBatch: (
    workspaceId: string,
    paths: string[],
    options: { pathspecs?: string[] } = {},
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/status-batch`,
      gitStatusBatchSchema,
      {
        method: "POST",
        signal,
        ...json({ paths, pathspecs: options.pathspecs ?? [] }),
      },
    ),
  /**
   * Whether a Frame's worktree binding still names a checkout of the repository
   * it claims (Git 设计 §5.1). A verdict with a reason, never a boolean.
   */
  gitRepositoryWorktreeBinding: (
    workspaceId: string,
    binding: {
      worktreePath: string;
      branch?: string | null;
      repositoryId?: string | null;
    },
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/worktree-binding`,
      gitWorktreeBindingVerdictSchema,
      {
        method: "POST",
        signal,
        ...json({
          worktreePath: binding.worktreePath,
          ...(binding.branch ? { branch: binding.branch } : {}),
          ...(binding.repositoryId
            ? { repositoryId: binding.repositoryId }
            : {}),
        }),
      },
    ),
  gitRepositoryTags: (workspaceId: string, signal?: AbortSignal, path = ".") =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/tags?path=${query(path)}`,
      gitTagSnapshotSchema,
      { signal },
    ),
  /** URLs come back with any embedded credentials already replaced. */
  gitRepositoryRemotes: (
    workspaceId: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/remotes?path=${query(path)}`,
      gitRemotesSchema,
      { signal },
    ),
  gitRepositoryStashes: (
    workspaceId: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/stashes?path=${query(path)}`,
      gitStashSnapshotSchema,
      { signal },
    ),
  gitRepositoryIntegration: (
    workspaceId: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/integration?path=${query(path)}`,
      gitIntegrationSnapshotSchema,
      { signal },
    ),
  /**
   * 一个提交改了哪些文件。`base` 传 `null` 表示对第一父提交比较（也就是
   * 「这个提交本身改了什么」），传 `"HEAD"` 就是「比较到当前」。
   */
  gitRepositoryCommitDetail: (
    workspaceId: string,
    oid: string,
    base: string | null,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/commit?path=${query(path)}&oid=${query(oid)}${base === null ? "" : `&base=${query(base)}`}`,
      gitCommitDetailSchema,
      { signal },
    ),
  gitRepositoryCommitFile: (
    workspaceId: string,
    oid: string,
    base: string | null,
    file: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/commit-file?path=${query(path)}&oid=${query(oid)}&file=${query(file)}${base === null ? "" : `&base=${query(base)}`}`,
      gitCommitFileDiffSchema,
      { signal },
    ),
  gitRepositoryCherryPickPreview: (
    workspaceId: string,
    oid: string,
    mainline: number | null,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/cherry-pick-preview?path=${query(path)}&oid=${query(oid)}${mainline === null ? "" : `&mainline=${mainline}`}`,
      gitCherryPickPreviewSchema,
      { signal },
    ),
  gitRepositoryStashDetail: (
    workspaceId: string,
    oid: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/stash-detail?path=${query(path)}&oid=${query(oid)}`,
      gitStashDetailSchema,
      { signal },
    ),
  gitRepositoryOperate: (
    workspaceId: string,
    action: GitRepositoryAction,
    expected: GitExpectedState,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/operations`,
      gitRepositoryOperationSchema,
      {
        method: "POST",
        ...json({
          path,
          action: gitRepositoryActionSchema.parse(action),
          expected: gitExpectedStateSchema.parse(expected),
        }),
      },
    ),
  gitRepositoryOperation: (
    workspaceId: string,
    operationId: string,
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/operations/${query(operationId)}`,
      gitRepositoryOperationSchema,
      { signal },
    ),
  gitRepositoryCancel: (workspaceId: string, operationId: string) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/operations/${query(operationId)}/cancel`,
      gitRepositoryOperationSchema,
      { method: "POST" },
    ),
  /**
   * `scope` 决定取索引的哪一侧：`worktree` = `git diff` + 未跟踪文件，
   * `staged` = `git diff --cached`（未跟踪文件不会出现）。给 `paths` 时
   * 只 diff 这些文件，`path` 目录参数被忽略。
   */
};
