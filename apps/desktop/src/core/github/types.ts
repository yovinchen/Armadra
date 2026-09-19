/**
 * GitHub 域自己的类型。
 *
 * R7 之前这些形状由 `proto/armadra/v1/github.proto` 说了算，类型从
 * `packages/protocol` 的生成码来。那些文件在 R7 删掉，所以这个域的记录长什么
 * 样，从这里往后由**本文件**回答；线上的字节由 `docs/contracts/core-json-api.md`
 * §5 回答，页面那一侧逐条列在 `apps/web/src/api/github.ts` 的 zod 里。三处说的是
 * 同一件事。
 *
 * 两条要紧的：
 *
 *   * **枚举的值就是它的名字**（`"GITHUB_ISSUE_STATE_OPEN"`）。页面按名字分支，
 *     所以这些字符串是契约；让内存里也是名字，编码这一步就没有一张会对错的表。
 *   * **`int64` 是 `bigint`**。Issue 编号、id 与时间戳都是 64 位，`number` 在
 *     2^53 之上会悄悄改值——一条被改了 id 的评论会被贴到别人的行上。
 *
 * 字段表在 `schema.ts`，编解码在 `../contract/message`。本文件只管类型。
 */

/* ---------------------------------- 枚举 ---------------------------------- */

export const GithubCredentialSource = {
  UNSPECIFIED: "GITHUB_CREDENTIAL_SOURCE_UNSPECIFIED",
  /** 什么都没配。面板是「不可用」，不是「空的」。 */
  NONE: "GITHUB_CREDENTIAL_SOURCE_NONE",
  /** 用户明确同意复用已有的 `gh` 登录：令牌现取现用，从不落盘。 */
  GH_CLI: "GITHUB_CREDENTIAL_SOURCE_GH_CLI",
  /** 粘过来一次的令牌，按引用名存在 OS 密钥库里。 */
  TOKEN_REF: "GITHUB_CREDENTIAL_SOURCE_TOKEN_REF",
} as const;
export type GithubCredentialSource =
  (typeof GithubCredentialSource)[keyof typeof GithubCredentialSource];

export const GithubSecretStore = {
  UNSPECIFIED: "GITHUB_SECRET_STORE_UNSPECIFIED",
  NONE: "GITHUB_SECRET_STORE_NONE",
  OS_KEYCHAIN: "GITHUB_SECRET_STORE_OS_KEYCHAIN",
  /** 没有 OS 密钥库时的 0600 文件回退。报出来，让人看见保护弱了。 */
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
  /** 精确的标签名映射到分组。 */
  LABEL: "GITHUB_STATUS_SOURCE_LABEL",
  /** Projects v2 的 Status 字段选项映射到分组。 */
  PROJECT_FIELD: "GITHUB_STATUS_SOURCE_PROJECT_FIELD",
} as const;
export type GithubStatusSource =
  (typeof GithubStatusSource)[keyof typeof GithubStatusSource];

export const GithubWriteState = {
  UNSPECIFIED: "GITHUB_WRITE_STATE_UNSPECIFIED",
  APPLIED: "GITHUB_WRITE_STATE_APPLIED",
  /** 发出去了，结果没读到。永远不显示成成功。 */
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
  /** 远端还没算出来。永远不渲染成「可以合」。 */
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

/* -------------------------------- 凭据与仓库 ------------------------------- */

/** 永远不含令牌。`accountLogin` 与 `tokenScopes` 描述的是那份凭据能做什么。 */
export interface GithubCredentialStatus {
  source: GithubCredentialSource;
  store: GithubSecretStore;
  available: boolean;
  apiBase: string;
  enterprise: boolean;
  accountLogin: string;
  tokenScopes: string[];
  checkedAtUnixMs: bigint;
  reasonCode: string;
  revision: bigint;
}

/** 这个动词没有自己的参数：工作空间在查询串上，身份只来自会话。 */
export type GetGithubCredentialRequest = Record<string, never>;

export interface ConfigureGithubCredentialRequest {
  source: GithubCredentialSource;
  /** 这一面上唯一会外发的值，而且只是入站。永远不回声、不记日志。 */
  token: string;
  apiBase: string;
  expectedRevision: bigint;
}

export interface RevokeGithubCredentialRequest {
  expectedRevision: bigint;
}

/** 一个 API base 上的一个仓库。base 跟着引用走，一次调用改不了目标服务。 */
export interface GithubRepositoryRef {
  owner: string;
  name: string;
  apiBase: string;
  host: string;
}

export interface GithubRepository {
  ref?: GithubRepositoryRef;
  id: bigint;
  defaultBranch: string;
  private: boolean;
  fork: boolean;
  hasIssues: boolean;
  allowedMergeMethods: GithubMergeMethod[];
  permission: string;
  observedAtUnixMs: bigint;
}

export interface ResolveGithubRepositoryRequest {
  remoteUrl: string;
}

export interface ResolveGithubRepositoryResponse {
  repository?: GithubRepository;
  hostMismatch: boolean;
  reasonCode: string;
  rateLimit?: GithubRateLimit;
}

/** 限流与配额，照远端报的样子。面板据此说「为什么现在不刷新」。 */
export interface GithubRateLimit {
  limit: bigint;
  remaining: bigint;
  resetsAtUnixMs: bigint;
  throttled: boolean;
  retryAfterUnixMs: bigint;
}

/* ---------------------------------- Issue --------------------------------- */

export interface GithubUser {
  login: string;
  id: bigint;
}

export interface GithubLabel {
  name: string;
  color: string;
}

export interface GithubMilestone {
  number: bigint;
  title: string;
}

export interface GithubIssue {
  repository?: GithubRepositoryRef;
  number: bigint;
  id: bigint;
  title: string;
  /** 外部内容。作为资料呈现，从不作为指令。 */
  body: string;
  state: GithubIssueState;
  stateReason: GithubIssueStateReason;
  author?: GithubUser;
  assignees: GithubUser[];
  labels: GithubLabel[];
  milestone?: GithubMilestone;
  commentCount: bigint;
  createdAtUnixMs: bigint;
  updatedAtUnixMs: bigint;
  closedAtUnixMs: bigint;
  htmlUrl: string;
  statusGroupId: string;
  /** 配置里不止一条规则命中。面板显示冲突，而不是替人选一个。 */
  statusConflict: boolean;
  observedAtUnixMs: bigint;
}

export interface GithubComment {
  id: bigint;
  author?: GithubUser;
  body: string;
  createdAtUnixMs: bigint;
  updatedAtUnixMs: bigint;
  htmlUrl: string;
}

export interface GithubIssueFilter {
  state: GithubIssueState;
  labels: string[];
  assignee: string;
  author: string;
  milestoneNumber: bigint;
  query: string;
}

export interface ListGithubIssuesRequest {
  repository?: GithubRepositoryRef;
  filter?: GithubIssueFilter;
  /** core 自己的游标，从不是一条裸的远端 URL。 */
  afterCursor: string;
  limit: number;
}

export interface ListGithubIssuesResponse {
  issues: GithubIssue[];
  nextCursor: string;
  hasMore: boolean;
  rateLimit?: GithubRateLimit;
  fromCache: boolean;
  observedAtUnixMs: bigint;
  pollIntervalMs: bigint;
}

export interface GetGithubIssueRequest {
  repository?: GithubRepositoryRef;
  number: bigint;
}

export interface GetGithubIssueResponse {
  issue?: GithubIssue;
  comments: GithubComment[];
  references: GithubExternalReference[];
  rateLimit?: GithubRateLimit;
  pollIntervalMs: bigint;
}

export interface CreateGithubIssueRequest {
  repository?: GithubRepositoryRef;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  milestoneNumber: bigint;
}

/** 只写给出来的字段。标签与指派人整组替换，所以一次编辑不会悄悄丢掉别人加的。 */
export interface GithubIssuePatch {
  title?: string;
  body?: string;
  replaceLabels: boolean;
  labels: string[];
  replaceAssignees: boolean;
  assignees: string[];
  milestoneNumber?: bigint;
}

export interface UpdateGithubIssueRequest {
  repository?: GithubRepositoryRef;
  number: bigint;
  patch?: GithubIssuePatch;
  /** 面板显示的那个 updatedAt。远端往前走了就拒绝，而不是覆盖。 */
  expectedUpdatedAtUnixMs: bigint;
}

export interface SetGithubIssueStateRequest {
  repository?: GithubRepositoryRef;
  number: bigint;
  state: GithubIssueState;
  reason: GithubIssueStateReason;
  expectedUpdatedAtUnixMs: bigint;
}

export interface CommentGithubIssueRequest {
  repository?: GithubRepositoryRef;
  number: bigint;
  body: string;
}

/* --------------------------------- 状态映射 -------------------------------- */

export interface GithubStatusGroup {
  id: string;
  title: string;
  label: string;
  projectOptionId: string;
  couplesIssueState: GithubIssueState;
}

export interface GithubStateCoupling {
  state: GithubIssueState;
  groupId: string;
}

export interface GithubStatusMapping {
  repository?: GithubRepositoryRef;
  source: GithubStatusSource;
  projectId: string;
  projectFieldId: string;
  groups: GithubStatusGroup[];
  stateGroups: GithubStateCoupling[];
  revision: bigint;
  updatedAtUnixMs: bigint;
}

export interface GetGithubStatusMappingRequest {
  repository?: GithubRepositoryRef;
}

export interface PutGithubStatusMappingRequest {
  mapping?: GithubStatusMapping;
  expectedRevision: bigint;
}

/** 组合移动里的一次写，单独报，这样半成功是看得见、修得了的。 */
export interface GithubWriteOutcome {
  actionId: string;
  target: string;
  state: GithubWriteState;
  reasonCode: string;
  previousValue: string;
  requestedValue: string;
}

export interface MoveGithubIssueRequest {
  repository?: GithubRepositoryRef;
  number: bigint;
  toGroupId: string;
  fromGroupId: string;
  expectedUpdatedAtUnixMs: bigint;
  expectedMappingRevision: bigint;
}

export interface MoveGithubIssueResponse {
  issue?: GithubIssue;
  outcomes: GithubWriteOutcome[];
  rateLimit?: GithubRateLimit;
}

/* ----------------------------------- PR ----------------------------------- */

export interface GithubCheckRun {
  name: string;
  app: string;
  conclusion: GithubCheckConclusion;
  detailsUrl: string;
  startedAtUnixMs: bigint;
  completedAtUnixMs: bigint;
  /** 只有远端真的给了重跑入口才是 true。不是每个检查都能重启。 */
  rerunnable: boolean;
  workflowRunId: bigint;
}

export interface GithubCheckSummary {
  headSha: string;
  runs: GithubCheckRun[];
  rollup: GithubCheckConclusion;
  observedAtUnixMs: bigint;
}

export interface GithubReview {
  id: bigint;
  author?: GithubUser;
  state: GithubReviewState;
  body: string;
  commitSha: string;
  submittedAtUnixMs: bigint;
}

export interface GithubReviewComment {
  id: bigint;
  author?: GithubUser;
  body: string;
  path: string;
  commitSha: string;
  line: bigint;
  side: string;
  outdated: boolean;
  createdAtUnixMs: bigint;
}

export interface GithubPullFile {
  path: string;
  previousPath: string;
  status: string;
  additions: bigint;
  deletions: bigint;
  binary: boolean;
  /** 外部内容。行内评论就锚在这份 diff 上，没有它就没有行号可评。 */
  patch: string;
}

export interface GithubPullRequest {
  repository?: GithubRepositoryRef;
  number: bigint;
  id: bigint;
  title: string;
  body: string;
  state: GithubPullState;
  draft: boolean;
  author?: GithubUser;
  baseRef: string;
  headRef: string;
  headSha: string;
  headRepoFullName: string;
  fromFork: boolean;
  mergeable: GithubMergeableState;
  allowedMergeMethods: GithubMergeMethod[];
  additions: bigint;
  deletions: bigint;
  changedFiles: bigint;
  commits: bigint;
  requestedReviewers: GithubUser[];
  labels: GithubLabel[];
  createdAtUnixMs: bigint;
  updatedAtUnixMs: bigint;
  mergedAtUnixMs: bigint;
  closedAtUnixMs: bigint;
  htmlUrl: string;
  observedAtUnixMs: bigint;
}

export interface GithubPullFilter {
  state: GithubPullState;
  author: string;
  baseRef: string;
  reviewRequested: string;
  draftOnly: boolean;
}

export interface ListGithubPullsRequest {
  repository?: GithubRepositoryRef;
  filter?: GithubPullFilter;
  afterCursor: string;
  limit: number;
}

export interface ListGithubPullsResponse {
  pulls: GithubPullRequest[];
  nextCursor: string;
  hasMore: boolean;
  rateLimit?: GithubRateLimit;
  fromCache: boolean;
  observedAtUnixMs: bigint;
  pollIntervalMs: bigint;
}

export interface GetGithubPullRequest {
  repository?: GithubRepositoryRef;
  number: bigint;
}

export interface GetGithubPullResponse {
  pull?: GithubPullRequest;
  files: GithubPullFile[];
  reviews: GithubReview[];
  reviewComments: GithubReviewComment[];
  comments: GithubComment[];
  checks?: GithubCheckSummary;
  references: GithubExternalReference[];
  rateLimit?: GithubRateLimit;
  pollIntervalMs: bigint;
}

export interface CreateGithubPullRequest {
  repository?: GithubRepositoryRef;
  baseRef: string;
  headRef: string;
  title: string;
  body: string;
  draft: boolean;
  linkedIssueNumber: bigint;
  /** 本地认为已经推上去的那个 head。core 先核远端的 ref，对不上就拒绝。 */
  expectedHeadSha: string;
}

export interface GithubReviewCommentDraft {
  path: string;
  line: bigint;
  side: string;
  body: string;
}

export interface SubmitGithubReviewRequest {
  repository?: GithubRepositoryRef;
  number: bigint;
  commitSha: string;
  state: GithubReviewState;
  body: string;
  comments: GithubReviewCommentDraft[];
}

export interface GetGithubChecksRequest {
  repository?: GithubRepositoryRef;
  number: bigint;
}

export interface MergeGithubPullRequest {
  repository?: GithubRepositoryRef;
  number: bigint;
  /** 必填。head 自面板显示之后动过就拒绝合并。 */
  expectedHeadSha: string;
  method: GithubMergeMethod;
  commitTitle: string;
  commitMessage: string;
  expectedCheckRollup: GithubCheckConclusion;
}

export interface MergeGithubPullResponse {
  merged: boolean;
  mergeSha: string;
  reasonCode: string;
  pull?: GithubPullRequest;
  checks?: GithubCheckSummary;
}

export interface RerunGithubChecksRequest {
  repository?: GithubRepositoryRef;
  number: bigint;
  expectedHeadSha: string;
  checkName: string;
  failedOnly: boolean;
}

export interface RerunGithubChecksResponse {
  outcomes: GithubWriteOutcome[];
  reasonCode: string;
  checks?: GithubCheckSummary;
  rateLimit?: GithubRateLimit;
}

export interface DeleteGithubBranchRequest {
  repository?: GithubRepositoryRef;
  branch: string;
  /** 面板显示的那个提交。必填：往前走过的分支会带走没人看过的提交。 */
  expectedSha: string;
}

export interface DeleteGithubBranchResponse {
  deleted: boolean;
  reasonCode: string;
}

/* --------------------------------- 外部连接 -------------------------------- */

/** 把一个 Issue / PR 连到一个本地会话、分支或工作树。它是一个徽章和一条回去的路。 */
export interface GithubExternalReference {
  referenceId: string;
  workspaceId: string;
  repository?: GithubRepositoryRef;
  kind: GithubReferenceKind;
  number: bigint;
  targetKind: GithubReferenceTargetKind;
  targetId: string;
  title: string;
  revision: bigint;
  createdAtUnixMs: bigint;
  updatedAtUnixMs: bigint;
}

export interface LinkGithubReferenceRequest {
  reference?: GithubExternalReference;
  expectedRevision: bigint;
}

export interface UnlinkGithubReferenceRequest {
  referenceId: string;
  expectedRevision: bigint;
}

export interface UnlinkGithubReferenceResponse {
  referenceId: string;
  unlinked: boolean;
}

export interface ListGithubReferencesRequest {
  targetId: string;
  afterId: string;
  limit: number;
}

export interface ListGithubReferencesResponse {
  references: GithubExternalReference[];
  nextId: string;
  hasMore: boolean;
}
