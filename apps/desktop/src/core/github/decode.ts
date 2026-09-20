/**
 * 远端 JSON → protobuf 消息。移植自 合并前的实现。
 *
 * 线上形状只声明 core 真正用到的字段，其余一律丢掉而不是转发：上游新加一个键
 * 不可能在没有人审过的情况下到达客户端。
 */

import {
  GithubCheckConclusion,
  GithubIssueState,
  GithubIssueStateReason,
  GithubMergeMethod,
  GithubMergeableState,
  GithubPullState,
  GithubReviewState,
  type GithubCheckRun,
  type GithubCheckSummary,
  type GithubComment,
  type GithubIssue,
  type GithubLabel,
  type GithubPullFile,
  type GithubPullRequest,
  type GithubRepositoryRef,
  type GithubReview,
  type GithubReviewComment,
  type GithubUser,
} from "./types";
import {
  GithubCheckRunSchema,
  GithubCheckSummarySchema,
  GithubCommentSchema,
  GithubIssueSchema,
  GithubLabelSchema,
  GithubMilestoneSchema,
  GithubPullFileSchema,
  GithubPullRequestSchema,
  GithubReviewCommentSchema,
  GithubReviewSchema,
  GithubUserSchema,
} from "./schema";
import { create } from "../contract/message";

/* -------------------------------- 线上形状 -------------------------------- */

export interface WireUser {
  login?: string;
  id?: number;
}

export interface WireLabel {
  name?: string;
  color?: string;
}

export interface WireIssue {
  id?: number;
  node_id?: string;
  number?: number;
  title?: string;
  body?: string;
  state?: string;
  state_reason?: string;
  user?: WireUser | null;
  assignees?: WireUser[];
  labels?: WireLabel[];
  milestone?: { number?: number; title?: string } | null;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  html_url?: string;
  pull_request?: unknown;
}

export interface WireComment {
  id?: number;
  user?: WireUser | null;
  body?: string;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
}

export interface WireRepository {
  id?: number;
  full_name?: string;
  name?: string;
  default_branch?: string;
  private?: boolean;
  fork?: boolean;
  has_issues?: boolean;
  allow_merge_commit?: boolean | null;
  allow_squash_merge?: boolean | null;
  allow_rebase_merge?: boolean | null;
  owner?: { login?: string } | null;
  permissions?: {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
    triage?: boolean;
    pull?: boolean;
  } | null;
}

export interface WireRef {
  ref?: string;
  sha?: string;
  repo?: { full_name?: string; fork?: boolean } | null;
}

export interface WirePull {
  id?: number;
  node_id?: string;
  number?: number;
  title?: string;
  body?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  user?: WireUser | null;
  base?: WireRef | null;
  head?: WireRef | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
  requested_reviewers?: WireUser[];
  labels?: WireLabel[];
  created_at?: string;
  updated_at?: string;
  merged_at?: string;
  closed_at?: string;
  html_url?: string;
}

export interface WireFile {
  filename?: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

export interface WireReview {
  id?: number;
  user?: WireUser | null;
  state?: string;
  body?: string;
  commit_id?: string;
  submitted_at?: string;
}

export interface WireReviewComment {
  id?: number;
  user?: WireUser | null;
  body?: string;
  path?: string;
  commit_id?: string;
  original_line?: number;
  line?: number | null;
  side?: string;
  position?: number | null;
  created_at?: string;
}

export interface WireCheckRun {
  name?: string;
  status?: string;
  conclusion?: string;
  details_url?: string;
  started_at?: string;
  completed_at?: string;
  app?: { name?: string; slug?: string } | null;
}

export interface WireStatus {
  context?: string;
  state?: string;
  target_url?: string;
  created_at?: string;
  updated_at?: string;
  description?: string;
}

/* --------------------------------- 转换 ---------------------------------- */

/**
 * 一个 RFC 3339 瞬间 → 毫秒。缺失或解析不了就是 0，每个消费者都把它读成
 * 「没报」而不是纪元零点。
 */
export function unixMs(value: string | undefined): bigint {
  if (value === undefined || value === "") return 0n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? BigInt(parsed) : 0n;
}

function big(value: number | undefined | null): bigint {
  return BigInt(Math.trunc(value ?? 0));
}

export function user(
  value: WireUser | null | undefined,
): GithubUser | undefined {
  if (value === null || value === undefined) return undefined;
  return create(GithubUserSchema, {
    login: value.login ?? "",
    id: big(value.id),
  });
}

export function users(values: WireUser[] | undefined): GithubUser[] {
  return (values ?? []).map((value) =>
    create(GithubUserSchema, { login: value.login ?? "", id: big(value.id) }),
  );
}

export function labels(values: WireLabel[] | undefined): GithubLabel[] {
  return (values ?? []).map((value) =>
    create(GithubLabelSchema, {
      name: value.name ?? "",
      color: value.color ?? "",
    }),
  );
}

export function issueState(value: string | undefined): GithubIssueState {
  if (value === "open") return GithubIssueState.OPEN;
  if (value === "closed") return GithubIssueState.CLOSED;
  return GithubIssueState.UNSPECIFIED;
}

export function issueStateReason(
  value: string | undefined,
): GithubIssueStateReason {
  switch (value) {
    case "completed":
      return GithubIssueStateReason.COMPLETED;
    case "not_planned":
      return GithubIssueStateReason.NOT_PLANNED;
    case "reopened":
      return GithubIssueStateReason.REOPENED;
    case "duplicate":
      return GithubIssueStateReason.DUPLICATE;
    default:
      return GithubIssueStateReason.UNSPECIFIED;
  }
}

/** 这条 issues 记录其实是个 PR 吗。Issues 端点会把 PR 混在一起。 */
export function isPullRecord(value: WireIssue): boolean {
  const pull = value.pull_request;
  return pull !== undefined && pull !== null;
}

export function toIssue(
  value: WireIssue,
  ref: GithubRepositoryRef,
  observedAtMs: number,
): GithubIssue {
  const issue = create(GithubIssueSchema, {
    repository: ref,
    number: big(value.number),
    id: big(value.id),
    title: value.title ?? "",
    body: value.body ?? "",
    state: issueState(value.state),
    stateReason: issueStateReason(value.state_reason),
    assignees: users(value.assignees),
    labels: labels(value.labels),
    commentCount: big(value.comments),
    createdAtUnixMs: unixMs(value.created_at),
    updatedAtUnixMs: unixMs(value.updated_at),
    closedAtUnixMs: unixMs(value.closed_at),
    htmlUrl: value.html_url ?? "",
    observedAtUnixMs: BigInt(observedAtMs),
  });
  const author = user(value.user);
  if (author !== undefined) issue.author = author;
  if (value.milestone !== null && value.milestone !== undefined) {
    issue.milestone = create(GithubMilestoneSchema, {
      number: big(value.milestone.number),
      title: value.milestone.title ?? "",
    });
  }
  return issue;
}

export function toComment(value: WireComment): GithubComment {
  const comment = create(GithubCommentSchema, {
    id: big(value.id),
    body: value.body ?? "",
    createdAtUnixMs: unixMs(value.created_at),
    updatedAtUnixMs: unixMs(value.updated_at),
    htmlUrl: value.html_url ?? "",
  });
  const author = user(value.user);
  if (author !== undefined) comment.author = author;
  return comment;
}

/**
 * 仓库允许的合并策略。
 *
 * `null` 表示端点没报这一项。给出一个仓库可能不允许的策略等于在用户面前放一个
 * 注定被 405 的按钮。
 */
export function mergeMethods(value: WireRepository): GithubMergeMethod[] {
  const methods: GithubMergeMethod[] = [];
  if (value.allow_merge_commit === true) methods.push(GithubMergeMethod.MERGE);
  if (value.allow_squash_merge === true) methods.push(GithubMergeMethod.SQUASH);
  if (value.allow_rebase_merge === true) methods.push(GithubMergeMethod.REBASE);
  return methods;
}

export function permission(value: WireRepository): string {
  const permissions = value.permissions;
  if (permissions === null || permissions === undefined) return "";
  if (permissions.admin === true) return "admin";
  if (permissions.maintain === true) return "maintain";
  if (permissions.push === true) return "write";
  if (permissions.triage === true) return "triage";
  if (permissions.pull === true) return "read";
  return "";
}

export function pullState(value: WirePull): GithubPullState {
  if (value.merged === true || (value.merged_at ?? "") !== "") {
    return GithubPullState.MERGED;
  }
  if (value.state === "open") return GithubPullState.OPEN;
  if (value.state === "closed") return GithubPullState.CLOSED;
  return GithubPullState.UNSPECIFIED;
}

/**
 * 两个互相独立的远端字段合成一个诚实的答案。缺失的 `mergeable` 表示远端还在算，
 * 那和「可以合」从来不是一回事。
 */
export function mergeable(value: WirePull): GithubMergeableState {
  switch (value.mergeable_state) {
    case "dirty":
      return GithubMergeableState.CONFLICTING;
    case "blocked":
    case "behind":
    case "draft":
      return GithubMergeableState.BLOCKED;
    default:
      break;
  }
  if (value.mergeable === null || value.mergeable === undefined) {
    return GithubMergeableState.UNKNOWN;
  }
  return value.mergeable
    ? GithubMergeableState.MERGEABLE
    : GithubMergeableState.CONFLICTING;
}

export function toPull(
  value: WirePull,
  ref: GithubRepositoryRef,
  allowed: readonly GithubMergeMethod[],
  observedAtMs: number,
): GithubPullRequest {
  const full = value.head?.repo?.full_name;
  const pull = create(GithubPullRequestSchema, {
    repository: ref,
    number: big(value.number),
    id: big(value.id),
    title: value.title ?? "",
    body: value.body ?? "",
    state: pullState(value),
    draft: value.draft === true,
    baseRef: value.base?.ref ?? "",
    headRef: value.head?.ref ?? "",
    headSha: value.head?.sha ?? "",
    headRepoFullName: full ?? "",
    fromFork:
      full === undefined
        ? false
        : full.toLowerCase() !== `${ref.owner}/${ref.name}`.toLowerCase(),
    mergeable: mergeable(value),
    allowedMergeMethods: [...allowed],
    additions: big(value.additions),
    deletions: big(value.deletions),
    changedFiles: big(value.changed_files),
    commits: big(value.commits),
    requestedReviewers: users(value.requested_reviewers),
    labels: labels(value.labels),
    createdAtUnixMs: unixMs(value.created_at),
    updatedAtUnixMs: unixMs(value.updated_at),
    mergedAtUnixMs: unixMs(value.merged_at),
    closedAtUnixMs: unixMs(value.closed_at),
    htmlUrl: value.html_url ?? "",
    observedAtUnixMs: BigInt(observedAtMs),
  });
  const author = user(value.user);
  if (author !== undefined) pull.author = author;
  return pull;
}

/**
 * core 肯转发的单文件 diff 上限。超过这个就整块丢掉而不是截断：行内评审评论靠
 * hunk 头定位，落在截断之后的评论会停在评审者从没看见过的行上。
 */
export const MAX_PATCH_BYTES = 64 << 10;

export function toFile(value: WireFile): GithubPullFile {
  const raw = value.patch ?? "";
  const patch = Buffer.byteLength(raw, "utf8") > MAX_PATCH_BYTES ? "" : raw;
  return create(GithubPullFileSchema, {
    path: value.filename ?? "",
    previousPath: value.previous_filename ?? "",
    status: value.status ?? "",
    additions: big(value.additions),
    deletions: big(value.deletions),
    // 远端对二进制文件不给 patch；这个缺失加上一个非零的改动是它唯一的信号。
    binary:
      raw === "" && value.status !== "unchanged" && value.status !== "renamed",
    patch,
  });
}

export function reviewState(value: string | undefined): GithubReviewState {
  switch ((value ?? "").toUpperCase()) {
    case "APPROVED":
      return GithubReviewState.APPROVED;
    case "CHANGES_REQUESTED":
      return GithubReviewState.CHANGES_REQUESTED;
    case "COMMENTED":
      return GithubReviewState.COMMENTED;
    case "DISMISSED":
      return GithubReviewState.DISMISSED;
    case "PENDING":
      return GithubReviewState.PENDING;
    default:
      return GithubReviewState.UNSPECIFIED;
  }
}

export function toReview(value: WireReview): GithubReview {
  const review = create(GithubReviewSchema, {
    id: big(value.id),
    state: reviewState(value.state),
    body: value.body ?? "",
    commitSha: value.commit_id ?? "",
    submittedAtUnixMs: unixMs(value.submitted_at),
  });
  const author = user(value.user);
  if (author !== undefined) review.author = author;
  return review;
}

export function toReviewComment(value: WireReviewComment): GithubReviewComment {
  // 远端不再报当前行，说明这条评论已经漂离 diff。保留原行并标成 outdated 是
  // 唯一诚实的选项；悄悄画在一条当前行上是错的。
  const hasLine = value.line !== null && value.line !== undefined;
  const comment = create(GithubReviewCommentSchema, {
    id: big(value.id),
    body: value.body ?? "",
    path: value.path ?? "",
    commitSha: value.commit_id ?? "",
    line: hasLine ? big(value.line) : big(value.original_line),
    side: (value.side ?? "") === "" ? "RIGHT" : (value.side as string),
    outdated:
      !hasLine || value.position === null || value.position === undefined,
    createdAtUnixMs: unixMs(value.created_at),
  });
  const author = user(value.user);
  if (author !== undefined) comment.author = author;
  return comment;
}

const ACTIONS_RUN_PATTERN = /\/actions\/runs\/(\d{1,19})/;

export function checkConclusion(
  status: string | undefined,
  conclusion: string | undefined,
): GithubCheckConclusion {
  if (status !== "completed" && status !== undefined && status !== "") {
    return GithubCheckConclusion.PENDING;
  }
  switch (conclusion) {
    case "success":
      return GithubCheckConclusion.SUCCESS;
    case "failure":
      return GithubCheckConclusion.FAILURE;
    case "neutral":
      return GithubCheckConclusion.NEUTRAL;
    case "cancelled":
      return GithubCheckConclusion.CANCELLED;
    case "skipped":
      return GithubCheckConclusion.SKIPPED;
    case "timed_out":
      return GithubCheckConclusion.TIMED_OUT;
    case "action_required":
      return GithubCheckConclusion.ACTION_REQUIRED;
    case "stale":
      return GithubCheckConclusion.STALE;
    case "":
    case undefined:
      return GithubCheckConclusion.PENDING;
    default:
      return GithubCheckConclusion.UNSPECIFIED;
  }
}

export function toCheckRun(value: WireCheckRun): GithubCheckRun {
  const run = create(GithubCheckRunSchema, {
    name: value.name ?? "",
    conclusion: checkConclusion(value.status, value.conclusion),
    detailsUrl: value.details_url ?? "",
    startedAtUnixMs: unixMs(value.started_at),
    completedAtUnixMs: unixMs(value.completed_at),
    app: value.app?.name ?? "",
  });
  // 只有 workflow run 真的能被重跑。别的生产者一律没有重跑入口，因为压根没有
  // 对应的端点。
  if (value.app?.slug === "github-actions") {
    const match = ACTIONS_RUN_PATTERN.exec(value.details_url ?? "");
    if (match !== null) {
      const id = Number.parseInt(match[1] as string, 10);
      if (Number.isSafeInteger(id) && id > 0) {
        run.workflowRunId = BigInt(id);
        run.rerunnable = true;
      }
    }
  }
  return run;
}

export function commitStatusConclusion(
  state: string | undefined,
): GithubCheckConclusion {
  switch (state) {
    case "success":
      return GithubCheckConclusion.SUCCESS;
    case "failure":
    case "error":
      return GithubCheckConclusion.FAILURE;
    case "pending":
      return GithubCheckConclusion.PENDING;
    default:
      return GithubCheckConclusion.UNSPECIFIED;
  }
}

/**
 * 把许多次检查归成一次合并决定需要的那一个答案。失败盖过一切，任何还在跑的都让
 * 整个 rollup 保持 pending：没跑完不等于通过。
 */
export function rollup(runs: readonly GithubCheckRun[]): GithubCheckConclusion {
  if (runs.length === 0) return GithubCheckConclusion.UNSPECIFIED;
  let failed = false;
  let pending = false;
  let success = false;
  for (const run of runs) {
    switch (run.conclusion) {
      case GithubCheckConclusion.FAILURE:
      case GithubCheckConclusion.TIMED_OUT:
      case GithubCheckConclusion.ACTION_REQUIRED:
        failed = true;
        break;
      case GithubCheckConclusion.PENDING:
        pending = true;
        break;
      case GithubCheckConclusion.SUCCESS:
        success = true;
        break;
      default:
        break;
    }
  }
  if (failed) return GithubCheckConclusion.FAILURE;
  if (pending) return GithubCheckConclusion.PENDING;
  if (success) return GithubCheckConclusion.SUCCESS;
  return GithubCheckConclusion.NEUTRAL;
}

export function checkSummary(
  headSha: string,
  runs: GithubCheckRun[],
  observedAtMs: number,
): GithubCheckSummary {
  return create(GithubCheckSummarySchema, {
    headSha,
    runs,
    rollup: rollup(runs),
    observedAtUnixMs: BigInt(observedAtMs),
  });
}

/** 提交状态那一半，和 check run 合进同一张表。 */
export function statusRun(value: WireStatus): GithubCheckRun {
  return create(GithubCheckRunSchema, {
    name: value.context ?? "",
    conclusion: commitStatusConclusion(value.state),
    detailsUrl: value.target_url ?? "",
    startedAtUnixMs: unixMs(value.created_at),
    completedAtUnixMs: unixMs(value.updated_at),
  });
}
