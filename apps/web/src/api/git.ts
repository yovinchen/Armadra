import {
  gitCloneRequestSchema,
  gitCloneStartedSchema,
  gitCloneStatusSchema,
  gitCommitRequestSchema,
  gitCommitResponseSchema,
  gitDiffRequestSchema,
  gitDiffSchema,
  gitHeadCommitSchema,
  gitHunkDiffSchema,
  gitHunkMutationSchema,
  gitHunkResultSchema,
  gitInitResponseSchema,
  gitMessageDraftSchema,
  gitMessageProvidersSchema,
  gitMessageRequestSchema,
  gitMessageSourceSchema,
  gitPathsRequestSchema,
  gitResolveResponseSchema,
  gitRevertRequestSchema,
  gitRevertResponseSchema,
  gitStageResponseSchema,
  gitStatusSchema,
  gitUnstageResponseSchema,
  type DiffScope,
  type GitCloneRequest,
  type GitHunkMutation,
  type GitHunkScope,
  type GitMessageRequest,
  type GitRestoreSource,
} from "@armadra/shared";
import { json, noContentSchema, query, request } from "./request";

export const gitApi = {
  /* ------------------------------------ git ----------------------------- */
  gitMessageProviders: (workspaceId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/message/providers`,
      gitMessageProvidersSchema,
      { signal },
    ),
  gitMessageSource: (workspaceId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/message/source`,
      gitMessageSourceSchema,
      { signal },
    ),
  gitMessageGenerate: (workspaceId: string, value: GitMessageRequest) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/message/generate`,
      gitMessageDraftSchema,
      { method: "POST", ...json(gitMessageRequestSchema.parse(value)) },
    ),
  /**
   * `path` is the checkout the file belongs to. Without it a nested
   * repository's `src/a.ts` was read against the workspace root's index — a
   * different repository, and, for the apply below, a different file.
   */
  gitHunks: (
    workspaceId: string,
    file: string,
    scope: GitHunkScope,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/hunks?path=${query(path)}&file=${query(file)}&scope=${scope}`,
      gitHunkDiffSchema,
      { signal },
    ),
  gitApplyHunk: (workspaceId: string, mutation: GitHunkMutation) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/hunks`,
      gitHunkResultSchema,
      {
        method: "POST",
        ...json(gitHunkMutationSchema.parse(mutation)),
      },
    ),
  /**
   * `paths` is a server-side pathspec filter: Git applies it to both the count
   * and the rows, so the two describe one set. Filtering in the browser after
   * reading the whole checkout is what made a panel say "12 changes" above
   * three of them.
   */
  gitStatus: (
    workspaceId: string,
    path = ".",
    paths?: string[],
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/status?path=${query(path)}${
        paths && paths.length > 0 ? `&paths=${query(paths.join(","))}` : ""
      }`,
      gitStatusSchema,
      { signal },
    ),
  /** `git init`; only offered when a status read reported no repository. */
  gitInit: (workspaceId: string) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/init`,
      gitInitResponseSchema,
      { method: "POST" },
    ),
  gitDiff: (
    workspaceId: string,
    options: {
      path?: string;
      scope?: DiffScope;
      paths?: string[];
      ignoreWhitespace?: boolean;
    } = {},
  ) => {
    const parsed = gitDiffRequestSchema.parse(options);
    const params = new URLSearchParams({
      path: parsed.path ?? ".",
      scope: parsed.scope,
    });
    if (parsed.paths && parsed.paths.length > 0) {
      params.set("paths", parsed.paths.join(","));
    }
    if (parsed.ignoreWhitespace) params.set("ignoreWhitespace", "true");
    return request(
      `/api/workspaces/${workspaceId}/git/diff?${params.toString()}`,
      gitDiffSchema,
    );
  },
  gitStage: (workspaceId: string, paths: string[], path = ".") =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/stage`,
      gitStageResponseSchema,
      {
        method: "POST",
        ...json({ ...gitPathsRequestSchema.parse({ paths }), path }),
      },
    ),
  /** `git restore --staged`：只动索引，工作区改动一律保留。 */
  gitUnstage: (workspaceId: string, paths: string[], path = ".") =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/unstage`,
      gitUnstageResponseSchema,
      {
        method: "POST",
        ...json({ ...gitPathsRequestSchema.parse({ paths }), path }),
      },
    ),
  /**
   * Stage a conflicted path. Refused — with the offending line numbers — while
   * the file on disk still contains Git conflict markers.
   */
  gitMarkResolved: (workspaceId: string, paths: string[], path = ".") =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/resolve`,
      gitResolveResponseSchema,
      {
        method: "POST",
        ...json({ ...gitPathsRequestSchema.parse({ paths }), path }),
      },
    ),
  /**
   * `index` restores the working tree from what is staged; `head` restores
   * from the commit and unstages as well. They lose different work, so the
   * caller always says which one it means.
   */
  gitRevert: (
    workspaceId: string,
    paths: string[],
    source: GitRestoreSource = "index",
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/revert`,
      gitRevertResponseSchema,
      {
        method: "POST",
        ...json({ ...gitRevertRequestSchema.parse({ paths, source }), path }),
      },
    ),
  /** The commit an amend would rewrite; null on an unborn branch. */
  gitHeadCommit: (workspaceId: string, signal?: AbortSignal, path = ".") =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/head-commit?path=${query(path)}`,
      gitHeadCommitSchema,
      { signal },
    ),
  gitCommit: (
    workspaceId: string,
    message: string,
    paths?: string[],
    amend?: { expectedHead: string; allowPublished: boolean },
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/commit`,
      gitCommitResponseSchema,
      {
        method: "POST",
        ...json({
          ...gitCommitRequestSchema.parse({
            message,
            ...(paths && paths.length > 0 ? { paths } : {}),
            ...(amend ? { amend } : {}),
          }),
          // One request, one repository: there is deliberately no
          // cross-repository commit (roadmap §4.1).
          path,
        }),
      },
    ),

  /* --------------------------------- 克隆仓库 --------------------------- */
  /**
   * 克隆还没有工作空间，所以不走工作空间事件流：这里拿到 `jobId`，
   * 对话框自己按 500ms 轮询 `gitCloneStatus`（§20）。
   */
  cloneRepository: (input: GitCloneRequest) =>
    request("/api/git/clone", gitCloneStartedSchema, {
      method: "POST",
      ...json(gitCloneRequestSchema.parse(input)),
    }),
  /** 完成时带上 Runtime 已经建好的工作空间，直接打开它。 */
  gitCloneStatus: (jobId: string) =>
    request(`/api/git/clone/${query(jobId)}`, gitCloneStatusSchema),
  cancelClone: (jobId: string) =>
    request(`/api/git/clone/${query(jobId)}`, noContentSchema, {
      method: "DELETE",
    }),
};
