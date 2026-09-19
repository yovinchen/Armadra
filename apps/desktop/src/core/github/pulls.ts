/**
 * Pull request（设计 §8）。移植自 `apps/host/internal/githubhost/pulls.go`。
 *
 * 合并那条路径是这个文件大部分内容存在的原因：一次合并带着读者看到的那个确切
 * head，而 core 在发出任何东西之前会把 PR 和它的检查都重新读一遍。
 */

import {
  GetGithubPullResponseSchema,
  GithubCheckConclusion,
  GithubMergeMethod,
  GithubMergeableState,
  GithubPullState,
  GithubReferenceKind,
  GithubReviewState,
  ListGithubPullsResponseSchema,
  MergeGithubPullResponseSchema,
  create,
  type CreateGithubPullRequest,
  type GetGithubChecksRequest,
  type GetGithubPullRequest,
  type GetGithubPullResponse,
  type GithubCheckSummary,
  type GithubPullRequest,
  type GithubRepositoryRef,
  type GithubReview,
  type ListGithubPullsRequest,
  type ListGithubPullsResponse,
  type MergeGithubPullRequest,
  type MergeGithubPullResponse,
  type SubmitGithubReviewRequest,
} from "@armadra/protocol";

import type { GithubClient } from "./client";
import * as api from "./endpoints";
import { codeOf, githubError, isGithubError } from "./errors";
import { referencesFor } from "./references";
import {
  MAX_COMMENTS,
  MAX_FILES,
  POLL_INTERVAL_MS,
  SCOPE_READ,
  SCOPE_WRITE,
  decodeCursor,
  encodeCursor,
  pageLimit,
  rateLimit,
  type Caller,
  type GithubService,
} from "./service";

/**
 * 读仓库实际允许的策略。一个仓库已经禁用的策略永远不被提供，所以面板没法摆出一个
 * 注定被拒的按钮。
 */
async function mergeMethods(
  service: GithubService,
  client: GithubClient,
  ref: GithubRepositoryRef,
): Promise<GithubMergeMethod[]> {
  try {
    const result = await api.repository(client, ref, service.now());
    return [...result.repository.allowedMergeMethods];
  } catch {
    return [];
  }
}

export async function listPulls(
  service: GithubService,
  caller: Caller,
  request: ListGithubPullsRequest,
): Promise<ListGithubPullsResponse> {
  service.authorize(caller, SCOPE_READ);
  const client = service.client();
  const ref = service.repository(request.repository);
  const page = decodeCursor(request.afterCursor);
  const now = service.now();
  const allowed = await mergeMethods(service, client, ref);
  try {
    const result = await api.pulls(
      client,
      ref,
      request.filter,
      page,
      pageLimit(Number(request.limit)),
      allowed,
      now,
    );
    service.credentials.noteSuccess();
    return create(ListGithubPullsResponseSchema, {
      pulls: result.pulls,
      nextCursor: encodeCursor(result.response.nextPage),
      hasMore: result.response.nextPage >= 2,
      rateLimit: rateLimit(result.response.rate),
      fromCache: result.response.fromCache,
      observedAtUnixMs: BigInt(now),
      pollIntervalMs: BigInt(POLL_INTERVAL_MS),
    });
  } catch (error) {
    throw service.translate(error);
  }
}

/**
 * 读一条 PR，连同它的文件概要、评审、评论和**当前 head 的**检查。检查永远是对着
 * 这次响应报出来的那个 head 读的，所以一份概要不可能描述另一个提交。
 */
export async function getPull(
  service: GithubService,
  caller: Caller,
  request: GetGithubPullRequest,
): Promise<GetGithubPullResponse> {
  service.authorize(caller, SCOPE_READ);
  const client = service.client();
  const ref = service.repository(request.repository);
  const now = service.now();
  const allowed = await mergeMethods(service, client, ref);
  try {
    const read = await api.pull(client, ref, request.number, allowed, now);
    const files = await api.pullFiles(
      client,
      ref,
      read.pull.number,
      MAX_FILES,
    );
    const reviews = await api.pullReviews(
      client,
      ref,
      read.pull.number,
      MAX_COMMENTS,
    );
    const reviewComments = await api.pullReviewComments(
      client,
      ref,
      read.pull.number,
      MAX_COMMENTS,
    );
    const comments = await api.issueComments(
      client,
      ref,
      read.pull.number,
      MAX_COMMENTS,
    );
    const result = create(GetGithubPullResponseSchema, {
      pull: read.pull,
      files,
      reviews,
      reviewComments,
      comments,
      rateLimit: rateLimit(read.response.rate),
      pollIntervalMs: BigInt(POLL_INTERVAL_MS),
      references: referencesFor(
        service,
        caller.workspaceId,
        ref,
        GithubReferenceKind.PULL_REQUEST,
        read.pull.number,
      ),
    });
    if (read.pull.headSha !== "") {
      result.checks = await api.checks(client, ref, read.pull.headSha, now);
    }
    service.credentials.noteSuccess();
    return result;
  } catch (error) {
    throw service.translate(error);
  }
}

export async function getChecks(
  service: GithubService,
  caller: Caller,
  request: GetGithubChecksRequest,
): Promise<GithubCheckSummary> {
  service.authorize(caller, SCOPE_READ);
  const client = service.client();
  const ref = service.repository(request.repository);
  const now = service.now();
  let read;
  try {
    read = await api.pull(client, ref, request.number, [], now);
    service.credentials.noteSuccess();
  } catch (error) {
    throw service.translate(error);
  }
  if (read.pull.headSha === "") throw githubError("notFound");
  try {
    return await api.checks(client, ref, read.pull.headSha, now);
  } catch (error) {
    throw service.translate(error);
  }
}

/**
 * 一次请求可以指名的分支名。它刻意比 git 自己更严：这里没有任何东西需要一个带着
 * 控制字符或者通配符的 ref。
 */
export function validRef(value: string): boolean {
  if (value === "" || value.length > 255) return false;
  if (value.startsWith("-") || value.includes("..")) return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return false;
    if ("~^:?*[\\".includes(character)) return false;
  }
  return true;
}

/**
 * 在要一个 PR 之前先确认 head 分支在远端存在，这样一个从没被推上去的分支得到的是
 * 一个清楚的答案，而不是远端一句含糊的拒绝。
 */
export async function createPull(
  service: GithubService,
  caller: Caller,
  request: CreateGithubPullRequest,
): Promise<GithubPullRequest> {
  service.authorize(caller, SCOPE_WRITE);
  const client = service.client();
  const ref = service.repository(request.repository);
  const base = request.baseRef;
  const head = request.headRef;
  if (!validRef(base) || !validRef(head) || base === head) {
    throw githubError("invalid");
  }
  if (
    request.title === "" ||
    Buffer.byteLength(request.title, "utf8") > 256 ||
    Buffer.byteLength(request.body, "utf8") > 65536
  ) {
    throw githubError("invalid");
  }
  let remoteHead: string;
  try {
    remoteHead = await api.refSha(client, ref, head);
  } catch (error) {
    if (codeOf(error) === "NOT_FOUND") throw githubError("notFound");
    throw service.translate(error);
  }
  // 调用方传的是它认为已经推上去的那个 head；从那以后动过的分支会为错误的提交开
  // 一个 PR。
  if (request.expectedHeadSha !== "" && request.expectedHeadSha !== remoteHead) {
    throw githubError("conflict");
  }
  const body: Record<string, unknown> = {
    title: request.title,
    base,
    head,
  };
  let text = request.body;
  if (request.linkedIssueNumber > 0n) {
    // 这条连接被写成远端自己看得懂的文本，同时也在下面被本地记成一条连接。
    if (text !== "") text += "\n\n";
    text += `Closes #${request.linkedIssueNumber}`;
  }
  if (text !== "") body.body = text;
  if (request.draft) body.draft = true;
  const allowed = await mergeMethods(service, client, ref);
  try {
    const pull = await api.createPull(
      client,
      ref,
      body,
      allowed,
      service.now(),
    );
    service.credentials.noteSuccess();
    return pull;
  } catch (error) {
    throw service.translate(error);
  }
}

/**
 * 发一条锚在评审者读过的那个提交上的评审。行内评论带着那个提交，所以一份过时的
 * 草稿是可以认出来的，而不是被悄悄挂到一条它已经不再描述的行上。
 */
export async function submitReview(
  service: GithubService,
  caller: Caller,
  request: SubmitGithubReviewRequest,
): Promise<GithubReview> {
  service.authorize(caller, SCOPE_WRITE);
  const client = service.client();
  const ref = service.repository(request.repository);
  let event: string;
  switch (request.state) {
    case GithubReviewState.APPROVED:
      event = "APPROVE";
      break;
    case GithubReviewState.CHANGES_REQUESTED:
      event = "REQUEST_CHANGES";
      break;
    case GithubReviewState.COMMENTED:
      event = "COMMENT";
      break;
    default:
      throw githubError("invalid");
  }
  if (event === "REQUEST_CHANGES" && request.body.trim() === "") {
    throw githubError("invalid");
  }
  if (
    Buffer.byteLength(request.body, "utf8") > 65536 ||
    request.comments.length > 200
  ) {
    throw githubError("invalid");
  }
  const body: Record<string, unknown> = { event };
  if (request.commitSha !== "") body.commit_id = request.commitSha;
  if (request.body !== "") body.body = request.body;
  const comments: Record<string, unknown>[] = [];
  for (const draft of request.comments) {
    if (
      draft.path === "" ||
      draft.path.length > 4096 ||
      draft.line <= 0n ||
      draft.body.trim() === ""
    ) {
      throw githubError("invalid");
    }
    if (draft.side !== "LEFT" && draft.side !== "RIGHT") {
      throw githubError("invalid");
    }
    comments.push({
      path: draft.path,
      line: Number(draft.line),
      side: draft.side,
      body: draft.body,
    });
  }
  if (comments.length > 0) body.comments = comments;
  try {
    const review = await api.createReview(client, ref, request.number, body);
    service.credentials.noteSuccess();
    return review;
  } catch (error) {
    throw service.translate(error);
  }
}

/**
 * 除非远端仍然持有调用方说它显示过的那个 head 和那个检查汇总，否则拒绝。本地一屏
 * 绿灯不是远端仍会接受这次合并的承诺，所以这里全部重新读一遍，而不是信它。
 */
export async function mergePull(
  service: GithubService,
  caller: Caller,
  request: MergeGithubPullRequest,
): Promise<MergeGithubPullResponse> {
  service.authorize(caller, SCOPE_WRITE);
  const client = service.client();
  const ref = service.repository(request.repository);
  const method = mergeMethodName(request.method);
  if (request.expectedHeadSha === "") throw githubError("invalid");
  const now = service.now();
  const allowed = await mergeMethods(service, client, ref);
  let pull: GithubPullRequest;
  try {
    pull = (await api.pull(client, ref, request.number, allowed, now)).pull;
    service.credentials.noteSuccess();
  } catch (error) {
    throw service.translate(error);
  }
  const refuse = (
    reason: string,
    checks: GithubCheckSummary | undefined,
  ): MergeGithubPullResponse =>
    create(MergeGithubPullResponseSchema, {
      merged: false,
      reasonCode: reason,
      pull,
      ...(checks === undefined ? {} : { checks }),
    });

  if (pull.headSha !== request.expectedHeadSha) {
    return refuse("HEAD_MOVED", undefined);
  }
  if (allowed.length > 0 && !allowed.includes(request.method)) {
    return refuse("METHOD_NOT_ALLOWED", undefined);
  }
  let checks: GithubCheckSummary | undefined;
  if (request.expectedCheckRollup !== GithubCheckConclusion.UNSPECIFIED) {
    try {
      checks = await api.checks(client, ref, pull.headSha, now);
    } catch (error) {
      throw service.translate(error);
    }
    if (checks.rollup !== request.expectedCheckRollup) {
      return refuse("CHECKS_CHANGED", checks);
    }
  }
  if (pull.mergeable === GithubMergeableState.CONFLICTING) {
    return refuse("NOT_MERGEABLE", checks);
  }
  if (pull.mergeable === GithubMergeableState.BLOCKED) {
    // 保护规则和合并队列是远端的决定；core 如实报告被告知的事，而不是硬试一次。
    return refuse("BLOCKED", checks);
  }

  let sha: string;
  try {
    sha = await api.merge(
      client,
      ref,
      pull.number,
      pull.headSha,
      method,
      request.commitTitle,
      request.commitMessage,
    );
  } catch (error) {
    const translated = service.translate(error);
    if (isGithubError(translated, "unknownOutcome")) {
      // 合并可能已经被接受。重新读是唯一诚实的答案；重试会冒出第二个合并提交。
      const latest = await readPull(service, client, ref, pull.number, allowed);
      if (latest !== undefined) {
        pull = latest;
        if (latest.state === GithubPullState.MERGED) {
          return create(MergeGithubPullResponseSchema, {
            merged: true,
            mergeSha: latest.headSha,
            pull: latest,
            ...(checks === undefined ? {} : { checks }),
          });
        }
      }
      return refuse("UNKNOWN_OUTCOME", checks);
    }
    if (
      isGithubError(translated, "conflict") ||
      isGithubError(translated, "invalid")
    ) {
      // 远端拒绝了。是哪一种拒绝由证据决定：head 仍然对得上，意味着被拒的是合并
      // 本身，而不是分支在读者眼皮底下动了。
      const latest = await readPull(service, client, ref, pull.number, allowed);
      if (latest !== undefined) {
        pull = latest;
        if (latest.headSha !== request.expectedHeadSha) {
          return refuse("HEAD_MOVED", checks);
        }
      }
      return refuse("NOT_MERGEABLE", checks);
    }
    if (isGithubError(translated, "permission")) {
      return refuse("BLOCKED", checks);
    }
    throw translated;
  }
  const latest = await readPull(service, client, ref, pull.number, allowed);
  if (latest !== undefined) pull = latest;
  return create(MergeGithubPullResponseSchema, {
    merged: true,
    mergeSha: sha,
    pull,
    ...(checks === undefined ? {} : { checks }),
  });
}

async function readPull(
  service: GithubService,
  client: GithubClient,
  ref: GithubRepositoryRef,
  number: bigint,
  allowed: readonly GithubMergeMethod[],
): Promise<GithubPullRequest | undefined> {
  try {
    return (await api.pull(client, ref, number, allowed, service.now())).pull;
  } catch {
    return undefined;
  }
}

export function mergeMethodName(method: GithubMergeMethod): string {
  switch (method) {
    case GithubMergeMethod.MERGE:
      return "merge";
    case GithubMergeMethod.SQUASH:
      return "squash";
    case GithubMergeMethod.REBASE:
      return "rebase";
    default:
      throw githubError("invalid");
  }
}
