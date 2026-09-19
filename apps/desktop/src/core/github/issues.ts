/**
 * Issue 的那些动词。移植自 `apps/host/internal/githubhost/issues.go`。
 */

import {
  GithubIssueState,
  GithubIssueStateReason,
  GithubReferenceKind,
  GithubStatusSource,
  GithubWriteState,
  ListGithubIssuesResponseSchema,
  GetGithubIssueResponseSchema,
  MoveGithubIssueResponseSchema,
  ResolveGithubRepositoryResponseSchema,
  GithubWriteOutcomeSchema,
  create,
  type CommentGithubIssueRequest,
  type CreateGithubIssueRequest,
  type GetGithubIssueRequest,
  type GetGithubIssueResponse,
  type GithubComment,
  type GithubIssue,
  type GithubRepositoryRef,
  type GithubStatusGroup,
  type GithubStatusMapping,
  type GithubWriteOutcome,
  type ListGithubIssuesRequest,
  type ListGithubIssuesResponse,
  type MoveGithubIssueRequest,
  type MoveGithubIssueResponse,
  type ResolveGithubRepositoryResponse,
  type SetGithubIssueStateRequest,
  type UpdateGithubIssueRequest,
} from "@armadra/protocol";

import type { GithubClient } from "./client";
import * as api from "./endpoints";
import { codeOf, githubError, isGithubError } from "./errors";
import { applyLabelGroups, applyProjectGroups, findGroup } from "./mapping";
import { belongsTo, parseRemote, webHostFor } from "./remote";
import { referencesFor } from "./references";
import {
  MAX_COMMENTS,
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
 * 在本地解析一个 git remote，**然后**才去问配置好的服务。属于另一个主机的 remote
 * 被报成不匹配而且不发任何请求，这就是企业版仓库不会被拿到公有服务上查的实现。
 */
export async function resolveRepository(
  service: GithubService,
  caller: Caller,
  remoteUrl: string,
): Promise<ResolveGithubRepositoryResponse> {
  service.authorize(caller, SCOPE_READ);
  const client = service.client();
  let parsed;
  try {
    parsed = parseRemote(remoteUrl);
  } catch {
    return create(ResolveGithubRepositoryResponseSchema, {
      reasonCode: "REMOTE_INVALID",
    });
  }
  const base = client.apiBase();
  if (!belongsTo(base, parsed.webHost)) {
    // 响应里刻意没有仓库：报一个出来就意味着 core 已经拿它去问过某个服务了。
    return create(ResolveGithubRepositoryResponseSchema, {
      hostMismatch: true,
      reasonCode: "REMOTE_HOST_NOT_CONFIGURED",
    });
  }
  const ref = service.repository({
    $typeName: "armadra.v1.GithubRepositoryRef",
    owner: parsed.owner,
    name: parsed.name,
    apiBase: base,
    host: webHostFor(base),
  });
  try {
    const result = await api.repository(client, ref, service.now());
    service.credentials.noteSuccess();
    return create(ResolveGithubRepositoryResponseSchema, {
      repository: result.repository,
      rateLimit: rateLimit(result.response.rate),
    });
  } catch (error) {
    throw service.translate(error);
  }
}

/**
 * 标注这一页 Issue 的分组。project 那一支要一次额外的 GraphQL 读，所以只有在配置
 * 确实是 project 字段时才发生。
 */
async function annotate(
  service: GithubService,
  client: GithubClient,
  mapping: GithubStatusMapping,
  issues: readonly GithubIssue[],
): Promise<void> {
  applyLabelGroups(mapping, issues);
  if (
    mapping.source !== GithubStatusSource.PROJECT_FIELD ||
    issues.length === 0
  ) {
    return;
  }
  try {
    const options = await api.projectStatuses(
      client,
      mapping.projectId,
      mapping.projectFieldId,
    );
    applyProjectGroups(mapping, issues, options);
  } catch (error) {
    throw service.translate(error);
  }
}

/**
 * 返回一页 Issue，已经标好了各自落在哪个状态分组里。PR 在传输层就被滤掉，所以这
 * 张列表永远不会把两者混在一起。
 */
export async function listIssues(
  service: GithubService,
  caller: Caller,
  request: ListGithubIssuesRequest,
): Promise<ListGithubIssuesResponse> {
  service.authorize(caller, SCOPE_READ);
  const client = service.client();
  const ref = service.repository(request.repository);
  const page = decodeCursor(request.afterCursor);
  const limit = pageLimit(Number(request.limit));
  const now = service.now();
  let result;
  try {
    result = await api.issues(client, ref, request.filter, page, limit, now);
    service.credentials.noteSuccess();
  } catch (error) {
    throw service.translate(error);
  }
  const mapping = service.storedMapping(caller.workspaceId, ref);
  await annotate(service, client, mapping, result.issues);
  return create(ListGithubIssuesResponseSchema, {
    issues: result.issues,
    nextCursor: encodeCursor(result.response.nextPage),
    hasMore: result.response.nextPage >= 2,
    rateLimit: rateLimit(result.response.rate),
    fromCache: result.response.fromCache,
    observedAtUnixMs: BigInt(now),
    pollIntervalMs: BigInt(POLL_INTERVAL_MS),
  });
}

/** 读一条 Issue，连同它的评论和指着它的本地连接。 */
export async function getIssue(
  service: GithubService,
  caller: Caller,
  request: GetGithubIssueRequest,
): Promise<GetGithubIssueResponse> {
  service.authorize(caller, SCOPE_READ);
  const client = service.client();
  const ref = service.repository(request.repository);
  const now = service.now();
  let read;
  let comments: GithubComment[];
  try {
    read = await api.issue(client, ref, request.number, now);
    comments = await api.issueComments(
      client,
      ref,
      read.issue.number,
      MAX_COMMENTS,
    );
    service.credentials.noteSuccess();
  } catch (error) {
    throw service.translate(error);
  }
  const mapping = service.storedMapping(caller.workspaceId, ref);
  await annotate(service, client, mapping, [read.issue]);
  return create(GetGithubIssueResponseSchema, {
    issue: read.issue,
    comments,
    references: referencesFor(
      service,
      caller.workspaceId,
      ref,
      GithubReferenceKind.ISSUE,
      read.issue.number,
    ),
    rateLimit: rateLimit(read.response.rate),
    pollIntervalMs: BigInt(POLL_INTERVAL_MS),
  });
}

export async function createIssue(
  service: GithubService,
  caller: Caller,
  request: CreateGithubIssueRequest,
): Promise<GithubIssue> {
  service.authorize(caller, SCOPE_WRITE);
  const client = service.client();
  const ref = service.repository(request.repository);
  if (
    request.title === "" ||
    Buffer.byteLength(request.title, "utf8") > 256 ||
    Buffer.byteLength(request.body, "utf8") > 65536
  ) {
    throw githubError("invalid");
  }
  const body: Record<string, unknown> = { title: request.title };
  if (request.body !== "") body.body = request.body;
  if (request.labels.length > 0) body.labels = [...request.labels];
  if (request.assignees.length > 0) body.assignees = [...request.assignees];
  if (request.milestoneNumber > 0n) {
    body.milestone = Number(request.milestoneNumber);
  }
  try {
    const issue = await api.createIssue(client, ref, body, service.now());
    service.credentials.noteSuccess();
    return issue;
  } catch (error) {
    throw service.translate(error);
  }
}

/**
 * 取回 Issue 并在远端自调用方上次显示以来动过时拒绝。GitHub 没有原子的版本锁，
 * 所以这是一次**写前读**检查而不是保证——调用方被明确地告知这一点。
 */
async function reread(
  service: GithubService,
  client: GithubClient,
  ref: GithubRepositoryRef,
  number: bigint,
  expectedUpdatedAtMs: bigint,
): Promise<{ issue: GithubIssue; nodeId: string; conflict: boolean }> {
  if (expectedUpdatedAtMs <= 0n) throw githubError("invalid");
  let read;
  try {
    read = await api.issue(client, ref, number, service.now());
    service.credentials.noteSuccess();
  } catch (error) {
    throw service.translate(error);
  }
  return {
    issue: read.issue,
    nodeId: read.nodeId,
    conflict: read.issue.updatedAtUnixMs !== expectedUpdatedAtMs,
  };
}

/**
 * 只写这次补丁真的带上的字段。标签和指派人只有在请求这么说时才被替换，所以一次
 * 编辑永远不会丢掉别的工具加上去的东西。
 */
export async function updateIssue(
  service: GithubService,
  caller: Caller,
  request: UpdateGithubIssueRequest,
): Promise<GithubIssue> {
  service.authorize(caller, SCOPE_WRITE);
  const client = service.client();
  const ref = service.repository(request.repository);
  const patch = request.patch;
  if (patch === undefined) throw githubError("invalid");
  const read = await reread(
    service,
    client,
    ref,
    request.number,
    request.expectedUpdatedAtUnixMs,
  );
  if (read.conflict) throw githubError("conflict");
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    if (patch.title === "" || Buffer.byteLength(patch.title, "utf8") > 256) {
      throw githubError("invalid");
    }
    body.title = patch.title;
  }
  if (patch.body !== undefined) {
    if (Buffer.byteLength(patch.body, "utf8") > 65536) {
      throw githubError("invalid");
    }
    body.body = patch.body;
  }
  if (patch.replaceLabels) body.labels = [...patch.labels];
  if (patch.replaceAssignees) body.assignees = [...patch.assignees];
  if (patch.milestoneNumber !== undefined) {
    body.milestone =
      patch.milestoneNumber <= 0n ? null : Number(patch.milestoneNumber);
  }
  if (Object.keys(body).length === 0) throw githubError("invalid");
  let issue: GithubIssue;
  try {
    issue = await api.patchIssue(
      client,
      ref,
      request.number,
      body,
      service.now(),
    );
    service.credentials.noteSuccess();
  } catch (error) {
    throw service.translate(error);
  }
  applyLabelGroups(service.storedMapping(caller.workspaceId, ref), [issue]);
  return issue;
}

/**
 * 关闭或重开。它刻意和一次分组移动分开：只有显式配置过的耦合才让两者一起发生。
 */
export async function setIssueState(
  service: GithubService,
  caller: Caller,
  request: SetGithubIssueStateRequest,
): Promise<GithubIssue> {
  service.authorize(caller, SCOPE_WRITE);
  const client = service.client();
  const ref = service.repository(request.repository);
  const state = stateName(request.state);
  const read = await reread(
    service,
    client,
    ref,
    request.number,
    request.expectedUpdatedAtUnixMs,
  );
  if (read.conflict) throw githubError("conflict");
  const body: Record<string, unknown> = { state };
  const reason = stateReasonName(request.reason);
  if (reason !== "") body.state_reason = reason;
  let issue: GithubIssue;
  try {
    issue = await api.patchIssue(
      client,
      ref,
      request.number,
      body,
      service.now(),
    );
    service.credentials.noteSuccess();
  } catch (error) {
    throw service.translate(error);
  }
  applyLabelGroups(service.storedMapping(caller.workspaceId, ref), [issue]);
  return issue;
}

export function stateName(state: GithubIssueState): string {
  if (state === GithubIssueState.OPEN) return "open";
  if (state === GithubIssueState.CLOSED) return "closed";
  throw githubError("invalid");
}

function stateLabel(state: GithubIssueState): string {
  try {
    return stateName(state);
  } catch {
    return "";
  }
}

export function stateReasonName(reason: GithubIssueStateReason): string {
  switch (reason) {
    case GithubIssueStateReason.COMPLETED:
      return "completed";
    case GithubIssueStateReason.NOT_PLANNED:
      return "not_planned";
    case GithubIssueStateReason.REOPENED:
      return "reopened";
    case GithubIssueStateReason.DUPLICATE:
      return "duplicate";
    default:
      return "";
  }
}

export async function commentIssue(
  service: GithubService,
  caller: Caller,
  request: CommentGithubIssueRequest,
): Promise<GithubComment> {
  service.authorize(caller, SCOPE_WRITE);
  const client = service.client();
  const ref = service.repository(request.repository);
  if (
    request.body === "" ||
    Buffer.byteLength(request.body, "utf8") > 65536
  ) {
    throw githubError("invalid");
  }
  try {
    const comment = await api.createIssueComment(
      client,
      ref,
      request.number,
      request.body,
    );
    service.credentials.noteSuccess();
    return comment;
  } catch (error) {
    throw service.translate(error);
  }
}

/**
 * 在配置好的分组之间移动一条 Issue。
 *
 * 每一次写各自单独汇报，所以一个只部分生效的组合是**看得见、能修的**。标签移动
 * 只碰这份映射管着的标签；别的标签原样不动。只有在目标分组被显式配置为耦合到一个
 * 状态时才会顺带关闭 Issue。
 */
export async function moveIssue(
  service: GithubService,
  caller: Caller,
  request: MoveGithubIssueRequest,
): Promise<MoveGithubIssueResponse> {
  service.authorize(caller, SCOPE_WRITE);
  const client = service.client();
  const ref = service.repository(request.repository);
  const mapping = service.storedMapping(caller.workspaceId, ref);
  if (mapping.source === GithubStatusSource.NONE) throw githubError("invalid");
  // 用户当时看着的那份映射决定这次移动是什么意思，所以一份在面板底下被改掉的映射
  // 会停下这次移动，而不是把它重新解释一遍。
  if (request.expectedMappingRevision !== mapping.revision) {
    throw githubError("conflict");
  }
  const target = findGroup(mapping, request.toGroupId);
  if (target === undefined) throw githubError("invalid");

  const read = await reread(
    service,
    client,
    ref,
    request.number,
    request.expectedUpdatedAtUnixMs,
  );
  if (read.conflict) {
    return create(MoveGithubIssueResponseSchema, {
      issue: read.issue,
      outcomes: [
        create(GithubWriteOutcomeSchema, {
          actionId: "reread",
          target: "issue",
          state: GithubWriteState.CONFLICTED,
          reasonCode: "REMOTE_CHANGED",
        }),
      ],
    });
  }
  await annotate(service, client, mapping, [read.issue]);
  if (
    request.fromGroupId !== "" &&
    request.fromGroupId !== read.issue.statusGroupId
  ) {
    return create(MoveGithubIssueResponseSchema, {
      issue: read.issue,
      outcomes: [
        create(GithubWriteOutcomeSchema, {
          actionId: "from-group",
          target: "status_group",
          state: GithubWriteState.CONFLICTED,
          reasonCode: "GROUP_CHANGED",
          previousValue: read.issue.statusGroupId,
          requestedValue: request.toGroupId,
        }),
      ],
    });
  }

  const outcomes: GithubWriteOutcome[] = [];
  if (mapping.source === GithubStatusSource.LABEL) {
    outcomes.push(
      await moveLabels(service, client, ref, mapping, read.issue, target),
    );
  } else {
    outcomes.push(
      ...(await moveProjectField(
        service,
        client,
        mapping,
        read.issue,
        read.nodeId,
        target,
      )),
    );
  }
  if (
    target.couplesIssueState !== GithubIssueState.UNSPECIFIED &&
    target.couplesIssueState !== read.issue.state
  ) {
    outcomes.push(await moveState(service, client, ref, read.issue, target));
  }

  // 重新读一遍 Issue，这样答案描述的是远端现在持有的东西，而不是当初请求的东西。
  const rate = rateLimit(client.lastRateLimit());
  try {
    const updated = await api.issue(
      client,
      ref,
      read.issue.number,
      service.now(),
    );
    await annotate(service, client, mapping, [updated.issue]);
    return create(MoveGithubIssueResponseSchema, {
      issue: updated.issue,
      outcomes,
      rateLimit: rate,
    });
  } catch {
    // 上面那些写已经发生了；在这里拒绝会把它们藏起来。
    return create(MoveGithubIssueResponseSchema, {
      issue: read.issue,
      outcomes,
      rateLimit: rate,
    });
  }
}

async function moveLabels(
  service: GithubService,
  client: GithubClient,
  ref: GithubRepositoryRef,
  mapping: GithubStatusMapping,
  issue: GithubIssue,
  target: GithubStatusGroup,
): Promise<GithubWriteOutcome> {
  const managed = new Set(mapping.groups.map((entry) => entry.label));
  const labels = issue.labels
    .map((label) => label.name)
    .filter((name) => !managed.has(name));
  labels.push(target.label);
  const outcome = create(GithubWriteOutcomeSchema, {
    actionId: "labels",
    target: "labels",
    previousValue: issue.statusGroupId,
    requestedValue: target.id,
  });
  try {
    await api.patchIssue(
      client,
      ref,
      issue.number,
      { labels },
      service.now(),
    );
    outcome.state = GithubWriteState.APPLIED;
  } catch (error) {
    applyWriteFailure(outcome, service.translate(error));
  }
  return outcome;
}

/**
 * 成员关系和字段写分别汇报：一个已经建出来但字段写失败的 project item，和一个从没
 * 被加进去的，是两种不同的状态。
 */
async function moveProjectField(
  service: GithubService,
  client: GithubClient,
  mapping: GithubStatusMapping,
  issue: GithubIssue,
  nodeId: string,
  target: GithubStatusGroup,
): Promise<GithubWriteOutcome[]> {
  const membership = create(GithubWriteOutcomeSchema, {
    actionId: "project-item",
    target: "project_item",
    requestedValue: mapping.projectId,
  });
  if (nodeId === "") {
    membership.state = GithubWriteState.FAILED;
    membership.reasonCode = "ISSUE_NODE_UNKNOWN";
    return [membership];
  }
  let item;
  try {
    item = await api.projectItem(
      client,
      nodeId,
      mapping.projectId,
      mapping.projectFieldId,
    );
  } catch (error) {
    applyWriteFailure(membership, service.translate(error));
    return [membership];
  }
  let itemId = item.itemId;
  if (itemId === "") {
    try {
      itemId = await api.addProjectItem(client, mapping.projectId, nodeId);
      membership.state = GithubWriteState.APPLIED;
    } catch (error) {
      applyWriteFailure(membership, service.translate(error));
      return [membership];
    }
  } else {
    membership.state = GithubWriteState.SKIPPED;
    membership.reasonCode = "ALREADY_ON_PROJECT";
  }
  const field = create(GithubWriteOutcomeSchema, {
    actionId: "project-field",
    target: "project_field",
    previousValue: item.optionId,
    requestedValue: target.projectOptionId,
  });
  try {
    await api.setProjectField(
      client,
      mapping.projectId,
      itemId,
      mapping.projectFieldId,
      target.projectOptionId,
    );
    field.state = GithubWriteState.APPLIED;
  } catch (error) {
    applyWriteFailure(field, service.translate(error));
  }
  return [membership, field];
}

async function moveState(
  service: GithubService,
  client: GithubClient,
  ref: GithubRepositoryRef,
  issue: GithubIssue,
  target: GithubStatusGroup,
): Promise<GithubWriteOutcome> {
  const outcome = create(GithubWriteOutcomeSchema, {
    actionId: "issue-state",
    target: "issue_state",
    previousValue: stateLabel(issue.state),
    requestedValue: stateLabel(target.couplesIssueState),
  });
  let state: string;
  try {
    state = stateName(target.couplesIssueState);
  } catch {
    outcome.state = GithubWriteState.FAILED;
    outcome.reasonCode = "STATE_INVALID";
    return outcome;
  }
  try {
    await api.patchIssue(client, ref, issue.number, { state }, service.now());
    outcome.state = GithubWriteState.APPLIED;
  } catch (error) {
    applyWriteFailure(outcome, service.translate(error));
  }
  return outcome;
}

/**
 * 一次没读到结果的写留在 pending，而不是被称作失败。「pending」才是让调用方重新
 * 读、而不是重试的那个说法。
 */
export function applyWriteFailure(
  outcome: GithubWriteOutcome,
  error: unknown,
): void {
  if (isGithubError(error, "unknownOutcome")) {
    outcome.state = GithubWriteState.PENDING;
    outcome.reasonCode = "UNKNOWN_OUTCOME";
    return;
  }
  if (isGithubError(error, "conflict")) {
    outcome.state = GithubWriteState.CONFLICTED;
    outcome.reasonCode = "REMOTE_CHANGED";
    return;
  }
  outcome.state = GithubWriteState.FAILED;
  if (isGithubError(error, "rateLimited")) {
    outcome.reasonCode = "RATE_LIMITED";
    return;
  }
  if (isGithubError(error, "permission")) {
    outcome.reasonCode = "FORBIDDEN";
    return;
  }
  if (isGithubError(error, "notFound")) {
    outcome.reasonCode = "NOT_FOUND";
    return;
  }
  outcome.reasonCode = "WRITE_FAILED";
}

/** 传输层的原因码，给 `cleanup.ts` 判断一次重跑为什么没发出去。 */
export { codeOf };
