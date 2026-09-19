/**
 * GitHub 域的字段表。
 *
 * 类型在 `types.ts`，造一份 / 编成 JSON / 从 JSON 读回来在 `../contract/message`。
 * 分成两个文件是因为它们被读的时机不一样：改一个动词的参数要翻类型，查「这个字段
 * 在线上长什么样」要翻这张表。
 *
 * 表里的顺序照 `docs/contracts/core-json-api.md` §5，也照页面 zod 的顺序。
 */

import {
  bool,
  describe,
  enumOf,
  enumsOf,
  i64,
  msg,
  optionalInt64,
  optionalString,
  repeated,
  str,
  strings,
  u32,
  u64,
} from "../contract/message";
import {
  GithubCheckConclusion,
  GithubCredentialSource,
  GithubIssueState,
  GithubIssueStateReason,
  GithubMergeMethod,
  GithubMergeableState,
  GithubPullState,
  GithubReferenceKind,
  GithubReferenceTargetKind,
  GithubReviewState,
  GithubSecretStore,
  GithubStatusSource,
  GithubWriteState,
  type CommentGithubIssueRequest,
  type ConfigureGithubCredentialRequest,
  type CreateGithubIssueRequest,
  type CreateGithubPullRequest,
  type DeleteGithubBranchRequest,
  type DeleteGithubBranchResponse,
  type GetGithubChecksRequest,
  type GetGithubCredentialRequest,
  type GetGithubIssueRequest,
  type GetGithubIssueResponse,
  type GetGithubPullRequest,
  type GetGithubPullResponse,
  type GetGithubStatusMappingRequest,
  type GithubCheckRun,
  type GithubCheckSummary,
  type GithubComment,
  type GithubCredentialStatus,
  type GithubExternalReference,
  type GithubIssue,
  type GithubIssueFilter,
  type GithubIssuePatch,
  type GithubLabel,
  type GithubMilestone,
  type GithubPullFile,
  type GithubPullFilter,
  type GithubPullRequest,
  type GithubRateLimit,
  type GithubRepository,
  type GithubRepositoryRef,
  type GithubReview,
  type GithubReviewComment,
  type GithubReviewCommentDraft,
  type GithubStateCoupling,
  type GithubStatusGroup,
  type GithubStatusMapping,
  type GithubUser,
  type GithubWriteOutcome,
  type LinkGithubReferenceRequest,
  type ListGithubIssuesRequest,
  type ListGithubIssuesResponse,
  type ListGithubPullsRequest,
  type ListGithubPullsResponse,
  type ListGithubReferencesRequest,
  type ListGithubReferencesResponse,
  type MergeGithubPullRequest,
  type MergeGithubPullResponse,
  type MoveGithubIssueRequest,
  type MoveGithubIssueResponse,
  type PutGithubStatusMappingRequest,
  type RerunGithubChecksRequest,
  type RerunGithubChecksResponse,
  type ResolveGithubRepositoryRequest,
  type ResolveGithubRepositoryResponse,
  type RevokeGithubCredentialRequest,
  type SetGithubIssueStateRequest,
  type SubmitGithubReviewRequest,
  type UnlinkGithubReferenceRequest,
  type UnlinkGithubReferenceResponse,
  type UpdateGithubIssueRequest,
} from "./types";

/* -------------------------------- 凭据与仓库 ------------------------------- */

export const GithubCredentialStatusSchema = describe<GithubCredentialStatus>(
  "GithubCredentialStatus",
  {
    source: enumOf(GithubCredentialSource.UNSPECIFIED),
    store: enumOf(GithubSecretStore.UNSPECIFIED),
    available: bool,
    apiBase: str,
    enterprise: bool,
    accountLogin: str,
    tokenScopes: strings,
    checkedAtUnixMs: i64,
    reasonCode: str,
    revision: u64,
  },
);

export const GetGithubCredentialRequestSchema =
  describe<GetGithubCredentialRequest>("GetGithubCredentialRequest", {});

export const ConfigureGithubCredentialRequestSchema =
  describe<ConfigureGithubCredentialRequest>(
    "ConfigureGithubCredentialRequest",
    {
      source: enumOf(GithubCredentialSource.UNSPECIFIED),
      token: str,
      apiBase: str,
      expectedRevision: u64,
    },
  );

export const RevokeGithubCredentialRequestSchema =
  describe<RevokeGithubCredentialRequest>("RevokeGithubCredentialRequest", {
    expectedRevision: u64,
  });

export const GithubRepositoryRefSchema = describe<GithubRepositoryRef>(
  "GithubRepositoryRef",
  { owner: str, name: str, apiBase: str, host: str },
);

export const GithubRateLimitSchema = describe<GithubRateLimit>(
  "GithubRateLimit",
  {
    limit: i64,
    remaining: i64,
    resetsAtUnixMs: i64,
    throttled: bool,
    retryAfterUnixMs: i64,
  },
);

export const GithubRepositorySchema = describe<GithubRepository>(
  "GithubRepository",
  {
    ref: msg(() => GithubRepositoryRefSchema),
    id: i64,
    defaultBranch: str,
    private: bool,
    fork: bool,
    hasIssues: bool,
    allowedMergeMethods: enumsOf(GithubMergeMethod.UNSPECIFIED),
    permission: str,
    observedAtUnixMs: i64,
  },
);

export const ResolveGithubRepositoryRequestSchema =
  describe<ResolveGithubRepositoryRequest>("ResolveGithubRepositoryRequest", {
    remoteUrl: str,
  });

export const ResolveGithubRepositoryResponseSchema =
  describe<ResolveGithubRepositoryResponse>("ResolveGithubRepositoryResponse", {
    repository: msg(() => GithubRepositorySchema),
    hostMismatch: bool,
    reasonCode: str,
    rateLimit: msg(() => GithubRateLimitSchema),
  });

/* ---------------------------------- Issue --------------------------------- */

export const GithubUserSchema = describe<GithubUser>("GithubUser", {
  login: str,
  id: i64,
});

export const GithubLabelSchema = describe<GithubLabel>("GithubLabel", {
  name: str,
  color: str,
});

export const GithubMilestoneSchema = describe<GithubMilestone>(
  "GithubMilestone",
  { number: i64, title: str },
);

export const GithubIssueSchema = describe<GithubIssue>("GithubIssue", {
  repository: msg(() => GithubRepositoryRefSchema),
  number: i64,
  id: i64,
  title: str,
  body: str,
  state: enumOf(GithubIssueState.UNSPECIFIED),
  stateReason: enumOf(GithubIssueStateReason.UNSPECIFIED),
  author: msg(() => GithubUserSchema),
  assignees: repeated(() => GithubUserSchema),
  labels: repeated(() => GithubLabelSchema),
  milestone: msg(() => GithubMilestoneSchema),
  commentCount: i64,
  createdAtUnixMs: i64,
  updatedAtUnixMs: i64,
  closedAtUnixMs: i64,
  htmlUrl: str,
  statusGroupId: str,
  statusConflict: bool,
  observedAtUnixMs: i64,
});

export const GithubCommentSchema = describe<GithubComment>("GithubComment", {
  id: i64,
  author: msg(() => GithubUserSchema),
  body: str,
  createdAtUnixMs: i64,
  updatedAtUnixMs: i64,
  htmlUrl: str,
});

export const GithubIssueFilterSchema = describe<GithubIssueFilter>(
  "GithubIssueFilter",
  {
    state: enumOf(GithubIssueState.UNSPECIFIED),
    labels: strings,
    assignee: str,
    author: str,
    milestoneNumber: i64,
    query: str,
  },
);

export const ListGithubIssuesRequestSchema = describe<ListGithubIssuesRequest>(
  "ListGithubIssuesRequest",
  {
    repository: msg(() => GithubRepositoryRefSchema),
    filter: msg(() => GithubIssueFilterSchema),
    afterCursor: str,
    limit: u32,
  },
);

export const ListGithubIssuesResponseSchema =
  describe<ListGithubIssuesResponse>("ListGithubIssuesResponse", {
    issues: repeated(() => GithubIssueSchema),
    nextCursor: str,
    hasMore: bool,
    rateLimit: msg(() => GithubRateLimitSchema),
    fromCache: bool,
    observedAtUnixMs: i64,
    pollIntervalMs: i64,
  });

export const GetGithubIssueRequestSchema = describe<GetGithubIssueRequest>(
  "GetGithubIssueRequest",
  { repository: msg(() => GithubRepositoryRefSchema), number: i64 },
);

export const GetGithubIssueResponseSchema = describe<GetGithubIssueResponse>(
  "GetGithubIssueResponse",
  {
    issue: msg(() => GithubIssueSchema),
    comments: repeated(() => GithubCommentSchema),
    references: repeated(() => GithubExternalReferenceSchema),
    rateLimit: msg(() => GithubRateLimitSchema),
    pollIntervalMs: i64,
  },
);

export const CreateGithubIssueRequestSchema =
  describe<CreateGithubIssueRequest>("CreateGithubIssueRequest", {
    repository: msg(() => GithubRepositoryRefSchema),
    title: str,
    body: str,
    labels: strings,
    assignees: strings,
    milestoneNumber: i64,
  });

export const GithubIssuePatchSchema = describe<GithubIssuePatch>(
  "GithubIssuePatch",
  {
    title: optionalString,
    body: optionalString,
    replaceLabels: bool,
    labels: strings,
    replaceAssignees: bool,
    assignees: strings,
    milestoneNumber: optionalInt64,
  },
);

export const UpdateGithubIssueRequestSchema =
  describe<UpdateGithubIssueRequest>("UpdateGithubIssueRequest", {
    repository: msg(() => GithubRepositoryRefSchema),
    number: i64,
    patch: msg(() => GithubIssuePatchSchema),
    expectedUpdatedAtUnixMs: i64,
  });

export const SetGithubIssueStateRequestSchema =
  describe<SetGithubIssueStateRequest>("SetGithubIssueStateRequest", {
    repository: msg(() => GithubRepositoryRefSchema),
    number: i64,
    state: enumOf(GithubIssueState.UNSPECIFIED),
    reason: enumOf(GithubIssueStateReason.UNSPECIFIED),
    expectedUpdatedAtUnixMs: i64,
  });

export const CommentGithubIssueRequestSchema =
  describe<CommentGithubIssueRequest>("CommentGithubIssueRequest", {
    repository: msg(() => GithubRepositoryRefSchema),
    number: i64,
    body: str,
  });

/* --------------------------------- 状态映射 -------------------------------- */

export const GithubStatusGroupSchema = describe<GithubStatusGroup>(
  "GithubStatusGroup",
  {
    id: str,
    title: str,
    label: str,
    projectOptionId: str,
    couplesIssueState: enumOf(GithubIssueState.UNSPECIFIED),
  },
);

export const GithubStateCouplingSchema = describe<GithubStateCoupling>(
  "GithubStateCoupling",
  { state: enumOf(GithubIssueState.UNSPECIFIED), groupId: str },
);

export const GithubStatusMappingSchema = describe<GithubStatusMapping>(
  "GithubStatusMapping",
  {
    repository: msg(() => GithubRepositoryRefSchema),
    source: enumOf(GithubStatusSource.UNSPECIFIED),
    projectId: str,
    projectFieldId: str,
    groups: repeated(() => GithubStatusGroupSchema),
    stateGroups: repeated(() => GithubStateCouplingSchema),
    revision: u64,
    updatedAtUnixMs: i64,
  },
);

export const GetGithubStatusMappingRequestSchema =
  describe<GetGithubStatusMappingRequest>("GetGithubStatusMappingRequest", {
    repository: msg(() => GithubRepositoryRefSchema),
  });

export const PutGithubStatusMappingRequestSchema =
  describe<PutGithubStatusMappingRequest>("PutGithubStatusMappingRequest", {
    mapping: msg(() => GithubStatusMappingSchema),
    expectedRevision: u64,
  });

export const GithubWriteOutcomeSchema = describe<GithubWriteOutcome>(
  "GithubWriteOutcome",
  {
    actionId: str,
    target: str,
    state: enumOf(GithubWriteState.UNSPECIFIED),
    reasonCode: str,
    previousValue: str,
    requestedValue: str,
  },
);

export const MoveGithubIssueRequestSchema = describe<MoveGithubIssueRequest>(
  "MoveGithubIssueRequest",
  {
    repository: msg(() => GithubRepositoryRefSchema),
    number: i64,
    toGroupId: str,
    fromGroupId: str,
    expectedUpdatedAtUnixMs: i64,
    expectedMappingRevision: u64,
  },
);

export const MoveGithubIssueResponseSchema = describe<MoveGithubIssueResponse>(
  "MoveGithubIssueResponse",
  {
    issue: msg(() => GithubIssueSchema),
    outcomes: repeated(() => GithubWriteOutcomeSchema),
    rateLimit: msg(() => GithubRateLimitSchema),
  },
);

/* ----------------------------------- PR ----------------------------------- */

export const GithubCheckRunSchema = describe<GithubCheckRun>("GithubCheckRun", {
  name: str,
  app: str,
  conclusion: enumOf(GithubCheckConclusion.UNSPECIFIED),
  detailsUrl: str,
  startedAtUnixMs: i64,
  completedAtUnixMs: i64,
  rerunnable: bool,
  workflowRunId: i64,
});

export const GithubCheckSummarySchema = describe<GithubCheckSummary>(
  "GithubCheckSummary",
  {
    headSha: str,
    runs: repeated(() => GithubCheckRunSchema),
    rollup: enumOf(GithubCheckConclusion.UNSPECIFIED),
    observedAtUnixMs: i64,
  },
);

export const GithubReviewSchema = describe<GithubReview>("GithubReview", {
  id: i64,
  author: msg(() => GithubUserSchema),
  state: enumOf(GithubReviewState.UNSPECIFIED),
  body: str,
  commitSha: str,
  submittedAtUnixMs: i64,
});

export const GithubReviewCommentSchema = describe<GithubReviewComment>(
  "GithubReviewComment",
  {
    id: i64,
    author: msg(() => GithubUserSchema),
    body: str,
    path: str,
    commitSha: str,
    line: i64,
    side: str,
    outdated: bool,
    createdAtUnixMs: i64,
  },
);

export const GithubPullFileSchema = describe<GithubPullFile>("GithubPullFile", {
  path: str,
  previousPath: str,
  status: str,
  additions: i64,
  deletions: i64,
  binary: bool,
  patch: str,
});

export const GithubPullRequestSchema = describe<GithubPullRequest>(
  "GithubPullRequest",
  {
    repository: msg(() => GithubRepositoryRefSchema),
    number: i64,
    id: i64,
    title: str,
    body: str,
    state: enumOf(GithubPullState.UNSPECIFIED),
    draft: bool,
    author: msg(() => GithubUserSchema),
    baseRef: str,
    headRef: str,
    headSha: str,
    headRepoFullName: str,
    fromFork: bool,
    mergeable: enumOf(GithubMergeableState.UNSPECIFIED),
    allowedMergeMethods: enumsOf(GithubMergeMethod.UNSPECIFIED),
    additions: i64,
    deletions: i64,
    changedFiles: i64,
    commits: i64,
    requestedReviewers: repeated(() => GithubUserSchema),
    labels: repeated(() => GithubLabelSchema),
    createdAtUnixMs: i64,
    updatedAtUnixMs: i64,
    mergedAtUnixMs: i64,
    closedAtUnixMs: i64,
    htmlUrl: str,
    observedAtUnixMs: i64,
  },
);

export const GithubPullFilterSchema = describe<GithubPullFilter>(
  "GithubPullFilter",
  {
    state: enumOf(GithubPullState.UNSPECIFIED),
    author: str,
    baseRef: str,
    reviewRequested: str,
    draftOnly: bool,
  },
);

export const ListGithubPullsRequestSchema = describe<ListGithubPullsRequest>(
  "ListGithubPullsRequest",
  {
    repository: msg(() => GithubRepositoryRefSchema),
    filter: msg(() => GithubPullFilterSchema),
    afterCursor: str,
    limit: u32,
  },
);

export const ListGithubPullsResponseSchema = describe<ListGithubPullsResponse>(
  "ListGithubPullsResponse",
  {
    pulls: repeated(() => GithubPullRequestSchema),
    nextCursor: str,
    hasMore: bool,
    rateLimit: msg(() => GithubRateLimitSchema),
    fromCache: bool,
    observedAtUnixMs: i64,
    pollIntervalMs: i64,
  },
);

export const GetGithubPullRequestSchema = describe<GetGithubPullRequest>(
  "GetGithubPullRequest",
  { repository: msg(() => GithubRepositoryRefSchema), number: i64 },
);

export const GetGithubPullResponseSchema = describe<GetGithubPullResponse>(
  "GetGithubPullResponse",
  {
    pull: msg(() => GithubPullRequestSchema),
    files: repeated(() => GithubPullFileSchema),
    reviews: repeated(() => GithubReviewSchema),
    reviewComments: repeated(() => GithubReviewCommentSchema),
    comments: repeated(() => GithubCommentSchema),
    checks: msg(() => GithubCheckSummarySchema),
    references: repeated(() => GithubExternalReferenceSchema),
    rateLimit: msg(() => GithubRateLimitSchema),
    pollIntervalMs: i64,
  },
);

export const CreateGithubPullRequestSchema = describe<CreateGithubPullRequest>(
  "CreateGithubPullRequest",
  {
    repository: msg(() => GithubRepositoryRefSchema),
    baseRef: str,
    headRef: str,
    title: str,
    body: str,
    draft: bool,
    linkedIssueNumber: i64,
    expectedHeadSha: str,
  },
);

export const GithubReviewCommentDraftSchema =
  describe<GithubReviewCommentDraft>("GithubReviewCommentDraft", {
    path: str,
    line: i64,
    side: str,
    body: str,
  });

export const SubmitGithubReviewRequestSchema =
  describe<SubmitGithubReviewRequest>("SubmitGithubReviewRequest", {
    repository: msg(() => GithubRepositoryRefSchema),
    number: i64,
    commitSha: str,
    state: enumOf(GithubReviewState.UNSPECIFIED),
    body: str,
    comments: repeated(() => GithubReviewCommentDraftSchema),
  });

export const GetGithubChecksRequestSchema = describe<GetGithubChecksRequest>(
  "GetGithubChecksRequest",
  { repository: msg(() => GithubRepositoryRefSchema), number: i64 },
);

export const MergeGithubPullRequestSchema = describe<MergeGithubPullRequest>(
  "MergeGithubPullRequest",
  {
    repository: msg(() => GithubRepositoryRefSchema),
    number: i64,
    expectedHeadSha: str,
    method: enumOf(GithubMergeMethod.UNSPECIFIED),
    commitTitle: str,
    commitMessage: str,
    expectedCheckRollup: enumOf(GithubCheckConclusion.UNSPECIFIED),
  },
);

export const MergeGithubPullResponseSchema = describe<MergeGithubPullResponse>(
  "MergeGithubPullResponse",
  {
    merged: bool,
    mergeSha: str,
    reasonCode: str,
    pull: msg(() => GithubPullRequestSchema),
    checks: msg(() => GithubCheckSummarySchema),
  },
);

export const RerunGithubChecksRequestSchema =
  describe<RerunGithubChecksRequest>("RerunGithubChecksRequest", {
    repository: msg(() => GithubRepositoryRefSchema),
    number: i64,
    expectedHeadSha: str,
    checkName: str,
    failedOnly: bool,
  });

export const RerunGithubChecksResponseSchema =
  describe<RerunGithubChecksResponse>("RerunGithubChecksResponse", {
    outcomes: repeated(() => GithubWriteOutcomeSchema),
    reasonCode: str,
    checks: msg(() => GithubCheckSummarySchema),
    rateLimit: msg(() => GithubRateLimitSchema),
  });

export const DeleteGithubBranchRequestSchema =
  describe<DeleteGithubBranchRequest>("DeleteGithubBranchRequest", {
    repository: msg(() => GithubRepositoryRefSchema),
    branch: str,
    expectedSha: str,
  });

export const DeleteGithubBranchResponseSchema =
  describe<DeleteGithubBranchResponse>("DeleteGithubBranchResponse", {
    deleted: bool,
    reasonCode: str,
  });

/* --------------------------------- 外部连接 -------------------------------- */

export const GithubExternalReferenceSchema = describe<GithubExternalReference>(
  "GithubExternalReference",
  {
    referenceId: str,
    workspaceId: str,
    repository: msg(() => GithubRepositoryRefSchema),
    kind: enumOf(GithubReferenceKind.UNSPECIFIED),
    number: i64,
    targetKind: enumOf(GithubReferenceTargetKind.UNSPECIFIED),
    targetId: str,
    title: str,
    revision: u64,
    createdAtUnixMs: i64,
    updatedAtUnixMs: i64,
  },
);

export const LinkGithubReferenceRequestSchema =
  describe<LinkGithubReferenceRequest>("LinkGithubReferenceRequest", {
    reference: msg(() => GithubExternalReferenceSchema),
    expectedRevision: u64,
  });

export const UnlinkGithubReferenceRequestSchema =
  describe<UnlinkGithubReferenceRequest>("UnlinkGithubReferenceRequest", {
    referenceId: str,
    expectedRevision: u64,
  });

export const UnlinkGithubReferenceResponseSchema =
  describe<UnlinkGithubReferenceResponse>("UnlinkGithubReferenceResponse", {
    referenceId: str,
    unlinked: bool,
  });

export const ListGithubReferencesRequestSchema =
  describe<ListGithubReferencesRequest>("ListGithubReferencesRequest", {
    targetId: str,
    afterId: str,
    limit: u32,
  });

export const ListGithubReferencesResponseSchema =
  describe<ListGithubReferencesResponse>("ListGithubReferencesResponse", {
    references: repeated(() => GithubExternalReferenceSchema),
    nextId: str,
    hasMore: bool,
  });
