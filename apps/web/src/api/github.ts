/**
 * GitHub 面板对 core 的调用面 —— `/api/github/*`（R7a）。
 *
 * ## 线上的形状
 *
 * 形状逐字段写在 `docs/contracts/core-json-api.md` §2 与 §5：
 * 字段名 camelCase、`int64` / `uint64` 是十进制**字符串**、枚举是枚举值名、零值
 * 照写。这里的 zod 把它解回页面一直在用的那套值：`int64` 回 `bigint`，枚举回
 * 那个字符串本身。
 *
 * **`bigint` 保留**不是惯性：Issue 与 PR 的编号、时间戳和 id 都是 64 位，
 * `number` 在 2^53 之上会悄悄改值，而一条被改了 id 的评论会被贴到别人的行上。
 *
 * **枚举是字符串**（`GithubIssueState.OPEN === "GITHUB_ISSUE_STATE_OPEN"`）。
 * 常量对象还在，所以读的地方仍然写 `GithubIssueState.OPEN`；变的是它的值，从一
 * 个只有生成码才知道的数字变成一个在线上、在库里、在日志里都读得懂的名字。
 *
 * ## 三条和 `request.ts` 一致的规矩
 *
 * 每个响应过 zod；连不上 core 与 core 报错是两类失败；这里不做缓存与重试。
 * 额外一条：域错误的 `code` 被翻成 {@link GithubApiError} 的 `failure`，因为面板
 * 要按「该怎么修」分支，而不是按 HTTP 状态。
 */

import { z } from "zod";

import {
  RuntimeConnectionError,
  RuntimeRequestError,
  request,
} from "./request";

/* -------------------------------------------------------------------------- */
/*                                   枚举                                      */
/* -------------------------------------------------------------------------- */

/**
 * 枚举值就是线上的那个名字。
 *
 * 写成 `as const` 的常量对象 + 同名的联合类型：调用点仍然写
 * `GithubIssueState.OPEN`，而类型是一个字符串联合，不是一个数字。
 */
export const GithubCredentialSource = {
  UNSPECIFIED: "GITHUB_CREDENTIAL_SOURCE_UNSPECIFIED",
  NONE: "GITHUB_CREDENTIAL_SOURCE_NONE",
  GH_CLI: "GITHUB_CREDENTIAL_SOURCE_GH_CLI",
  TOKEN_REF: "GITHUB_CREDENTIAL_SOURCE_TOKEN_REF",
} as const;
export type GithubCredentialSource =
  (typeof GithubCredentialSource)[keyof typeof GithubCredentialSource];

export const GithubSecretStore = {
  UNSPECIFIED: "GITHUB_SECRET_STORE_UNSPECIFIED",
  NONE: "GITHUB_SECRET_STORE_NONE",
  OS_KEYCHAIN: "GITHUB_SECRET_STORE_OS_KEYCHAIN",
  FILE_FALLBACK: "GITHUB_SECRET_STORE_FILE_FALLBACK",
} as const;
export type GithubSecretStore =
  (typeof GithubSecretStore)[keyof typeof GithubSecretStore];

export const GithubIssueState = {
  UNSPECIFIED: "GITHUB_ISSUE_STATE_UNSPECIFIED",
  OPEN: "GITHUB_ISSUE_STATE_OPEN",
  CLOSED: "GITHUB_ISSUE_STATE_CLOSED",
} as const;
export type GithubIssueState =
  (typeof GithubIssueState)[keyof typeof GithubIssueState];

export const GithubIssueStateReason = {
  UNSPECIFIED: "GITHUB_ISSUE_STATE_REASON_UNSPECIFIED",
  COMPLETED: "GITHUB_ISSUE_STATE_REASON_COMPLETED",
  NOT_PLANNED: "GITHUB_ISSUE_STATE_REASON_NOT_PLANNED",
  REOPENED: "GITHUB_ISSUE_STATE_REASON_REOPENED",
  DUPLICATE: "GITHUB_ISSUE_STATE_REASON_DUPLICATE",
} as const;
export type GithubIssueStateReason =
  (typeof GithubIssueStateReason)[keyof typeof GithubIssueStateReason];

export const GithubStatusSource = {
  UNSPECIFIED: "GITHUB_STATUS_SOURCE_UNSPECIFIED",
  NONE: "GITHUB_STATUS_SOURCE_NONE",
  LABEL: "GITHUB_STATUS_SOURCE_LABEL",
  PROJECT_FIELD: "GITHUB_STATUS_SOURCE_PROJECT_FIELD",
} as const;
export type GithubStatusSource =
  (typeof GithubStatusSource)[keyof typeof GithubStatusSource];

export const GithubWriteState = {
  UNSPECIFIED: "GITHUB_WRITE_STATE_UNSPECIFIED",
  APPLIED: "GITHUB_WRITE_STATE_APPLIED",
  PENDING: "GITHUB_WRITE_STATE_PENDING",
  FAILED: "GITHUB_WRITE_STATE_FAILED",
  CONFLICTED: "GITHUB_WRITE_STATE_CONFLICTED",
  SKIPPED: "GITHUB_WRITE_STATE_SKIPPED",
} as const;
export type GithubWriteState =
  (typeof GithubWriteState)[keyof typeof GithubWriteState];

export const GithubPullState = {
  UNSPECIFIED: "GITHUB_PULL_STATE_UNSPECIFIED",
  OPEN: "GITHUB_PULL_STATE_OPEN",
  CLOSED: "GITHUB_PULL_STATE_CLOSED",
  MERGED: "GITHUB_PULL_STATE_MERGED",
} as const;
export type GithubPullState =
  (typeof GithubPullState)[keyof typeof GithubPullState];

export const GithubMergeMethod = {
  UNSPECIFIED: "GITHUB_MERGE_METHOD_UNSPECIFIED",
  MERGE: "GITHUB_MERGE_METHOD_MERGE",
  SQUASH: "GITHUB_MERGE_METHOD_SQUASH",
  REBASE: "GITHUB_MERGE_METHOD_REBASE",
} as const;
export type GithubMergeMethod =
  (typeof GithubMergeMethod)[keyof typeof GithubMergeMethod];

export const GithubMergeableState = {
  UNSPECIFIED: "GITHUB_MERGEABLE_STATE_UNSPECIFIED",
  UNKNOWN: "GITHUB_MERGEABLE_STATE_UNKNOWN",
  MERGEABLE: "GITHUB_MERGEABLE_STATE_MERGEABLE",
  CONFLICTING: "GITHUB_MERGEABLE_STATE_CONFLICTING",
  BLOCKED: "GITHUB_MERGEABLE_STATE_BLOCKED",
} as const;
export type GithubMergeableState =
  (typeof GithubMergeableState)[keyof typeof GithubMergeableState];

export const GithubCheckConclusion = {
  UNSPECIFIED: "GITHUB_CHECK_CONCLUSION_UNSPECIFIED",
  PENDING: "GITHUB_CHECK_CONCLUSION_PENDING",
  SUCCESS: "GITHUB_CHECK_CONCLUSION_SUCCESS",
  FAILURE: "GITHUB_CHECK_CONCLUSION_FAILURE",
  NEUTRAL: "GITHUB_CHECK_CONCLUSION_NEUTRAL",
  CANCELLED: "GITHUB_CHECK_CONCLUSION_CANCELLED",
  SKIPPED: "GITHUB_CHECK_CONCLUSION_SKIPPED",
  TIMED_OUT: "GITHUB_CHECK_CONCLUSION_TIMED_OUT",
  ACTION_REQUIRED: "GITHUB_CHECK_CONCLUSION_ACTION_REQUIRED",
  STALE: "GITHUB_CHECK_CONCLUSION_STALE",
} as const;
export type GithubCheckConclusion =
  (typeof GithubCheckConclusion)[keyof typeof GithubCheckConclusion];

export const GithubReviewState = {
  UNSPECIFIED: "GITHUB_REVIEW_STATE_UNSPECIFIED",
  COMMENTED: "GITHUB_REVIEW_STATE_COMMENTED",
  APPROVED: "GITHUB_REVIEW_STATE_APPROVED",
  CHANGES_REQUESTED: "GITHUB_REVIEW_STATE_CHANGES_REQUESTED",
  DISMISSED: "GITHUB_REVIEW_STATE_DISMISSED",
  PENDING: "GITHUB_REVIEW_STATE_PENDING",
} as const;
export type GithubReviewState =
  (typeof GithubReviewState)[keyof typeof GithubReviewState];

export const GithubReferenceKind = {
  UNSPECIFIED: "GITHUB_REFERENCE_KIND_UNSPECIFIED",
  ISSUE: "GITHUB_REFERENCE_KIND_ISSUE",
  PULL_REQUEST: "GITHUB_REFERENCE_KIND_PULL_REQUEST",
} as const;
export type GithubReferenceKind =
  (typeof GithubReferenceKind)[keyof typeof GithubReferenceKind];

export const GithubReferenceTargetKind = {
  UNSPECIFIED: "GITHUB_REFERENCE_TARGET_KIND_UNSPECIFIED",
  SESSION: "GITHUB_REFERENCE_TARGET_KIND_SESSION",
  BRANCH: "GITHUB_REFERENCE_TARGET_KIND_BRANCH",
  WORKTREE: "GITHUB_REFERENCE_TARGET_KIND_WORKTREE",
} as const;
export type GithubReferenceTargetKind =
  (typeof GithubReferenceTargetKind)[keyof typeof GithubReferenceTargetKind];

/* -------------------------------------------------------------------------- */
/*                              解析的零件                                      */
/* -------------------------------------------------------------------------- */

/** `int64` / `uint64`：线上是十进制字符串，页面要 `bigint`。 */
const bigint = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((value) => BigInt(value))
  .catch(0n)
  .default(0n);

const text = z.string().catch("").default("");
const flag = z.boolean().catch(false).default(false);
const count = z.number().catch(0).default(0);

/**
 * 一个枚举字段。
 *
 * 认不出来的名字落回 `UNSPECIFIED` 而不是让整条记录解析失败：core 比页面新一版
 * 时多出来的那个值，不该让一整页 Issue 消失。
 */
function enumOf<T extends Record<string, string>>(
  values: T,
): z.ZodType<T[keyof T]> {
  const known = new Set<string>(Object.values(values));
  const fallback = values.UNSPECIFIED as string;
  // `preprocess` 而不是 `transform`：后者跟着 `z.unknown()` 会让这个键变成可选，
  // 于是一条没带状态的记录解出来是 `undefined`——那正是这里要避免的那种「缺席」。
  return z.preprocess(
    (value) =>
      typeof value === "string" && known.has(value) ? value : fallback,
    z.string(),
  ) as unknown as z.ZodType<T[keyof T]>;
}

const list = <T>(schema: z.ZodType<T>) => z.array(schema).catch([]).default([]);

/* -------------------------------------------------------------------------- */
/*                                  记录                                       */
/* -------------------------------------------------------------------------- */

export const githubRepositoryRefSchema = z.object({
  owner: text,
  name: text,
  apiBase: text,
  host: text,
});
export type GithubRepositoryRef = z.infer<typeof githubRepositoryRefSchema>;

export const githubUserSchema = z.object({ login: text, id: bigint });
export type GithubUser = z.infer<typeof githubUserSchema>;

export const githubLabelSchema = z.object({ name: text, color: text });
export type GithubLabel = z.infer<typeof githubLabelSchema>;

export const githubMilestoneSchema = z.object({
  number: bigint,
  title: text,
});
export type GithubMilestone = z.infer<typeof githubMilestoneSchema>;

export const githubRateLimitSchema = z.object({
  limit: bigint,
  remaining: bigint,
  resetsAtUnixMs: bigint,
  throttled: flag,
  retryAfterUnixMs: bigint,
});
export type GithubRateLimit = z.infer<typeof githubRateLimitSchema>;

export const githubCredentialStatusSchema = z.object({
  source: enumOf(GithubCredentialSource),
  store: enumOf(GithubSecretStore),
  available: flag,
  apiBase: text,
  enterprise: flag,
  accountLogin: text,
  tokenScopes: list(z.string()),
  checkedAtUnixMs: bigint,
  reasonCode: text,
  revision: bigint,
});
export type GithubCredentialStatus = z.infer<
  typeof githubCredentialStatusSchema
>;

export const githubRepositorySchema = z.object({
  ref: githubRepositoryRefSchema.optional(),
  id: bigint,
  defaultBranch: text,
  private: flag,
  fork: flag,
  hasIssues: flag,
  allowedMergeMethods: list(enumOf(GithubMergeMethod)),
  permission: text,
  observedAtUnixMs: bigint,
});
export type GithubRepository = z.infer<typeof githubRepositorySchema>;

export const resolveGithubRepositoryResponseSchema = z.object({
  repository: githubRepositorySchema.optional(),
  hostMismatch: flag,
  reasonCode: text,
  rateLimit: githubRateLimitSchema.optional(),
});
export type ResolveGithubRepositoryResponse = z.infer<
  typeof resolveGithubRepositoryResponseSchema
>;

export const githubIssueSchema = z.object({
  repository: githubRepositoryRefSchema.optional(),
  number: bigint,
  id: bigint,
  title: text,
  body: text,
  state: enumOf(GithubIssueState),
  stateReason: enumOf(GithubIssueStateReason),
  author: githubUserSchema.optional(),
  assignees: list(githubUserSchema),
  labels: list(githubLabelSchema),
  milestone: githubMilestoneSchema.optional(),
  commentCount: bigint,
  createdAtUnixMs: bigint,
  updatedAtUnixMs: bigint,
  closedAtUnixMs: bigint,
  htmlUrl: text,
  statusGroupId: text,
  statusConflict: flag,
  observedAtUnixMs: bigint,
});
export type GithubIssue = z.infer<typeof githubIssueSchema>;

export const githubCommentSchema = z.object({
  id: bigint,
  author: githubUserSchema.optional(),
  body: text,
  createdAtUnixMs: bigint,
  updatedAtUnixMs: bigint,
  htmlUrl: text,
});
export type GithubComment = z.infer<typeof githubCommentSchema>;

export const githubIssueFilterSchema = z.object({
  state: enumOf(GithubIssueState),
  labels: list(z.string()),
  assignee: text,
  author: text,
  milestoneNumber: bigint,
  query: text,
});
export type GithubIssueFilter = z.infer<typeof githubIssueFilterSchema>;

/** 只写出现的字段。标签与指派人整组替换时才带 `replace*`。 */
export interface GithubIssuePatch {
  title?: string;
  body?: string;
  replaceLabels: boolean;
  labels: string[];
  replaceAssignees: boolean;
  assignees: string[];
  milestoneNumber?: bigint;
}

export const githubStatusGroupSchema = z.object({
  id: text,
  title: text,
  label: text,
  projectOptionId: text,
  couplesIssueState: enumOf(GithubIssueState),
});
export type GithubStatusGroup = z.infer<typeof githubStatusGroupSchema>;

export const githubStateCouplingSchema = z.object({
  state: enumOf(GithubIssueState),
  groupId: text,
});
export type GithubStateCoupling = z.infer<typeof githubStateCouplingSchema>;

export const githubStatusMappingSchema = z.object({
  repository: githubRepositoryRefSchema.optional(),
  source: enumOf(GithubStatusSource),
  projectId: text,
  projectFieldId: text,
  groups: list(githubStatusGroupSchema),
  stateGroups: list(githubStateCouplingSchema),
  revision: bigint,
  updatedAtUnixMs: bigint,
});
export type GithubStatusMapping = z.infer<typeof githubStatusMappingSchema>;

export const githubWriteOutcomeSchema = z.object({
  actionId: text,
  target: text,
  state: enumOf(GithubWriteState),
  reasonCode: text,
  previousValue: text,
  requestedValue: text,
});
export type GithubWriteOutcome = z.infer<typeof githubWriteOutcomeSchema>;

export const githubCheckRunSchema = z.object({
  name: text,
  app: text,
  conclusion: enumOf(GithubCheckConclusion),
  detailsUrl: text,
  startedAtUnixMs: bigint,
  completedAtUnixMs: bigint,
  rerunnable: flag,
  workflowRunId: bigint,
});
export type GithubCheckRun = z.infer<typeof githubCheckRunSchema>;

export const githubCheckSummarySchema = z.object({
  headSha: text,
  runs: list(githubCheckRunSchema),
  rollup: enumOf(GithubCheckConclusion),
  observedAtUnixMs: bigint,
});
export type GithubCheckSummary = z.infer<typeof githubCheckSummarySchema>;

export const githubReviewSchema = z.object({
  id: bigint,
  author: githubUserSchema.optional(),
  state: enumOf(GithubReviewState),
  body: text,
  commitSha: text,
  submittedAtUnixMs: bigint,
});
export type GithubReview = z.infer<typeof githubReviewSchema>;

export const githubReviewCommentSchema = z.object({
  id: bigint,
  author: githubUserSchema.optional(),
  body: text,
  path: text,
  commitSha: text,
  line: bigint,
  side: text,
  outdated: flag,
  createdAtUnixMs: bigint,
});
export type GithubReviewComment = z.infer<typeof githubReviewCommentSchema>;

/** 一条还没提交的行内评审意见。 */
export interface GithubReviewCommentDraft {
  path: string;
  line: bigint;
  side: string;
  body: string;
}

export const githubPullFileSchema = z.object({
  path: text,
  previousPath: text,
  status: text,
  additions: bigint,
  deletions: bigint,
  binary: flag,
  patch: text,
});
export type GithubPullFile = z.infer<typeof githubPullFileSchema>;

export const githubPullRequestSchema = z.object({
  repository: githubRepositoryRefSchema.optional(),
  number: bigint,
  id: bigint,
  title: text,
  body: text,
  state: enumOf(GithubPullState),
  draft: flag,
  author: githubUserSchema.optional(),
  baseRef: text,
  headRef: text,
  headSha: text,
  headRepoFullName: text,
  fromFork: flag,
  mergeable: enumOf(GithubMergeableState),
  allowedMergeMethods: list(enumOf(GithubMergeMethod)),
  additions: bigint,
  deletions: bigint,
  changedFiles: bigint,
  commits: bigint,
  requestedReviewers: list(githubUserSchema),
  labels: list(githubLabelSchema),
  createdAtUnixMs: bigint,
  updatedAtUnixMs: bigint,
  mergedAtUnixMs: bigint,
  closedAtUnixMs: bigint,
  htmlUrl: text,
  observedAtUnixMs: bigint,
});
export type GithubPullRequest = z.infer<typeof githubPullRequestSchema>;

export const githubPullFilterSchema = z.object({
  state: enumOf(GithubPullState),
  author: text,
  baseRef: text,
  reviewRequested: text,
  draftOnly: flag,
});
export type GithubPullFilter = z.infer<typeof githubPullFilterSchema>;

export const githubExternalReferenceSchema = z.object({
  referenceId: text,
  workspaceId: text,
  repository: githubRepositoryRefSchema.optional(),
  kind: enumOf(GithubReferenceKind),
  number: bigint,
  targetKind: enumOf(GithubReferenceTargetKind),
  targetId: text,
  title: text,
  revision: bigint,
  createdAtUnixMs: bigint,
  updatedAtUnixMs: bigint,
});
export type GithubExternalReference = z.infer<
  typeof githubExternalReferenceSchema
>;

export const listGithubIssuesResponseSchema = z.object({
  issues: list(githubIssueSchema),
  nextCursor: text,
  hasMore: flag,
  rateLimit: githubRateLimitSchema.optional(),
  fromCache: flag,
  observedAtUnixMs: bigint,
  pollIntervalMs: bigint,
});
export type ListGithubIssuesResponse = z.infer<
  typeof listGithubIssuesResponseSchema
>;

export const getGithubIssueResponseSchema = z.object({
  issue: githubIssueSchema.optional(),
  comments: list(githubCommentSchema),
  references: list(githubExternalReferenceSchema),
  rateLimit: githubRateLimitSchema.optional(),
  pollIntervalMs: bigint,
});
export type GetGithubIssueResponse = z.infer<
  typeof getGithubIssueResponseSchema
>;

export const moveGithubIssueResponseSchema = z.object({
  issue: githubIssueSchema.optional(),
  outcomes: list(githubWriteOutcomeSchema),
  rateLimit: githubRateLimitSchema.optional(),
});
export type MoveGithubIssueResponse = z.infer<
  typeof moveGithubIssueResponseSchema
>;

export const listGithubPullsResponseSchema = z.object({
  pulls: list(githubPullRequestSchema),
  nextCursor: text,
  hasMore: flag,
  rateLimit: githubRateLimitSchema.optional(),
  fromCache: flag,
  observedAtUnixMs: bigint,
  pollIntervalMs: bigint,
});
export type ListGithubPullsResponse = z.infer<
  typeof listGithubPullsResponseSchema
>;

export const getGithubPullResponseSchema = z.object({
  pull: githubPullRequestSchema.optional(),
  files: list(githubPullFileSchema),
  reviews: list(githubReviewSchema),
  reviewComments: list(githubReviewCommentSchema),
  comments: list(githubCommentSchema),
  checks: githubCheckSummarySchema.optional(),
  references: list(githubExternalReferenceSchema),
  rateLimit: githubRateLimitSchema.optional(),
  pollIntervalMs: bigint,
});
export type GetGithubPullResponse = z.infer<typeof getGithubPullResponseSchema>;

export const mergeGithubPullResponseSchema = z.object({
  merged: flag,
  mergeSha: text,
  reasonCode: text,
  pull: githubPullRequestSchema.optional(),
  checks: githubCheckSummarySchema.optional(),
});
export type MergeGithubPullResponse = z.infer<
  typeof mergeGithubPullResponseSchema
>;

export const rerunGithubChecksResponseSchema = z.object({
  outcomes: list(githubWriteOutcomeSchema),
  reasonCode: text,
  checks: githubCheckSummarySchema.optional(),
  rateLimit: githubRateLimitSchema.optional(),
});
export type RerunGithubChecksResponse = z.infer<
  typeof rerunGithubChecksResponseSchema
>;

export const deleteGithubBranchResponseSchema = z.object({
  deleted: flag,
  reasonCode: text,
});
export type DeleteGithubBranchResponse = z.infer<
  typeof deleteGithubBranchResponseSchema
>;

export const listGithubReferencesResponseSchema = z.object({
  references: list(githubExternalReferenceSchema),
  nextId: text,
  hasMore: flag,
});
export type ListGithubReferencesResponse = z.infer<
  typeof listGithubReferencesResponseSchema
>;

export const unlinkGithubReferenceResponseSchema = z.object({
  unlinked: flag,
});

/* -------------------------------------------------------------------------- */
/*                              空记录的工厂                                    */
/* -------------------------------------------------------------------------- */

/**
 * 一份全零的记录，可选地盖上几个字段。
 *
 * 取代从前的 `create(XSchema, { … })`：protobuf-es 的 `create` 做的就是这件事
 * ——把没给的标量字段填成零值。所以这里是同一个语义，只是不需要一份 schema 描述符。
 */
const zero =
  <T>(base: T) =>
  (init: Partial<T> = {}): T => ({ ...base, ...init });

export const githubRepositoryRef = zero<GithubRepositoryRef>({
  owner: "",
  name: "",
  apiBase: "",
  host: "",
});

export const githubIssueFilter = zero<GithubIssueFilter>({
  state: GithubIssueState.UNSPECIFIED,
  labels: [],
  assignee: "",
  author: "",
  milestoneNumber: 0n,
  query: "",
});

export const githubPullFilter = zero<GithubPullFilter>({
  state: GithubPullState.UNSPECIFIED,
  author: "",
  baseRef: "",
  reviewRequested: "",
  draftOnly: false,
});

export const githubIssuePatch = zero<GithubIssuePatch>({
  replaceLabels: false,
  labels: [],
  replaceAssignees: false,
  assignees: [],
});

export const githubStatusGroup = zero<GithubStatusGroup>({
  id: "",
  title: "",
  label: "",
  projectOptionId: "",
  couplesIssueState: GithubIssueState.UNSPECIFIED,
});

export const githubStateCoupling = zero<GithubStateCoupling>({
  state: GithubIssueState.UNSPECIFIED,
  groupId: "",
});

export const githubStatusMapping = zero<GithubStatusMapping>({
  source: GithubStatusSource.UNSPECIFIED,
  projectId: "",
  projectFieldId: "",
  groups: [],
  stateGroups: [],
  revision: 0n,
  updatedAtUnixMs: 0n,
});

export const githubExternalReference = zero<GithubExternalReference>({
  referenceId: "",
  workspaceId: "",
  kind: GithubReferenceKind.UNSPECIFIED,
  number: 0n,
  targetKind: GithubReferenceTargetKind.UNSPECIFIED,
  targetId: "",
  title: "",
  revision: 0n,
  createdAtUnixMs: 0n,
  updatedAtUnixMs: 0n,
});

export const githubIssue = zero<GithubIssue>({
  number: 0n,
  id: 0n,
  title: "",
  body: "",
  state: GithubIssueState.UNSPECIFIED,
  stateReason: GithubIssueStateReason.UNSPECIFIED,
  assignees: [],
  labels: [],
  commentCount: 0n,
  createdAtUnixMs: 0n,
  updatedAtUnixMs: 0n,
  closedAtUnixMs: 0n,
  htmlUrl: "",
  statusGroupId: "",
  statusConflict: false,
  observedAtUnixMs: 0n,
});

export const githubPullRequest = zero<GithubPullRequest>({
  number: 0n,
  id: 0n,
  title: "",
  body: "",
  state: GithubPullState.UNSPECIFIED,
  draft: false,
  baseRef: "",
  headRef: "",
  headSha: "",
  headRepoFullName: "",
  fromFork: false,
  mergeable: GithubMergeableState.UNSPECIFIED,
  allowedMergeMethods: [],
  additions: 0n,
  deletions: 0n,
  changedFiles: 0n,
  commits: 0n,
  requestedReviewers: [],
  labels: [],
  createdAtUnixMs: 0n,
  updatedAtUnixMs: 0n,
  mergedAtUnixMs: 0n,
  closedAtUnixMs: 0n,
  htmlUrl: "",
  observedAtUnixMs: 0n,
});

export const resolveGithubRepositoryResponse =
  zero<ResolveGithubRepositoryResponse>({
    hostMismatch: false,
    reasonCode: "",
  });

export const githubRepository = zero<GithubRepository>({
  id: 0n,
  defaultBranch: "",
  private: false,
  fork: false,
  hasIssues: false,
  allowedMergeMethods: [],
  permission: "",
  observedAtUnixMs: 0n,
});

export const githubCredentialStatus = zero<GithubCredentialStatus>({
  source: GithubCredentialSource.UNSPECIFIED,
  store: GithubSecretStore.UNSPECIFIED,
  available: false,
  apiBase: "",
  enterprise: false,
  accountLogin: "",
  tokenScopes: [],
  checkedAtUnixMs: 0n,
  reasonCode: "",
  revision: 0n,
});

export const githubCheckRun = zero<GithubCheckRun>({
  name: "",
  app: "",
  conclusion: GithubCheckConclusion.UNSPECIFIED,
  detailsUrl: "",
  startedAtUnixMs: 0n,
  completedAtUnixMs: 0n,
  rerunnable: false,
  workflowRunId: 0n,
});

export const githubCheckSummary = zero<GithubCheckSummary>({
  headSha: "",
  runs: [],
  rollup: GithubCheckConclusion.UNSPECIFIED,
  observedAtUnixMs: 0n,
});

export const githubReviewComment = zero<GithubReviewComment>({
  id: 0n,
  body: "",
  path: "",
  commitSha: "",
  line: 0n,
  side: "",
  outdated: false,
  createdAtUnixMs: 0n,
});

/* -------------------------------------------------------------------------- */
/*                                  错误                                       */
/* -------------------------------------------------------------------------- */

/**
 * 出了什么事，按**面板能做什么**分档。
 *
 * `rateLimited` 和 `network` 分开，因为前者的修法是等；`unsupported` 和
 * `permission` 分开，因为一个是「这台 core 没有 GitHub 凭据」，另一个是「这台
 * 设备不能用它」。档位与从前的 `HostGithubError.failure` 逐个对齐。
 */
export type GithubApiFailure =
  | "invalid"
  | "unauthenticated"
  | "permission"
  | "unsupported"
  | "notFound"
  | "conflict"
  | "rateLimited"
  | "response"
  | "cancelled"
  | "network";

export class GithubApiError extends Error {
  readonly name = "GithubApiError";
  constructor(
    readonly failure: GithubApiFailure,
    /** 一次到达了 core 而结果没有被读到的写。永远不降级成「失败」。 */
    readonly outcomeUnknown = false,
    readonly httpStatus?: number,
    readonly hostCode?: string,
  ) {
    super(`GitHub request failed (${failure}).`);
  }
}

/**
 * 传输层的拒绝 → 一次修复。
 *
 * 认不出来的 `code` 留在 `network`，不软化成 `invalid`：一次结果没被读到的写必须
 * 让调用方重新读，而不是重试。
 */
export function classifyGithubFailure(error: unknown): GithubApiError {
  if (error instanceof GithubApiError) return error;
  if (error instanceof RuntimeConnectionError)
    return new GithubApiError("network");
  if (!(error instanceof RuntimeRequestError))
    return new GithubApiError("network");
  const code = error.code ?? "";
  const fail = (failure: GithubApiFailure, outcomeUnknown = false) =>
    new GithubApiError(failure, outcomeUnknown, error.status, code);
  switch (code) {
    case "UNAUTHENTICATED":
      return fail("unauthenticated");
    case "PERMISSION_DENIED":
      return fail("permission");
    case "UNSUPPORTED":
      return fail("unsupported");
    case "NOT_FOUND":
      return fail("notFound");
    case "CONFLICT":
      return fail("conflict");
    case "RESOURCE_EXHAUSTED":
      return fail("rateLimited");
    case "INVALID_ARGUMENT":
      return fail("invalid");
    case "UNKNOWN_OUTCOME":
      return fail("network", true);
    default:
      return fail("network");
  }
}

/* -------------------------------------------------------------------------- */
/*                                  客户端                                     */
/* -------------------------------------------------------------------------- */

/** `bigint` 在 JSON 里是十进制字符串——`JSON.stringify` 自己不认它。 */
function body(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
}

/** 一页最多一百条：再多的正文装不进一次合理的响应。 */
export const MAX_PAGE = 100;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export interface GithubApiOptions {
  readonly workspaceId: string;
}

/**
 * core 的 GitHub 面，带类型。
 *
 * 没有任何方法见得到令牌：凭据在 core 手里，这里只说要操作哪个仓库。响应在到达
 * 界面之前过一遍 zod——一份半解开的 PR 画在合并按钮旁边，等于替 core 说了它没说
 * 过的话。
 */
export class GithubApi {
  readonly #workspaceId: string;

  constructor(options: GithubApiOptions) {
    if (!idPattern.test(options?.workspaceId ?? "")) {
      throw new GithubApiError("invalid");
    }
    this.#workspaceId = options.workspaceId;
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }

  async #call<T>(
    verb: string,
    input: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    try {
      return await request(
        `/api/github/${verb}?workspaceId=${encodeURIComponent(this.#workspaceId)}`,
        schema,
        { method: "POST", body: body(input ?? {}) },
      );
    } catch (error) {
      if (error instanceof z.ZodError) throw new GithubApiError("response");
      throw classifyGithubFailure(error);
    }
  }

  /* ------------------------------------------------------------ 凭据 */

  /** 从不返回令牌；只说配了哪一种来源，以及它现在能不能用。 */
  getCredential(): Promise<GithubCredentialStatus> {
    return this.#call("get-credential", {}, githubCredentialStatusSchema);
  }

  /**
   * `token` 是这一面上唯一会外发的值，而且只对 TOKEN_REF。它不在这里留存，
   * core 答的是一份状态，不是一次回声。
   */
  configureCredential(input: {
    source: GithubCredentialSource;
    token?: string;
    apiBase?: string;
    expectedRevision: bigint;
  }): Promise<GithubCredentialStatus> {
    return this.#call(
      "configure-credential",
      {
        source: input.source,
        token: input.token ?? "",
        apiBase: input.apiBase ?? "",
        expectedRevision: input.expectedRevision,
      },
      githubCredentialStatusSchema,
    );
  }

  revokeCredential(input: {
    expectedRevision: bigint;
  }): Promise<GithubCredentialStatus> {
    return this.#call(
      "revoke-credential",
      { expectedRevision: input.expectedRevision },
      githubCredentialStatusSchema,
    );
  }

  /* ------------------------------------------------------------ 仓库 */

  resolveRepository(
    remoteUrl: string,
  ): Promise<ResolveGithubRepositoryResponse> {
    return this.#call(
      "resolve-repository",
      { remoteUrl },
      resolveGithubRepositoryResponseSchema,
    );
  }

  /* ------------------------------------------------------------ Issue */

  listIssues(input: {
    repository: GithubRepositoryRef;
    filter?: GithubIssueFilter;
    afterCursor?: string;
    limit?: number;
  }): Promise<ListGithubIssuesResponse> {
    return this.#call(
      "list-issues",
      {
        repository: input.repository,
        filter: input.filter,
        afterCursor: input.afterCursor ?? "",
        limit: Math.min(input.limit ?? MAX_PAGE, MAX_PAGE),
      },
      listGithubIssuesResponseSchema,
    );
  }

  getIssue(input: {
    repository: GithubRepositoryRef;
    number: bigint;
  }): Promise<GetGithubIssueResponse> {
    return this.#call("get-issue", input, getGithubIssueResponseSchema);
  }

  createIssue(input: {
    repository: GithubRepositoryRef;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
    milestoneNumber?: bigint;
  }): Promise<GithubIssue> {
    return this.#call(
      "create-issue",
      {
        repository: input.repository,
        title: input.title,
        body: input.body ?? "",
        labels: input.labels ?? [],
        assignees: input.assignees ?? [],
        milestoneNumber: input.milestoneNumber ?? 0n,
      },
      githubIssueSchema,
    );
  }

  /**
   * GitHub 没有原子版本锁，所以调用方把它显示过的 `updatedAt` 带上，core 写之前
   * 再读一次。
   */
  updateIssue(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    patch: GithubIssuePatch;
    expectedUpdatedAtUnixMs: bigint;
  }): Promise<GithubIssue> {
    return this.#call("update-issue", input, githubIssueSchema);
  }

  /** 关闭与重开。移动到 Done 组是另一个调用，这是刻意的。 */
  setIssueState(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    state: GithubIssueState;
    reason?: GithubIssueStateReason;
    expectedUpdatedAtUnixMs: bigint;
  }): Promise<GithubIssue> {
    return this.#call(
      "set-issue-state",
      { ...input, reason: input.reason ?? GithubIssueStateReason.UNSPECIFIED },
      githubIssueSchema,
    );
  }

  commentIssue(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    body: string;
  }): Promise<GithubComment> {
    return this.#call("comment-issue", input, githubCommentSchema);
  }

  /* ------------------------------------------------------------ 状态映射 */

  getStatusMapping(
    repository: GithubRepositoryRef,
  ): Promise<GithubStatusMapping> {
    return this.#call(
      "get-status-mapping",
      { repository },
      githubStatusMappingSchema,
    );
  }

  putStatusMapping(input: {
    mapping: GithubStatusMapping;
    expectedRevision: bigint;
  }): Promise<GithubStatusMapping> {
    return this.#call("put-status-mapping", input, githubStatusMappingSchema);
  }

  /** 在配置好的组之间移动一条 Issue；其余标签一个不动。 */
  moveIssue(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    toGroupId: string;
    fromGroupId?: string;
    expectedUpdatedAtUnixMs: bigint;
    expectedMappingRevision: bigint;
  }): Promise<MoveGithubIssueResponse> {
    return this.#call(
      "move-issue",
      { ...input, fromGroupId: input.fromGroupId ?? "" },
      moveGithubIssueResponseSchema,
    );
  }

  /* ------------------------------------------------------------ PR */

  listPulls(input: {
    repository: GithubRepositoryRef;
    filter?: GithubPullFilter;
    afterCursor?: string;
    limit?: number;
  }): Promise<ListGithubPullsResponse> {
    return this.#call(
      "list-pulls",
      {
        repository: input.repository,
        filter: input.filter,
        afterCursor: input.afterCursor ?? "",
        limit: Math.min(input.limit ?? MAX_PAGE, MAX_PAGE),
      },
      listGithubPullsResponseSchema,
    );
  }

  getPull(input: {
    repository: GithubRepositoryRef;
    number: bigint;
  }): Promise<GetGithubPullResponse> {
    return this.#call("get-pull", input, getGithubPullResponseSchema);
  }

  createPull(input: {
    repository: GithubRepositoryRef;
    baseRef: string;
    headRef: string;
    title: string;
    body?: string;
    draft?: boolean;
    linkedIssueNumber?: bigint;
    expectedHeadSha?: string;
  }): Promise<GithubPullRequest> {
    return this.#call(
      "create-pull",
      {
        ...input,
        body: input.body ?? "",
        draft: input.draft ?? false,
        linkedIssueNumber: input.linkedIssueNumber ?? 0n,
        expectedHeadSha: input.expectedHeadSha ?? "",
      },
      githubPullRequestSchema,
    );
  }

  submitReview(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    commitSha: string;
    state: GithubReviewState;
    body?: string;
    comments?: GithubReviewCommentDraft[];
  }): Promise<GithubReview> {
    return this.#call(
      "submit-review",
      { ...input, body: input.body ?? "", comments: input.comments ?? [] },
      githubReviewSchema,
    );
  }

  getChecks(input: {
    repository: GithubRepositoryRef;
    number: bigint;
  }): Promise<GithubCheckSummary> {
    return this.#call("get-checks", input, githubCheckSummarySchema);
  }

  /**
   * 按面板显示过的那个 head 合并。把读者看到的检查汇总一起带上，core 才能在检查
   * 变了的时候拒绝——本地一屏绿色不是远端仍然会接受这次合并的承诺。
   */
  mergePull(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    expectedHeadSha: string;
    method: GithubMergeMethod;
    commitTitle?: string;
    commitMessage?: string;
    expectedCheckRollup?: GithubCheckConclusion;
  }): Promise<MergeGithubPullResponse> {
    return this.#call(
      "merge-pull",
      {
        ...input,
        commitTitle: input.commitTitle ?? "",
        commitMessage: input.commitMessage ?? "",
        expectedCheckRollup:
          input.expectedCheckRollup ?? GithubCheckConclusion.UNSPECIFIED,
      },
      mergeGithubPullResponseSchema,
    );
  }

  /** 重跑面板显示过的那个 head 上可重跑的检查。 */
  rerunChecks(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    expectedHeadSha: string;
    checkName?: string;
    failedOnly?: boolean;
  }): Promise<RerunGithubChecksResponse> {
    return this.#call(
      "rerun-checks",
      {
        ...input,
        checkName: input.checkName ?? "",
        failedOnly: input.failedOnly ?? false,
      },
      rerunGithubChecksResponseSchema,
    );
  }

  /** 删一条远端分支。和合并分开：清理是读者的决定，而且它不碰本地任何东西。 */
  deleteBranch(input: {
    repository: GithubRepositoryRef;
    branch: string;
    expectedSha: string;
  }): Promise<DeleteGithubBranchResponse> {
    return this.#call("delete-branch", input, deleteGithubBranchResponseSchema);
  }

  /* ------------------------------------------------------------ 连接 */

  linkReference(input: {
    reference: GithubExternalReference;
    expectedRevision: bigint;
  }): Promise<GithubExternalReference> {
    return this.#call("link-reference", input, githubExternalReferenceSchema);
  }

  async unlinkReference(input: {
    referenceId: string;
    expectedRevision: bigint;
  }): Promise<void> {
    await this.#call(
      "unlink-reference",
      input,
      unlinkGithubReferenceResponseSchema,
    );
  }

  listReferences(
    input: { targetId?: string; afterId?: string; limit?: number } = {},
  ): Promise<ListGithubReferencesResponse> {
    return this.#call(
      "list-references",
      {
        targetId: input.targetId ?? "",
        afterId: input.afterId ?? "",
        limit: Math.min(input.limit ?? MAX_PAGE, MAX_PAGE),
      },
      listGithubReferencesResponseSchema,
    );
  }
}

export const githubApi = {
  /** 一块工作空间上的 GitHub 面。工作空间不合法就在这里被拒。 */
  openGithub: (workspaceId: string) => new GithubApi({ workspaceId }),
};
